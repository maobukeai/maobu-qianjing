//! Secure Win32 multi-window input synchronizer with differentiated text injection and emergency stop.
//!
//! Security boundaries:
//! - Only syncs verified browser windows resolved through `win32_window_registry` (never raw
//!   frontend PIDs/HWNDs, never the desktop control window, never system windows).
//! - Strict foreground gate: input is captured only while `GetForegroundWindow() == master.hwnd`.
//! - Re-verifies every target slave HWND (`IsWindow` + PID tree + class whitelist) immediately
//!   before every `PostMessageW` dispatch; stale slaves are pruned automatically.
//! - Zero loopback: uses targeted `PostMessageW` exclusively (never `SendInput`), and never steals
//!   foreground focus from master.
//! - Multi-layer emergency stop: global `RegisterHotKey(Ctrl+Shift+F12)` + passive hook detection
//!   of `Ctrl+Shift+Esc` and double-tap `Esc` + master window destruction (`EVENT_OBJECT_DESTROY`)
//!   + `Drop` + `RunEvent::Exit`.
//! - Differentiated text injection uses pure `WM_CHAR` UTF-16 delivery and never touches the
//!   system clipboard or reads secret credentials/passwords/2FA.

use crate::credentials::CredentialOrigin;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, WebviewWindow};

pub const SYNC_STATE_EVENT: &str = "maobu-sync-state";
pub const EMERGENCY_HOTKEY_LABEL: &str = "Ctrl+Shift+F12";

const DEFAULT_JITTER_MIN_MS: u64 = 15;
const DEFAULT_JITTER_MAX_MS: u64 = 85;
const MAX_JITTER_MIN_MS: u64 = 500;
const MAX_JITTER_MAX_MS: u64 = 1000;
const MAX_CLICK_POS_JITTER_PX: i32 = 4;
const DOUBLE_ESC_WINDOW_MS: u64 = 400;
const DEFAULT_CHAR_DELAY_MIN_MS: u64 = 20;
const DEFAULT_CHAR_DELAY_MAX_MS: u64 = 60;
const MAX_CHAR_DELAY_MIN_MS: u64 = 300;
const MAX_CHAR_DELAY_MAX_MS: u64 = 500;
const MAX_INJECT_TEXT_CHARS: usize = 4096;
const MAX_INJECT_TARGETS: usize = 200;

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStartConfig {
    pub master_profile_id: String,
    #[serde(default)]
    pub slave_profile_ids: Vec<String>,
    #[serde(default, alias = "syncMouse")]
    pub sync_mouse_click: Option<bool>,
    #[serde(default)]
    pub sync_mouse_move: Option<bool>,
    #[serde(default)]
    pub sync_scroll: Option<bool>,
    #[serde(default)]
    pub sync_keyboard: Option<bool>,
    #[serde(default)]
    pub jitter_min_ms: Option<u64>,
    #[serde(default)]
    pub jitter_max_ms: Option<u64>,
    #[serde(default)]
    pub click_pos_jitter_px: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NormalizedSyncConfig {
    pub master_profile_id: String,
    pub slave_profile_ids: Vec<String>,
    pub sync_mouse_click: bool,
    pub sync_mouse_move: bool,
    pub sync_scroll: bool,
    pub sync_keyboard: bool,
    pub jitter_min_ms: u64,
    pub jitter_max_ms: u64,
    pub click_pos_jitter_px: i32,
}

pub(crate) fn validate_sync_config(
    config: &SyncStartConfig,
) -> Result<NormalizedSyncConfig, String> {
    let master = config.master_profile_id.trim();
    if master.is_empty() {
        return Err("masterProfileId is required to start window synchronization".to_owned());
    }
    let mut seen = HashSet::new();
    let mut slaves = Vec::new();
    for raw in &config.slave_profile_ids {
        let id = raw.trim();
        if id.is_empty() {
            continue;
        }
        if id == master {
            return Err("slaveProfileIds cannot contain masterProfileId".to_owned());
        }
        if seen.insert(id.to_owned()) {
            slaves.push(id.to_owned());
        }
    }
    if slaves.is_empty() {
        return Err("at least one verified slave profile is required".to_owned());
    }
    let jitter_min_ms = config.jitter_min_ms.unwrap_or(DEFAULT_JITTER_MIN_MS);
    let jitter_max_ms = config.jitter_max_ms.unwrap_or(DEFAULT_JITTER_MAX_MS);
    if jitter_min_ms > MAX_JITTER_MIN_MS {
        return Err(format!("jitterMinMs must be <= {MAX_JITTER_MIN_MS}"));
    }
    if jitter_max_ms > MAX_JITTER_MAX_MS {
        return Err(format!("jitterMaxMs must be <= {MAX_JITTER_MAX_MS}"));
    }
    if jitter_min_ms > jitter_max_ms {
        return Err("jitterMinMs cannot exceed jitterMaxMs".to_owned());
    }
    let click_pos_jitter_px = config.click_pos_jitter_px.unwrap_or(0);
    if !(0..=MAX_CLICK_POS_JITTER_PX).contains(&click_pos_jitter_px) {
        return Err(format!(
            "clickPosJitterPx must be between 0 and {MAX_CLICK_POS_JITTER_PX}"
        ));
    }
    Ok(NormalizedSyncConfig {
        master_profile_id: master.to_owned(),
        slave_profile_ids: slaves,
        sync_mouse_click: config.sync_mouse_click.unwrap_or(true),
        sync_mouse_move: config.sync_mouse_move.unwrap_or(false),
        sync_scroll: config.sync_scroll.unwrap_or(true),
        sync_keyboard: config.sync_keyboard.unwrap_or(true),
        jitter_min_ms,
        jitter_max_ms,
        click_pos_jitter_px,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusSnapshot {
    pub supported: bool,
    pub active: bool,
    pub paused: bool,
    pub paused_by_user: bool,
    pub paused_by_focus: bool,
    pub master_profile_id: Option<String>,
    pub slave_profile_ids: Vec<String>,
    pub dropped_slave_profile_ids: Vec<String>,
    pub sync_mouse_click: bool,
    pub sync_mouse_move: bool,
    pub sync_scroll: bool,
    pub sync_keyboard: bool,
    pub jitter_min_ms: u64,
    pub jitter_max_ms: u64,
    pub click_pos_jitter_px: i32,
    pub emergency_hotkey: String,
    pub active_injection_jobs: usize,
    pub forwarded_events: u64,
    pub last_stop_reason: Option<String>,
    pub updated_at_ms: u64,
}

impl SyncStatusSnapshot {
    pub fn idle(last_stop_reason: Option<String>, active_injection_jobs: usize) -> Self {
        Self {
            supported: cfg!(windows),
            active: false,
            paused: false,
            paused_by_user: false,
            paused_by_focus: false,
            master_profile_id: None,
            slave_profile_ids: Vec::new(),
            dropped_slave_profile_ids: Vec::new(),
            sync_mouse_click: true,
            sync_mouse_move: false,
            sync_scroll: true,
            sync_keyboard: true,
            jitter_min_ms: DEFAULT_JITTER_MIN_MS,
            jitter_max_ms: DEFAULT_JITTER_MAX_MS,
            click_pos_jitter_px: 0,
            emergency_hotkey: EMERGENCY_HOTKEY_LABEL.to_owned(),
            active_injection_jobs,
            forwarded_events: 0,
            last_stop_reason,
            updated_at_ms: now_epoch_ms(),
        }
    }

    #[cfg(not(windows))]
    pub fn unsupported() -> Self {
        let mut snap = Self::idle(Some("unsupported_platform".to_owned()), 0);
        snap.supported = false;
        snap
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextInjectMode {
    PerLineOrdered,
    PerProfileMap,
    Template,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInjectRequest {
    pub mode: TextInjectMode,
    #[serde(default, alias = "profileIds")]
    pub target_profile_ids: Vec<String>,
    #[serde(default)]
    pub include_master: Option<bool>,
    #[serde(default)]
    pub lines: Vec<String>,
    #[serde(default, alias = "perProfile", alias = "textsByProfile")]
    pub profile_texts: HashMap<String, String>,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub char_delay_min_ms: Option<u64>,
    #[serde(default)]
    pub char_delay_max_ms: Option<u64>,
    #[serde(default, alias = "appendEnter", alias = "sendEnter")]
    pub press_enter: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextInjectResult {
    pub ok: bool,
    pub job_id: String,
    pub queued_profiles: Vec<String>,
    pub skipped_profiles: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TextTargetDescriptor {
    pub profile_id: String,
    pub name: String,
    pub custom_no: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct DoubleEscDetector {
    last_esc_ms: Option<u64>,
}

impl DoubleEscDetector {
    pub fn record_escape(&mut self, now_ms: u64) -> bool {
        if let Some(prev) = self.last_esc_ms {
            if now_ms >= prev && now_ms.saturating_sub(prev) <= DOUBLE_ESC_WINDOW_MS {
                self.last_esc_ms = None;
                return true;
            }
        }
        self.last_esc_ms = Some(now_ms);
        false
    }
}

/// Filters dangerous OS/window-management shortcuts so they are never forwarded to slaves.
pub(crate) fn should_block_forwarded_key(
    vk: u32,
    alt_down: bool,
    ctrl_down: bool,
    shift_down: bool,
    win_down: bool,
) -> bool {
    const VK_TAB_CODE: u32 = 0x09;
    const VK_ESCAPE_CODE: u32 = 0x1B;
    const VK_SPACE_CODE: u32 = 0x20;
    const VK_SNAPSHOT_CODE: u32 = 0x2C;
    const VK_DELETE_CODE: u32 = 0x2E;
    const VK_LWIN_CODE: u32 = 0x5B;
    const VK_RWIN_CODE: u32 = 0x5C;
    const VK_SLEEP_CODE: u32 = 0x5F;
    const VK_F4_CODE: u32 = 0x73;
    const VK_F12_CODE: u32 = 0x7B;

    if win_down || vk == VK_LWIN_CODE || vk == VK_RWIN_CODE {
        return true;
    }
    if matches!(vk, VK_SNAPSHOT_CODE | VK_SLEEP_CODE) {
        return true;
    }
    if alt_down
        && matches!(
            vk,
            VK_TAB_CODE | VK_F4_CODE | VK_ESCAPE_CODE | VK_SPACE_CODE
        )
    {
        return true;
    }
    if ctrl_down && alt_down && vk == VK_DELETE_CODE {
        return true;
    }
    if ctrl_down && shift_down && matches!(vk, VK_ESCAPE_CODE | VK_F12_CODE) {
        return true;
    }
    false
}

/// Normalizes a master client-area coordinate into `[0.0, 1.0]`, rejecting titlebar/outside points.
pub(crate) fn normalize_client_point(
    client_x: i32,
    client_y: i32,
    client_w: i32,
    client_h: i32,
) -> Option<(f64, f64)> {
    if client_w <= 0 || client_h <= 0 {
        return None;
    }
    if client_x < 0 || client_y < 0 || client_x >= client_w || client_y >= client_h {
        return None;
    }
    let rel_x = if client_w <= 1 {
        0.0
    } else {
        (client_x as f64) / ((client_w - 1) as f64)
    };
    let rel_y = if client_h <= 1 {
        0.0
    } else {
        (client_y as f64) / ((client_h - 1) as f64)
    };
    Some((rel_x.clamp(0.0, 1.0), rel_y.clamp(0.0, 1.0)))
}

/// Maps normalized `[0.0, 1.0]` coordinates onto a slave's client rect with bounded micro-jitter.
pub(crate) fn map_relative_point(
    rel_x: f64,
    rel_y: f64,
    target_w: i32,
    target_h: i32,
    jitter_px: i32,
    dx: i32,
    dy: i32,
) -> Option<(i32, i32)> {
    if target_w <= 0 || target_h <= 0 || !rel_x.is_finite() || !rel_y.is_finite() {
        return None;
    }
    let bound = jitter_px.clamp(0, MAX_CLICK_POS_JITTER_PX);
    let safe_dx = dx.clamp(-bound, bound);
    let safe_dy = dy.clamp(-bound, bound);
    let max_x = target_w - 1;
    let max_y = target_h - 1;
    let base_x = (rel_x.clamp(0.0, 1.0) * (max_x as f64)).round() as i32;
    let base_y = (rel_y.clamp(0.0, 1.0) * (max_y as f64)).round() as i32;
    Some((
        base_x.saturating_add(safe_dx).clamp(0, max_x),
        base_y.saturating_add(safe_dy).clamp(0, max_y),
    ))
}

pub(crate) fn make_xy_lparam(x: i32, y: i32) -> isize {
    let low = (x as i16 as u16) as usize;
    let high = ((y as i16 as u16) as usize) << 16;
    (high | low) as isize
}

pub(crate) fn make_key_lparam(
    scan_code: u32,
    extended: bool,
    is_up: bool,
    is_alt_down: bool,
) -> isize {
    let mut value: u32 = 1; // repeat count
    value |= (scan_code & 0xFF) << 16;
    if extended {
        value |= 1 << 24;
    }
    if is_alt_down {
        value |= 1 << 29;
    }
    if is_up {
        value |= (1 << 30) | (1 << 31);
    }
    value as usize as isize
}

fn is_forbidden_template_token(token: &str) -> bool {
    let lower = token.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "password"
            | "passwd"
            | "pass"
            | "twofa"
            | "2fa"
            | "totp"
            | "otp"
            | "cookie"
            | "cookies"
            | "secret"
            | "token"
            | "auth"
            | "emailpassword"
            | "apikey"
            | "api_key"
            | "proxy"
            | "proxypass"
            | "key"
    ) || lower.contains("password")
        || lower.contains("secret")
        || lower.contains("twofa")
        || lower.contains("cookie")
        || lower.contains("token")
}

/// Renders safe differentiated text templates (`{{index}}`, `{{name}}`, `{{customNo}}`).
/// Explicitly rejects sensitive credential placeholders and bounds rendered text length.
pub(crate) fn render_safe_template(
    raw: &str,
    index_one_based: usize,
    name: &str,
    custom_no: &str,
) -> Result<String, String> {
    let mut out = String::with_capacity(raw.len());
    let mut cursor = 0usize;
    while let Some(rel_start) = raw[cursor..].find("{{") {
        let start = cursor + rel_start;
        out.push_str(&raw[cursor..start]);
        let after_open = start + 2;
        if let Some(rel_end) = raw[after_open..].find("}}") {
            let end = after_open + rel_end;
            let token = raw[after_open..end].trim();
            if is_forbidden_template_token(token) {
                return Err(
                    "template cannot reference sensitive credentials, passwords, 2FA, or cookies"
                        .to_owned(),
                );
            }
            match token {
                "index" => out.push_str(&index_one_based.to_string()),
                "name" => out.push_str(name),
                "customNo" => out.push_str(custom_no),
                _ => out.push_str(&raw[start..end + 2]),
            }
            cursor = end + 2;
        } else {
            out.push_str(&raw[start..]);
            cursor = raw.len();
            break;
        }
    }
    if cursor < raw.len() {
        out.push_str(&raw[cursor..]);
    }
    if out.chars().count() > MAX_INJECT_TEXT_CHARS {
        return Err(format!(
            "rendered text exceeds {MAX_INJECT_TEXT_CHARS} character safety limit"
        ));
    }
    Ok(out)
}

pub(crate) fn validate_text_inject_delays(req: &TextInjectRequest) -> Result<(u64, u64), String> {
    let min_ms = req.char_delay_min_ms.unwrap_or(DEFAULT_CHAR_DELAY_MIN_MS);
    let max_ms = req.char_delay_max_ms.unwrap_or(DEFAULT_CHAR_DELAY_MAX_MS);
    if min_ms > MAX_CHAR_DELAY_MIN_MS {
        return Err(format!("charDelayMinMs must be <= {MAX_CHAR_DELAY_MIN_MS}"));
    }
    if max_ms > MAX_CHAR_DELAY_MAX_MS {
        return Err(format!("charDelayMaxMs must be <= {MAX_CHAR_DELAY_MAX_MS}"));
    }
    if min_ms > max_ms {
        return Err("charDelayMinMs cannot exceed charDelayMaxMs".to_owned());
    }
    Ok((min_ms, max_ms))
}

pub(crate) fn plan_text_injections(
    req: &TextInjectRequest,
    targets: &[TextTargetDescriptor],
) -> Result<Vec<(String, String)>, String> {
    let _ = validate_text_inject_delays(req)?;
    if targets.is_empty() {
        return Err("no verified target windows are available for text injection".to_owned());
    }
    if targets.len() > MAX_INJECT_TARGETS {
        return Err(format!(
            "text injection batch exceeds {MAX_INJECT_TARGETS} target limit"
        ));
    }

    let mut planned = Vec::new();
    match req.mode {
        TextInjectMode::PerLineOrdered => {
            if req.lines.is_empty() {
                return Err("per_line_ordered mode requires at least one line".to_owned());
            }
            for (idx, (target, line)) in targets.iter().zip(req.lines.iter()).enumerate() {
                if line.is_empty() {
                    continue;
                }
                let rendered =
                    render_safe_template(line, idx + 1, &target.name, &target.custom_no)?;
                planned.push((target.profile_id.clone(), rendered));
            }
        }
        TextInjectMode::PerProfileMap => {
            if req.profile_texts.is_empty() {
                return Err("per_profile_map mode requires profileTexts entries".to_owned());
            }
            for (idx, target) in targets.iter().enumerate() {
                if let Some(raw) = req.profile_texts.get(&target.profile_id) {
                    if raw.is_empty() {
                        continue;
                    }
                    let rendered =
                        render_safe_template(raw, idx + 1, &target.name, &target.custom_no)?;
                    planned.push((target.profile_id.clone(), rendered));
                }
            }
        }
        TextInjectMode::Template => {
            let template = req
                .template
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "template mode requires a non-empty template".to_owned())?;
            for (idx, target) in targets.iter().enumerate() {
                let rendered =
                    render_safe_template(template, idx + 1, &target.name, &target.custom_no)?;
                planned.push((target.profile_id.clone(), rendered));
            }
        }
    }

    if planned.is_empty() {
        return Err("no non-empty texts matched the selected target windows".to_owned());
    }
    Ok(planned)
}

#[cfg(windows)]
mod win32_engine {
    use super::{
        make_key_lparam, make_xy_lparam, map_relative_point, normalize_client_point, now_epoch_ms,
        should_block_forwarded_key, DoubleEscDetector, NormalizedSyncConfig, SyncStatusSnapshot,
        EMERGENCY_HOTKEY_LABEL,
    };
    use crate::win32_window_registry::{
        read_window_class, verify_child_belongs_to_pids, verify_live_window, VerifiedManagedWindow,
        CHROMIUM_WINDOW_CLASS,
    };
    use rand::Rng;
    use std::{
        collections::{HashMap, HashSet},
        ffi::c_void,
        sync::{
            atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
            mpsc::{self, SyncSender},
            Arc, Mutex, OnceLock, RwLock, Weak,
        },
        thread::{self, JoinHandle},
        time::Duration,
    };
    use windows::{
        core::BOOL,
        Win32::{
            Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
            Graphics::Gdi::{ClientToScreen, ScreenToClient},
            System::Threading::GetCurrentThreadId,
            UI::{
                Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
                Input::KeyboardAndMouse::{
                    GetAsyncKeyState, GetKeyboardLayout, RegisterHotKey, ToUnicodeEx,
                    UnregisterHotKey, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, VK_CAPITAL, VK_CONTROL,
                    VK_ESCAPE, VK_F12, VK_LWIN, VK_MENU, VK_RETURN, VK_RWIN, VK_SHIFT,
                },
                WindowsAndMessaging::{
                    CallNextHookEx, ChildWindowFromPointEx, DispatchMessageW, EnumChildWindows,
                    GetClientRect, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
                    PeekMessageW, PostMessageW, PostThreadMessageW, SetWindowsHookExW,
                    TranslateMessage, UnhookWindowsHookEx, CWP_SKIPDISABLED, CWP_SKIPINVISIBLE,
                    EVENT_OBJECT_DESTROY, EVENT_SYSTEM_FOREGROUND, HHOOK, KBDLLHOOKSTRUCT, MSG,
                    MSLLHOOKSTRUCT, OBJID_WINDOW, PM_NOREMOVE, WH_KEYBOARD_LL, WH_MOUSE_LL,
                    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_APP, WM_CHAR, WM_HOTKEY,
                    WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN,
                    WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_QUIT,
                    WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
                },
            },
        },
    };

    const HOOK_CHANNEL_CAPACITY: usize = 512;
    const SLAVE_CHANNEL_CAPACITY: usize = 256;
    const MOUSE_MOVE_THROTTLE_MS: u64 = 33;
    const HOTKEY_EMERGENCY_STOP_ID: i32 = 0x4D42;
    const WM_APP_EMERGENCY_STOP: u32 = WM_APP + 1;
    const WM_APP_FOCUS_CHANGED: u32 = WM_APP + 2;
    const WM_APP_SLAVE_DESTROYED: u32 = WM_APP + 3;

    const STOP_CODE_CTRL_SHIFT_ESC: usize = 1;
    const STOP_CODE_DOUBLE_ESC: usize = 2;
    const STOP_CODE_MASTER_CLOSED: usize = 3;

    const LLMHF_INJECTED_FLAG: u32 = 0x0000_0001;
    const LLKHF_EXTENDED_FLAG: u32 = 0x0000_0001;
    const LLKHF_INJECTED_FLAG: u32 = 0x0000_0010;
    const LLKHF_ALTDOWN_FLAG: u32 = 0x0000_0020;

    const MK_LBUTTON_FLAG: usize = 0x0001;
    const MK_RBUTTON_FLAG: usize = 0x0002;
    const MK_SHIFT_FLAG: usize = 0x0004;
    const MK_CONTROL_FLAG: usize = 0x0008;
    const MK_MBUTTON_FLAG: usize = 0x0010;

    #[derive(Clone, Debug)]
    pub(crate) enum CapturedEvent {
        MouseButton {
            msg: u32,
            rel_x: f64,
            rel_y: f64,
            wparam_flags: usize,
        },
        MouseMove {
            rel_x: f64,
            rel_y: f64,
            wparam_flags: usize,
        },
        MouseWheel {
            msg: u32,
            rel_x: f64,
            rel_y: f64,
            delta: i16,
            key_flags: usize,
        },
        Key {
            vk: u32,
            scan_code: u32,
            extended: bool,
            is_down: bool,
            is_sys: bool,
            alt_down: bool,
            chars: Vec<u16>,
        },
    }

    #[derive(Clone, Debug)]
    pub(crate) struct VerifiedSlaveTarget {
        pub profile_id: String,
        pub hwnd_raw: isize,
        pub allowed_pids: HashSet<u32>,
        pub expected_class: &'static str,
    }

    impl From<&VerifiedManagedWindow> for VerifiedSlaveTarget {
        fn from(value: &VerifiedManagedWindow) -> Self {
            Self {
                profile_id: value.profile_id.clone(),
                hwnd_raw: value.hwnd_raw,
                allowed_pids: value.allowed_pids.clone(),
                expected_class: value.expected_class,
            }
        }
    }

    struct SlaveWorkerHandle {
        target: VerifiedSlaveTarget,
        tx: SyncSender<CapturedEvent>,
    }

    pub(crate) struct HookShared {
        pub session_id: u64,
        pub master_profile_id: String,
        pub master_hwnd: isize,
        pub active: AtomicBool,
        pub paused_by_user: AtomicBool,
        pub paused_by_focus: AtomicBool,
        pub sync_mouse_click: AtomicBool,
        pub sync_mouse_move: AtomicBool,
        pub sync_scroll: AtomicBool,
        pub sync_keyboard: AtomicBool,
        pub jitter_min_ms: u64,
        pub jitter_max_ms: u64,
        pub click_pos_jitter_px: i32,
        pub last_move_ms: AtomicU64,
        pub forwarded_events: AtomicU64,
        pub hook_thread_id: AtomicU32,
        pub double_esc: Mutex<DoubleEscDetector>,
        pub tracked_slave_hwnds: RwLock<HashSet<isize>>,
        pub event_tx: SyncSender<CapturedEvent>,
    }

    impl HookShared {
        fn is_capturing(&self) -> bool {
            self.active.load(Ordering::Acquire) && !self.paused_by_user.load(Ordering::Acquire)
        }

        fn signal_emergency_stop(&self, code: usize) {
            self.active.store(false, Ordering::Release);
            let tid = self.hook_thread_id.load(Ordering::Acquire);
            if tid != 0 {
                unsafe {
                    let _ = PostThreadMessageW(tid, WM_APP_EMERGENCY_STOP, WPARAM(code), LPARAM(0));
                }
            }
        }
    }

    static HOOK_CONTEXT: OnceLock<RwLock<Option<Arc<HookShared>>>> = OnceLock::new();

    fn hook_context_lock() -> &'static RwLock<Option<Arc<HookShared>>> {
        HOOK_CONTEXT.get_or_init(|| RwLock::new(None))
    }

    fn key_down(vk: i32) -> bool {
        (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
    }

    fn mouse_modifier_flags() -> usize {
        let mut flags = 0usize;
        if key_down(VK_CONTROL.0 as i32) {
            flags |= MK_CONTROL_FLAG;
        }
        if key_down(VK_SHIFT.0 as i32) {
            flags |= MK_SHIFT_FLAG;
        }
        flags
    }

    fn translate_printable_utf16(
        vk: u32,
        scan_code: u32,
        target_hwnd: HWND,
        shift_down: bool,
        ctrl_down: bool,
        alt_down: bool,
    ) -> Vec<u16> {
        // Control/Alt combinations (Ctrl+C, Ctrl+V, Alt+...) should not synthesize WM_CHAR.
        if ctrl_down || alt_down {
            return Vec::new();
        }
        let mut state = [0u8; 256];
        if shift_down {
            state[VK_SHIFT.0 as usize] = 0x80;
        }
        let caps_toggled = (unsafe { GetAsyncKeyState(VK_CAPITAL.0 as i32) } & 0x0001) != 0;
        if caps_toggled {
            state[VK_CAPITAL.0 as usize] = 0x01;
        }
        let thread_id = unsafe { GetWindowThreadProcessId(target_hwnd, None) };
        let hkl = unsafe { GetKeyboardLayout(thread_id) };
        let mut buf = [0u16; 8];
        // Flag 0x04 preserves keyboard dead-key state on Windows 10 1607+.
        let written = unsafe { ToUnicodeEx(vk, scan_code, &state, &mut buf, 0x04, Some(hkl)) };
        if written <= 0 {
            return Vec::new();
        }
        buf[..written as usize]
            .iter()
            .copied()
            .filter(|&unit| unit >= 0x20 && unit != 0x7F)
            .collect()
    }

    unsafe extern "system" fn low_level_mouse_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            if let Ok(guard) = hook_context_lock().try_read() {
                if let Some(shared) = guard.as_ref() {
                    if shared.is_capturing() {
                        let data = &*(lparam.0 as *const MSLLHOOKSTRUCT);
                        if (data.flags & LLMHF_INJECTED_FLAG) == 0 {
                            let fg = GetForegroundWindow();
                            let master = HWND(shared.master_hwnd as *mut c_void);
                            if fg == master {
                                if shared.paused_by_focus.swap(false, Ordering::AcqRel) {
                                    let tid = shared.hook_thread_id.load(Ordering::Acquire);
                                    if tid != 0 {
                                        let _ = PostThreadMessageW(
                                            tid,
                                            WM_APP_FOCUS_CHANGED,
                                            WPARAM(0),
                                            LPARAM(0),
                                        );
                                    }
                                }
                                let msg = wparam.0 as u32;
                                let wants = match msg {
                                    WM_LBUTTONDOWN | WM_LBUTTONUP | WM_RBUTTONDOWN
                                    | WM_RBUTTONUP | WM_MBUTTONDOWN | WM_MBUTTONUP => {
                                        shared.sync_mouse_click.load(Ordering::Acquire)
                                    }
                                    WM_MOUSEMOVE => shared.sync_mouse_move.load(Ordering::Acquire),
                                    WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
                                        shared.sync_scroll.load(Ordering::Acquire)
                                    }
                                    _ => false,
                                };
                                if wants {
                                    let mut pt = data.pt;
                                    let mut client = RECT::default();
                                    if ScreenToClient(master, &mut pt).as_bool()
                                        && GetClientRect(master, &mut client).is_ok()
                                    {
                                        if let Some((rel_x, rel_y)) = normalize_client_point(
                                            pt.x,
                                            pt.y,
                                            client.right - client.left,
                                            client.bottom - client.top,
                                        ) {
                                            let event = match msg {
                                                WM_MOUSEMOVE => {
                                                    let now = now_epoch_ms();
                                                    let prev =
                                                        shared.last_move_ms.load(Ordering::Relaxed);
                                                    if now.saturating_sub(prev)
                                                        >= MOUSE_MOVE_THROTTLE_MS
                                                    {
                                                        shared
                                                            .last_move_ms
                                                            .store(now, Ordering::Relaxed);
                                                        Some(CapturedEvent::MouseMove {
                                                            rel_x,
                                                            rel_y,
                                                            wparam_flags: mouse_modifier_flags(),
                                                        })
                                                    } else {
                                                        None
                                                    }
                                                }
                                                WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
                                                    let delta =
                                                        ((data.mouseData >> 16) as u16) as i16;
                                                    Some(CapturedEvent::MouseWheel {
                                                        msg,
                                                        rel_x,
                                                        rel_y,
                                                        delta,
                                                        key_flags: mouse_modifier_flags(),
                                                    })
                                                }
                                                WM_LBUTTONDOWN | WM_LBUTTONUP | WM_RBUTTONDOWN
                                                | WM_RBUTTONUP | WM_MBUTTONDOWN | WM_MBUTTONUP => {
                                                    let mut flags = mouse_modifier_flags();
                                                    match msg {
                                                        WM_LBUTTONDOWN => flags |= MK_LBUTTON_FLAG,
                                                        WM_RBUTTONDOWN => flags |= MK_RBUTTON_FLAG,
                                                        WM_MBUTTONDOWN => flags |= MK_MBUTTON_FLAG,
                                                        _ => {}
                                                    }
                                                    Some(CapturedEvent::MouseButton {
                                                        msg,
                                                        rel_x,
                                                        rel_y,
                                                        wparam_flags: flags,
                                                    })
                                                }
                                                _ => None,
                                            };
                                            if let Some(ev) = event {
                                                // Non-blocking try_send keeps hook latency < 1ms.
                                                let _ = shared.event_tx.try_send(ev);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    unsafe extern "system" fn low_level_keyboard_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            if let Ok(guard) = hook_context_lock().try_read() {
                if let Some(shared) = guard.as_ref() {
                    if shared.active.load(Ordering::Acquire) {
                        let data = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
                        let msg = wparam.0 as u32;
                        let is_down = matches!(msg, WM_KEYDOWN | WM_SYSKEYDOWN);
                        let is_up = matches!(msg, WM_KEYUP | WM_SYSKEYUP);
                        let ctrl = key_down(VK_CONTROL.0 as i32);
                        let shift = key_down(VK_SHIFT.0 as i32);
                        let alt =
                            key_down(VK_MENU.0 as i32) || (data.flags.0 & LLKHF_ALTDOWN_FLAG) != 0;
                        let win = key_down(VK_LWIN.0 as i32) || key_down(VK_RWIN.0 as i32);

                        // Passive emergency stop listeners (NEVER swallow OS keys).
                        if is_down && data.vkCode == VK_ESCAPE.0 as u32 {
                            if ctrl && shift {
                                shared.signal_emergency_stop(STOP_CODE_CTRL_SHIFT_ESC);
                                return CallNextHookEx(None, code, wparam, lparam);
                            }
                            if !ctrl && !shift && !alt && !win {
                                if let Ok(mut det) = shared.double_esc.try_lock() {
                                    if det.record_escape(now_epoch_ms()) {
                                        shared.signal_emergency_stop(STOP_CODE_DOUBLE_ESC);
                                        return CallNextHookEx(None, code, wparam, lparam);
                                    }
                                }
                            }
                        }

                        if (is_down || is_up)
                            && (data.flags.0 & LLKHF_INJECTED_FLAG) == 0
                            && shared.is_capturing()
                            && shared.sync_keyboard.load(Ordering::Acquire)
                            && !should_block_forwarded_key(data.vkCode, alt, ctrl, shift, win)
                        {
                            let fg = GetForegroundWindow();
                            let master = HWND(shared.master_hwnd as *mut c_void);
                            if fg == master {
                                if shared.paused_by_focus.swap(false, Ordering::AcqRel) {
                                    let tid = shared.hook_thread_id.load(Ordering::Acquire);
                                    if tid != 0 {
                                        let _ = PostThreadMessageW(
                                            tid,
                                            WM_APP_FOCUS_CHANGED,
                                            WPARAM(0),
                                            LPARAM(0),
                                        );
                                    }
                                }
                                let extended = (data.flags.0 & LLKHF_EXTENDED_FLAG) != 0;
                                let is_sys = matches!(msg, WM_SYSKEYDOWN | WM_SYSKEYUP);
                                let chars = if is_down {
                                    translate_printable_utf16(
                                        data.vkCode,
                                        data.scanCode,
                                        master,
                                        shift,
                                        ctrl,
                                        alt,
                                    )
                                } else {
                                    Vec::new()
                                };
                                let _ = shared.event_tx.try_send(CapturedEvent::Key {
                                    vk: data.vkCode,
                                    scan_code: data.scanCode,
                                    extended,
                                    is_down,
                                    is_sys,
                                    alt_down: alt,
                                    chars,
                                });
                            }
                        }
                    }
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    unsafe extern "system" fn win_event_proc(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        id_object: i32,
        id_child: i32,
        _event_thread: u32,
        _event_time: u32,
    ) {
        let Ok(guard) = hook_context_lock().try_read() else {
            return;
        };
        let Some(shared) = guard.as_ref() else {
            return;
        };
        if !shared.active.load(Ordering::Acquire) {
            return;
        }
        let hwnd_raw = hwnd.0 as isize;
        match event {
            EVENT_SYSTEM_FOREGROUND => {
                let paused_by_focus = hwnd_raw != shared.master_hwnd;
                let prev = shared
                    .paused_by_focus
                    .swap(paused_by_focus, Ordering::AcqRel);
                if prev != paused_by_focus {
                    let tid = shared.hook_thread_id.load(Ordering::Acquire);
                    if tid != 0 {
                        let _ = PostThreadMessageW(
                            tid,
                            WM_APP_FOCUS_CHANGED,
                            WPARAM(usize::from(paused_by_focus)),
                            LPARAM(0),
                        );
                    }
                }
            }
            EVENT_OBJECT_DESTROY if id_object == OBJID_WINDOW.0 && id_child == 0 => {
                if hwnd_raw == shared.master_hwnd {
                    shared.signal_emergency_stop(STOP_CODE_MASTER_CLOSED);
                } else if let Ok(slaves) = shared.tracked_slave_hwnds.try_read() {
                    if slaves.contains(&hwnd_raw) {
                        let tid = shared.hook_thread_id.load(Ordering::Acquire);
                        if tid != 0 {
                            let _ = PostThreadMessageW(
                                tid,
                                WM_APP_SLAVE_DESTROYED,
                                WPARAM(0),
                                LPARAM(hwnd_raw),
                            );
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// Resolves Chromium's inner `Chrome_RenderWidgetHostHWND` child (verified in `allowed_pids`).
    fn find_chromium_render_child(parent: HWND, allowed_pids: &HashSet<u32>) -> Option<HWND> {
        struct Search<'a> {
            allowed: &'a HashSet<u32>,
            found: Option<HWND>,
        }
        unsafe extern "system" fn enum_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let state = &mut *(lparam.0 as *mut Search);
            if read_window_class(hwnd) == "Chrome_RenderWidgetHostHWND"
                && verify_child_belongs_to_pids(hwnd, state.allowed)
            {
                state.found = Some(hwnd);
                return BOOL(0);
            }
            BOOL(1)
        }
        let mut search = Search {
            allowed: allowed_pids,
            found: None,
        };
        unsafe {
            let _ = EnumChildWindows(
                Some(parent),
                Some(enum_child),
                LPARAM(&mut search as *mut Search as isize),
            );
        }
        search.found
    }

    fn resolve_mouse_target(
        slave_hwnd: HWND,
        target: &VerifiedSlaveTarget,
        client_x: i32,
        client_y: i32,
    ) -> (HWND, i32, i32) {
        if target.expected_class != CHROMIUM_WINDOW_CLASS {
            return (slave_hwnd, client_x, client_y);
        }
        let candidate = unsafe {
            ChildWindowFromPointEx(
                slave_hwnd,
                POINT {
                    x: client_x,
                    y: client_y,
                },
                CWP_SKIPINVISIBLE | CWP_SKIPDISABLED,
            )
        };
        let child = if !candidate.0.is_null()
            && candidate != slave_hwnd
            && verify_child_belongs_to_pids(candidate, &target.allowed_pids)
        {
            Some(candidate)
        } else {
            find_chromium_render_child(slave_hwnd, &target.allowed_pids)
        };
        if let Some(child_hwnd) = child {
            let mut pt = POINT {
                x: client_x,
                y: client_y,
            };
            if unsafe {
                ClientToScreen(slave_hwnd, &mut pt).as_bool()
                    && ScreenToClient(child_hwnd, &mut pt).as_bool()
            } {
                return (child_hwnd, pt.x, pt.y);
            }
        }
        (slave_hwnd, client_x, client_y)
    }

    fn resolve_key_target(slave_hwnd: HWND, target: &VerifiedSlaveTarget) -> HWND {
        if target.expected_class == CHROMIUM_WINDOW_CLASS {
            if let Some(child) = find_chromium_render_child(slave_hwnd, &target.allowed_pids) {
                return child;
            }
        }
        slave_hwnd
    }

    fn dispatch_event_to_slave(
        target: &VerifiedSlaveTarget,
        event: &CapturedEvent,
        click_pos_jitter_px: i32,
        rng: &mut impl Rng,
    ) -> bool {
        // Second-pass live verification before every single PostMessageW call.
        if !verify_live_window(target.hwnd_raw, &target.allowed_pids, target.expected_class) {
            return false;
        }
        let slave_hwnd = HWND(target.hwnd_raw as *mut c_void);
        match event {
            CapturedEvent::MouseButton {
                msg,
                rel_x,
                rel_y,
                wparam_flags,
            } => {
                let mut rect = RECT::default();
                if unsafe { GetClientRect(slave_hwnd, &mut rect) }.is_err() {
                    return false;
                }
                let (dx, dy) = if click_pos_jitter_px > 0 {
                    (
                        rng.random_range(-click_pos_jitter_px..=click_pos_jitter_px),
                        rng.random_range(-click_pos_jitter_px..=click_pos_jitter_px),
                    )
                } else {
                    (0, 0)
                };
                let Some((cx, cy)) = map_relative_point(
                    *rel_x,
                    *rel_y,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    click_pos_jitter_px,
                    dx,
                    dy,
                ) else {
                    return true;
                };
                let (post_hwnd, tx, ty) = resolve_mouse_target(slave_hwnd, target, cx, cy);
                let _ = unsafe {
                    PostMessageW(
                        Some(post_hwnd),
                        *msg,
                        WPARAM(*wparam_flags),
                        LPARAM(make_xy_lparam(tx, ty)),
                    )
                };
            }
            CapturedEvent::MouseMove {
                rel_x,
                rel_y,
                wparam_flags,
            } => {
                let mut rect = RECT::default();
                if unsafe { GetClientRect(slave_hwnd, &mut rect) }.is_err() {
                    return false;
                }
                let Some((cx, cy)) = map_relative_point(
                    *rel_x,
                    *rel_y,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    0,
                    0,
                    0,
                ) else {
                    return true;
                };
                let (post_hwnd, tx, ty) = resolve_mouse_target(slave_hwnd, target, cx, cy);
                let _ = unsafe {
                    PostMessageW(
                        Some(post_hwnd),
                        WM_MOUSEMOVE,
                        WPARAM(*wparam_flags),
                        LPARAM(make_xy_lparam(tx, ty)),
                    )
                };
            }
            CapturedEvent::MouseWheel {
                msg,
                rel_x,
                rel_y,
                delta,
                key_flags,
            } => {
                let mut rect = RECT::default();
                if unsafe { GetClientRect(slave_hwnd, &mut rect) }.is_err() {
                    return false;
                }
                let Some((cx, cy)) = map_relative_point(
                    *rel_x,
                    *rel_y,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    0,
                    0,
                    0,
                ) else {
                    return true;
                };
                // Per Win32 spec, WM_MOUSEWHEEL / WM_MOUSEHWHEEL lParam uses screen coordinates.
                let mut screen_pt = POINT { x: cx, y: cy };
                if !unsafe { ClientToScreen(slave_hwnd, &mut screen_pt).as_bool() } {
                    return false;
                }
                let (post_hwnd, _, _) = resolve_mouse_target(slave_hwnd, target, cx, cy);
                let wparam = ((*delta as u16 as usize) << 16) | (*key_flags & 0xFFFF);
                let _ = unsafe {
                    PostMessageW(
                        Some(post_hwnd),
                        *msg,
                        WPARAM(wparam),
                        LPARAM(make_xy_lparam(screen_pt.x, screen_pt.y)),
                    )
                };
            }
            CapturedEvent::Key {
                vk,
                scan_code,
                extended,
                is_down,
                is_sys,
                alt_down,
                chars,
            } => {
                let post_hwnd = resolve_key_target(slave_hwnd, target);
                let msg = match (*is_down, *is_sys) {
                    (true, false) => WM_KEYDOWN,
                    (true, true) => WM_SYSKEYDOWN,
                    (false, false) => WM_KEYUP,
                    (false, true) => WM_SYSKEYUP,
                };
                let lparam = make_key_lparam(*scan_code, *extended, !*is_down, *alt_down);
                let _ = unsafe {
                    PostMessageW(Some(post_hwnd), msg, WPARAM(*vk as usize), LPARAM(lparam))
                };
                if *is_down {
                    for &utf16_unit in chars {
                        let _ = unsafe {
                            PostMessageW(
                                Some(post_hwnd),
                                WM_CHAR,
                                WPARAM(utf16_unit as usize),
                                LPARAM(1),
                            )
                        };
                    }
                }
            }
        }
        true
    }

    pub(crate) fn inject_text_via_wm_char(
        target: &VerifiedSlaveTarget,
        text: &str,
        char_delay_min_ms: u64,
        char_delay_max_ms: u64,
        press_enter: bool,
        cancel_flag: &AtomicBool,
    ) {
        let mut rng = rand::rng();
        let slave_hwnd = HWND(target.hwnd_raw as *mut c_void);
        for unit in text.encode_utf16() {
            if cancel_flag.load(Ordering::Acquire) {
                return;
            }
            if !verify_live_window(target.hwnd_raw, &target.allowed_pids, target.expected_class) {
                return;
            }
            let post_hwnd = resolve_key_target(slave_hwnd, target);
            let _ =
                unsafe { PostMessageW(Some(post_hwnd), WM_CHAR, WPARAM(unit as usize), LPARAM(1)) };
            let delay = if char_delay_max_ms > char_delay_min_ms {
                rng.random_range(char_delay_min_ms..=char_delay_max_ms)
            } else {
                char_delay_min_ms
            };
            if delay > 0 {
                thread::sleep(Duration::from_millis(delay));
            }
        }
        if press_enter && !cancel_flag.load(Ordering::Acquire) {
            if verify_live_window(target.hwnd_raw, &target.allowed_pids, target.expected_class) {
                let post_hwnd = resolve_key_target(slave_hwnd, target);
                let _ = unsafe {
                    PostMessageW(
                        Some(post_hwnd),
                        WM_KEYDOWN,
                        WPARAM(VK_RETURN.0 as usize),
                        LPARAM(make_key_lparam(0x1C, false, false, false)),
                    )
                };
                let _ = unsafe {
                    PostMessageW(
                        Some(post_hwnd),
                        WM_KEYUP,
                        WPARAM(VK_RETURN.0 as usize),
                        LPARAM(make_key_lparam(0x1C, false, true, false)),
                    )
                };
            }
        }
    }

    struct HookCleanupGuard {
        mouse_hook: Option<HHOOK>,
        kbd_hook: Option<HHOOK>,
        fg_event_hook: Option<HWINEVENTHOOK>,
        destroy_event_hook: Option<HWINEVENTHOOK>,
        hotkey_registered: bool,
        session_id: u64,
    }

    impl Drop for HookCleanupGuard {
        fn drop(&mut self) {
            if let Some(hook) = self.mouse_hook.take() {
                unsafe {
                    let _ = UnhookWindowsHookEx(hook);
                }
            }
            if let Some(hook) = self.kbd_hook.take() {
                unsafe {
                    let _ = UnhookWindowsHookEx(hook);
                }
            }
            if let Some(hook) = self.fg_event_hook.take() {
                unsafe {
                    let _ = UnhookWinEvent(hook);
                }
            }
            if let Some(hook) = self.destroy_event_hook.take() {
                unsafe {
                    let _ = UnhookWinEvent(hook);
                }
            }
            if self.hotkey_registered {
                self.hotkey_registered = false;
                unsafe {
                    let _ = UnregisterHotKey(None, HOTKEY_EMERGENCY_STOP_ID);
                }
            }
            if let Ok(mut guard) = hook_context_lock().write() {
                if guard
                    .as_ref()
                    .is_some_and(|ctx| ctx.session_id == self.session_id)
                {
                    *guard = None;
                }
            }
        }
    }

    struct ActiveSession {
        session_id: u64,
        shared: Arc<HookShared>,
        slaves: Arc<RwLock<Vec<SlaveWorkerHandle>>>,
        dropped_slaves: Vec<String>,
        hook_thread: Option<JoinHandle<()>>,
        dispatcher_thread: Option<JoinHandle<()>>,
    }

    pub(crate) type StatusEmitter = Arc<dyn Fn(&SyncStatusSnapshot) + Send + Sync>;

    struct SyncRuntime {
        next_session_id: u64,
        session: Option<ActiveSession>,
        last_stop_reason: Option<String>,
        status_emitter: Option<StatusEmitter>,
        injection_cancel: Arc<AtomicBool>,
    }

    pub(crate) struct ControllerInner {
        runtime: Mutex<SyncRuntime>,
        active_injection_jobs: AtomicUsize,
    }

    impl ControllerInner {
        pub(crate) fn new() -> Self {
            Self {
                runtime: Mutex::new(SyncRuntime {
                    next_session_id: 1,
                    session: None,
                    last_stop_reason: None,
                    status_emitter: None,
                    injection_cancel: Arc::new(AtomicBool::new(false)),
                }),
                active_injection_jobs: AtomicUsize::new(0),
            }
        }

        pub(crate) fn snapshot(&self) -> SyncStatusSnapshot {
            let jobs = self.active_injection_jobs.load(Ordering::Acquire);
            let Ok(runtime) = self.runtime.lock() else {
                return SyncStatusSnapshot::idle(Some("state_lock_error".to_owned()), jobs);
            };
            self.snapshot_locked(&runtime, jobs)
        }

        fn snapshot_locked(
            &self,
            runtime: &SyncRuntime,
            active_injection_jobs: usize,
        ) -> SyncStatusSnapshot {
            let Some(session) = runtime.session.as_ref() else {
                return SyncStatusSnapshot::idle(
                    runtime.last_stop_reason.clone(),
                    active_injection_jobs,
                );
            };
            let paused_by_user = session.shared.paused_by_user.load(Ordering::Acquire);
            let paused_by_focus = session.shared.paused_by_focus.load(Ordering::Acquire);
            let slave_profile_ids = session
                .slaves
                .read()
                .map(|list| {
                    list.iter()
                        .map(|handle| handle.target.profile_id.clone())
                        .collect()
                })
                .unwrap_or_default();
            SyncStatusSnapshot {
                supported: true,
                active: session.shared.active.load(Ordering::Acquire),
                paused: paused_by_user || paused_by_focus,
                paused_by_user,
                paused_by_focus,
                master_profile_id: Some(session.shared.master_profile_id.clone()),
                slave_profile_ids,
                dropped_slave_profile_ids: session.dropped_slaves.clone(),
                sync_mouse_click: session.shared.sync_mouse_click.load(Ordering::Acquire),
                sync_mouse_move: session.shared.sync_mouse_move.load(Ordering::Acquire),
                sync_scroll: session.shared.sync_scroll.load(Ordering::Acquire),
                sync_keyboard: session.shared.sync_keyboard.load(Ordering::Acquire),
                jitter_min_ms: session.shared.jitter_min_ms,
                jitter_max_ms: session.shared.jitter_max_ms,
                click_pos_jitter_px: session.shared.click_pos_jitter_px,
                emergency_hotkey: EMERGENCY_HOTKEY_LABEL.to_owned(),
                active_injection_jobs,
                forwarded_events: session.shared.forwarded_events.load(Ordering::Acquire),
                last_stop_reason: runtime.last_stop_reason.clone(),
                updated_at_ms: now_epoch_ms(),
            }
        }

        pub(crate) fn emit_status(&self) {
            let (emitter_opt, snapshot) = {
                let jobs = self.active_injection_jobs.load(Ordering::Acquire);
                let Ok(runtime) = self.runtime.lock() else {
                    return;
                };
                (
                    runtime.status_emitter.clone(),
                    self.snapshot_locked(&runtime, jobs),
                )
            };
            if let Some(emitter) = emitter_opt {
                emitter(&snapshot);
            }
        }

        fn spawn_slave_worker(
            controller: Weak<ControllerInner>,
            shared: Arc<HookShared>,
            target: VerifiedSlaveTarget,
        ) -> SlaveWorkerHandle {
            let (tx, rx) = mpsc::sync_channel::<CapturedEvent>(SLAVE_CHANNEL_CAPACITY);
            let worker_target = target.clone();
            let _ = thread::Builder::new()
                .name(format!("maobu-sync-slave-{}", target.profile_id))
                .spawn(move || {
                    let mut rng = rand::rng();
                    while let Ok(event) = rx.recv() {
                        if !shared.active.load(Ordering::Acquire) {
                            break;
                        }
                        // Humanized per-slave jitter preserving strict FIFO ordering.
                        if !matches!(event, CapturedEvent::MouseMove { .. }) {
                            let delay = if shared.jitter_max_ms > shared.jitter_min_ms {
                                rng.random_range(shared.jitter_min_ms..=shared.jitter_max_ms)
                            } else {
                                shared.jitter_min_ms
                            };
                            if delay > 0 {
                                thread::sleep(Duration::from_millis(delay));
                            }
                        }
                        if !shared.active.load(Ordering::Acquire) {
                            break;
                        }
                        if dispatch_event_to_slave(
                            &worker_target,
                            &event,
                            shared.click_pos_jitter_px,
                            &mut rng,
                        ) {
                            shared.forwarded_events.fetch_add(1, Ordering::Relaxed);
                        } else {
                            if let Some(ctrl) = controller.upgrade() {
                                ctrl.drop_invalid_slave(
                                    shared.session_id,
                                    &worker_target.profile_id,
                                );
                            }
                            break;
                        }
                    }
                });
            SlaveWorkerHandle { target, tx }
        }

        pub(crate) fn start_session(
            self: &Arc<Self>,
            status_emitter: StatusEmitter,
            config: NormalizedSyncConfig,
            managed: &[VerifiedManagedWindow],
        ) -> Result<SyncStatusSnapshot, String> {
            let by_id: HashMap<&str, &VerifiedManagedWindow> = managed
                .iter()
                .map(|item| (item.profile_id.as_str(), item))
                .collect();
            let master = *by_id
                .get(config.master_profile_id.as_str())
                .ok_or_else(|| {
                    format!(
                        "master profile '{}' does not have a verified open browser window",
                        config.master_profile_id
                    )
                })?;
            if !verify_live_window(master.hwnd_raw, &master.allowed_pids, master.expected_class) {
                return Err("master browser window is no longer valid".to_owned());
            }

            let mut slave_targets = Vec::new();
            for slave_id in &config.slave_profile_ids {
                let Some(&slave) = by_id.get(slave_id.as_str()) else {
                    continue;
                };
                if slave.hwnd_raw == master.hwnd_raw {
                    continue;
                }
                if verify_live_window(slave.hwnd_raw, &slave.allowed_pids, slave.expected_class) {
                    slave_targets.push(VerifiedSlaveTarget::from(slave));
                }
            }
            if slave_targets.is_empty() {
                return Err("no verified open slave browser windows were found".to_owned());
            }

            // Tear down any previous session cleanly before installing new hooks.
            self.stop_session("replaced_by_new_session", false);

            let session_id = {
                let mut runtime = self
                    .runtime
                    .lock()
                    .map_err(|_| "sync state lock failed".to_owned())?;
                runtime.status_emitter = Some(status_emitter);
                runtime.last_stop_reason = None;
                let id = runtime.next_session_id;
                runtime.next_session_id = runtime.next_session_id.saturating_add(1);
                id
            };

            let (event_tx, event_rx) = mpsc::sync_channel::<CapturedEvent>(HOOK_CHANNEL_CAPACITY);
            let fg_now = unsafe { GetForegroundWindow() };
            let initially_paused_by_focus = (fg_now.0 as isize) != master.hwnd_raw;
            let tracked_hwnds: HashSet<isize> = slave_targets.iter().map(|s| s.hwnd_raw).collect();

            let shared = Arc::new(HookShared {
                session_id,
                master_profile_id: master.profile_id.clone(),
                master_hwnd: master.hwnd_raw,
                active: AtomicBool::new(true),
                paused_by_user: AtomicBool::new(false),
                paused_by_focus: AtomicBool::new(initially_paused_by_focus),
                sync_mouse_click: AtomicBool::new(config.sync_mouse_click),
                sync_mouse_move: AtomicBool::new(config.sync_mouse_move),
                sync_scroll: AtomicBool::new(config.sync_scroll),
                sync_keyboard: AtomicBool::new(config.sync_keyboard),
                jitter_min_ms: config.jitter_min_ms,
                jitter_max_ms: config.jitter_max_ms,
                click_pos_jitter_px: config.click_pos_jitter_px,
                last_move_ms: AtomicU64::new(0),
                forwarded_events: AtomicU64::new(0),
                hook_thread_id: AtomicU32::new(0),
                double_esc: Mutex::new(DoubleEscDetector::default()),
                tracked_slave_hwnds: RwLock::new(tracked_hwnds),
                event_tx,
            });

            let worker_handles: Vec<SlaveWorkerHandle> = slave_targets
                .into_iter()
                .map(|target| {
                    Self::spawn_slave_worker(Arc::downgrade(self), Arc::clone(&shared), target)
                })
                .collect();
            let slaves_arc = Arc::new(RwLock::new(worker_handles));

            // Spawn fan-out dispatcher thread (bounded channel -> per-slave FIFO workers).
            let fanout_slaves = Arc::clone(&slaves_arc);
            let fanout_shared = Arc::clone(&shared);
            let dispatcher_thread = thread::Builder::new()
                .name("maobu-win32-sync-fanout".to_owned())
                .spawn(move || {
                    while let Ok(event) = event_rx.recv() {
                        if !fanout_shared.active.load(Ordering::Acquire) {
                            break;
                        }
                        if let Ok(list) = fanout_slaves.read() {
                            for handle in list.iter() {
                                let _ = handle.tx.try_send(event.clone());
                            }
                        }
                    }
                })
                .map_err(|error| format!("failed to spawn sync dispatcher thread: {error}"))?;

            // Spawn Win32 hook & hotkey message pump thread.
            let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
            let hook_shared = Arc::clone(&shared);
            let hook_ctrl = Arc::downgrade(self);
            let hook_thread = thread::Builder::new()
                .name("maobu-win32-sync-hook".to_owned())
                .spawn(move || {
                    // Force message queue creation before publishing thread ID.
                    let mut dummy = MSG::default();
                    unsafe {
                        let _ = PeekMessageW(&mut dummy, None, 0, 0, PM_NOREMOVE);
                    }
                    let tid = unsafe { GetCurrentThreadId() };
                    hook_shared.hook_thread_id.store(tid, Ordering::Release);

                    if let Ok(mut global_ctx) = hook_context_lock().write() {
                        *global_ctx = Some(Arc::clone(&hook_shared));
                    }
                    let mut guard = HookCleanupGuard {
                        mouse_hook: None,
                        kbd_hook: None,
                        fg_event_hook: None,
                        destroy_event_hook: None,
                        hotkey_registered: false,
                        session_id,
                    };

                    let mouse_hook = unsafe {
                        SetWindowsHookExW(WH_MOUSE_LL, Some(low_level_mouse_proc), None, 0)
                    };
                    let Ok(mouse_hook) = mouse_hook else {
                        let _ = ready_tx.send(Err("failed to install WH_MOUSE_LL hook".to_owned()));
                        return;
                    };
                    guard.mouse_hook = Some(mouse_hook);

                    let kbd_hook = unsafe {
                        SetWindowsHookExW(WH_KEYBOARD_LL, Some(low_level_keyboard_proc), None, 0)
                    };
                    let Ok(kbd_hook) = kbd_hook else {
                        let _ =
                            ready_tx.send(Err("failed to install WH_KEYBOARD_LL hook".to_owned()));
                        return;
                    };
                    guard.kbd_hook = Some(kbd_hook);

                    let fg_hook = unsafe {
                        SetWinEventHook(
                            EVENT_SYSTEM_FOREGROUND,
                            EVENT_SYSTEM_FOREGROUND,
                            None,
                            Some(win_event_proc),
                            0,
                            0,
                            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                        )
                    };
                    if !fg_hook.is_invalid() {
                        guard.fg_event_hook = Some(fg_hook);
                    }

                    let destroy_hook = unsafe {
                        SetWinEventHook(
                            EVENT_OBJECT_DESTROY,
                            EVENT_OBJECT_DESTROY,
                            None,
                            Some(win_event_proc),
                            0,
                            0,
                            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                        )
                    };
                    if !destroy_hook.is_invalid() {
                        guard.destroy_event_hook = Some(destroy_hook);
                    }

                    // Register Ctrl+Shift+F12 emergency hotkey; passive Ctrl+Shift+Esc & double-Esc
                    // also remain active even if another app already claimed F12.
                    if unsafe {
                        RegisterHotKey(
                            None,
                            HOTKEY_EMERGENCY_STOP_ID,
                            MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT,
                            VK_F12.0 as u32,
                        )
                    }
                    .is_ok()
                    {
                        guard.hotkey_registered = true;
                    }

                    let _ = ready_tx.send(Ok(()));

                    let mut msg = MSG::default();
                    let mut self_stop_reason: Option<&'static str> = None;
                    loop {
                        let ret = unsafe { GetMessageW(&mut msg, None, 0, 0) };
                        if ret.0 <= 0 {
                            break;
                        }
                        match msg.message {
                            WM_HOTKEY if msg.wParam.0 as i32 == HOTKEY_EMERGENCY_STOP_ID => {
                                self_stop_reason = Some("hotkey_ctrl_shift_f12");
                                break;
                            }
                            WM_APP_EMERGENCY_STOP => {
                                self_stop_reason = Some(match msg.wParam.0 {
                                    STOP_CODE_CTRL_SHIFT_ESC => "hotkey_ctrl_shift_esc",
                                    STOP_CODE_DOUBLE_ESC => "double_esc",
                                    STOP_CODE_MASTER_CLOSED => "master_window_closed",
                                    _ => "emergency_stop",
                                });
                                break;
                            }
                            WM_APP_FOCUS_CHANGED => {
                                if let Some(ctrl) = hook_ctrl.upgrade() {
                                    ctrl.emit_status();
                                }
                            }
                            WM_APP_SLAVE_DESTROYED => {
                                let destroyed_hwnd = msg.lParam.0;
                                if let Some(ctrl) = hook_ctrl.upgrade() {
                                    ctrl.drop_slave_by_hwnd(session_id, destroyed_hwnd);
                                }
                            }
                            _ => unsafe {
                                let _ = TranslateMessage(&msg);
                                let _ = DispatchMessageW(&msg);
                            },
                        }
                    }

                    // Unhook and unregister hotkey immediately on owning hook thread before notifying.
                    drop(guard);
                    if let Some(reason) = self_stop_reason {
                        if let Some(ctrl) = hook_ctrl.upgrade() {
                            ctrl.finalize_stop_from_hook_thread(session_id, reason);
                        }
                    }
                })
                .map_err(|error| format!("failed to spawn sync hook thread: {error}"))?;

            match ready_rx.recv_timeout(Duration::from_secs(3)) {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    shared.active.store(false, Ordering::Release);
                    let _ = hook_thread.join();
                    let _ = dispatcher_thread.join();
                    return Err(error);
                }
                Err(_) => {
                    shared.active.store(false, Ordering::Release);
                    return Err("timed out starting Win32 sync hook thread".to_owned());
                }
            }

            {
                let mut runtime = self
                    .runtime
                    .lock()
                    .map_err(|_| "sync state lock failed".to_owned())?;
                runtime.session = Some(ActiveSession {
                    session_id,
                    shared,
                    slaves: slaves_arc,
                    dropped_slaves: Vec::new(),
                    hook_thread: Some(hook_thread),
                    dispatcher_thread: Some(dispatcher_thread),
                });
            }
            self.emit_status();
            Ok(self.snapshot())
        }

        pub(crate) fn set_paused(&self, paused: bool) -> Result<SyncStatusSnapshot, String> {
            {
                let runtime = self
                    .runtime
                    .lock()
                    .map_err(|_| "sync state lock failed".to_owned())?;
                let session = runtime
                    .session
                    .as_ref()
                    .ok_or_else(|| "window synchronizer is not active".to_owned())?;
                session
                    .shared
                    .paused_by_user
                    .store(paused, Ordering::Release);
            }
            self.emit_status();
            Ok(self.snapshot())
        }

        pub(crate) fn update_slaves(
            self: &Arc<Self>,
            profile_ids: &[String],
            managed: &[VerifiedManagedWindow],
        ) -> Result<SyncStatusSnapshot, String> {
            let by_id: HashMap<&str, &VerifiedManagedWindow> = managed
                .iter()
                .map(|item| (item.profile_id.as_str(), item))
                .collect();

            let (session_id, shared, slaves_arc, master_profile_id, master_hwnd) = {
                let runtime = self
                    .runtime
                    .lock()
                    .map_err(|_| "sync state lock failed".to_owned())?;
                let session = runtime
                    .session
                    .as_ref()
                    .ok_or_else(|| "window synchronizer is not active".to_owned())?;
                (
                    session.session_id,
                    Arc::clone(&session.shared),
                    Arc::clone(&session.slaves),
                    session.shared.master_profile_id.clone(),
                    session.shared.master_hwnd,
                )
            };

            let mut seen = HashSet::new();
            let mut new_targets = Vec::new();
            for raw in profile_ids {
                let id = raw.trim();
                if id.is_empty() || id == master_profile_id || !seen.insert(id.to_owned()) {
                    continue;
                }
                if let Some(&window) = by_id.get(id) {
                    if window.hwnd_raw != master_hwnd
                        && verify_live_window(
                            window.hwnd_raw,
                            &window.allowed_pids,
                            window.expected_class,
                        )
                    {
                        new_targets.push(VerifiedSlaveTarget::from(window));
                    }
                }
            }

            if new_targets.is_empty() {
                self.stop_session("no_slaves_remaining", true);
                return Ok(self.snapshot());
            }

            let new_hwnds: HashSet<isize> = new_targets.iter().map(|t| t.hwnd_raw).collect();
            let new_handles: Vec<SlaveWorkerHandle> = new_targets
                .into_iter()
                .map(|target| {
                    Self::spawn_slave_worker(Arc::downgrade(self), Arc::clone(&shared), target)
                })
                .collect();

            if let Ok(mut list) = slaves_arc.write() {
                // Dropping old SlaveWorkerHandles closes their channels so removed workers exit cleanly.
                *list = new_handles;
            }
            if let Ok(mut hwnds) = shared.tracked_slave_hwnds.write() {
                *hwnds = new_hwnds;
            }
            if let Ok(mut runtime) = self.runtime.lock() {
                if let Some(session) = runtime.session.as_mut() {
                    if session.session_id == session_id {
                        session.dropped_slaves.clear();
                    }
                }
            }
            self.emit_status();
            Ok(self.snapshot())
        }

        fn drop_invalid_slave(&self, session_id: u64, profile_id: &str) {
            let mut should_stop = false;
            if let Ok(mut runtime) = self.runtime.lock() {
                if let Some(session) = runtime.session.as_mut() {
                    if session.session_id != session_id {
                        return;
                    }
                    let mut remaining_hwnds = HashSet::new();
                    if let Ok(mut list) = session.slaves.write() {
                        list.retain(|handle| handle.target.profile_id != profile_id);
                        for handle in list.iter() {
                            remaining_hwnds.insert(handle.target.hwnd_raw);
                        }
                        should_stop = list.is_empty();
                    }
                    if let Ok(mut hwnds) = session.shared.tracked_slave_hwnds.write() {
                        *hwnds = remaining_hwnds;
                    }
                    if !session.dropped_slaves.iter().any(|item| item == profile_id) {
                        session.dropped_slaves.push(profile_id.to_owned());
                    }
                }
            }
            if should_stop {
                self.stop_session("all_slaves_closed", true);
            } else {
                self.emit_status();
            }
        }

        fn drop_slave_by_hwnd(&self, session_id: u64, hwnd_raw: isize) {
            let profile_id = {
                let Ok(runtime) = self.runtime.lock() else {
                    return;
                };
                let Some(session) = runtime.session.as_ref() else {
                    return;
                };
                if session.session_id != session_id {
                    return;
                }
                session.slaves.read().ok().and_then(|list| {
                    list.iter()
                        .find(|h| h.target.hwnd_raw == hwnd_raw)
                        .map(|h| h.target.profile_id.clone())
                })
            };
            if let Some(id) = profile_id {
                self.drop_invalid_slave(session_id, &id);
            }
        }

        fn finalize_stop_from_hook_thread(&self, session_id: u64, reason: &str) {
            let dispatcher_to_join = {
                let Ok(mut runtime) = self.runtime.lock() else {
                    return;
                };
                runtime.injection_cancel.store(true, Ordering::Release);
                runtime.injection_cancel = Arc::new(AtomicBool::new(false));
                let matches = runtime
                    .session
                    .as_ref()
                    .is_some_and(|session| session.session_id == session_id);
                if !matches {
                    return;
                }
                runtime.last_stop_reason = Some(reason.to_owned());
                let mut session = runtime.session.take().unwrap();
                session.shared.active.store(false, Ordering::Release);
                if let Ok(mut list) = session.slaves.write() {
                    list.clear();
                }
                // Do not self-join `hook_thread` since we are currently executing on it.
                let _ = session.hook_thread.take();
                session.dispatcher_thread.take()
            };
            if let Some(handle) = dispatcher_to_join {
                if handle.thread().id() != thread::current().id() {
                    let _ = handle.join();
                }
            }
            self.emit_status();
        }

        pub(crate) fn stop_session(&self, reason: &str, emit: bool) -> SyncStatusSnapshot {
            let (hook_thread, dispatcher_thread) = {
                let Ok(mut runtime) = self.runtime.lock() else {
                    return self.snapshot();
                };
                // Cancel any active text injection batches immediately on emergency stop.
                runtime.injection_cancel.store(true, Ordering::Release);
                runtime.injection_cancel = Arc::new(AtomicBool::new(false));
                let Some(mut session) = runtime.session.take() else {
                    return self.snapshot_locked(
                        &runtime,
                        self.active_injection_jobs.load(Ordering::Acquire),
                    );
                };
                runtime.last_stop_reason = Some(reason.to_owned());
                session.shared.active.store(false, Ordering::Release);
                if let Ok(mut list) = session.slaves.write() {
                    list.clear();
                }
                let tid = session.shared.hook_thread_id.load(Ordering::Acquire);
                if tid != 0 {
                    unsafe {
                        let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
                    }
                }
                (session.hook_thread.take(), session.dispatcher_thread.take())
            };

            let current_tid = thread::current().id();
            if let Some(handle) = hook_thread {
                if handle.thread().id() != current_tid {
                    let _ = handle.join();
                }
            }
            if let Some(handle) = dispatcher_thread {
                if handle.thread().id() != current_tid {
                    let _ = handle.join();
                }
            }
            if emit {
                self.emit_status();
            }
            self.snapshot()
        }

        pub(crate) fn current_injection_targets(&self, include_master: bool) -> Vec<String> {
            let Ok(runtime) = self.runtime.lock() else {
                return Vec::new();
            };
            let Some(session) = runtime.session.as_ref() else {
                return Vec::new();
            };
            let mut ids = Vec::new();
            if include_master {
                ids.push(session.shared.master_profile_id.clone());
            }
            if let Ok(list) = session.slaves.read() {
                for handle in list.iter() {
                    ids.push(handle.target.profile_id.clone());
                }
            }
            ids
        }

        pub(crate) fn start_injection_job(
            self: &Arc<Self>,
            status_emitter: StatusEmitter,
            items: Vec<(VerifiedSlaveTarget, String)>,
            char_delay_min_ms: u64,
            char_delay_max_ms: u64,
            press_enter: bool,
        ) {
            let cancel_flag = {
                let Ok(mut runtime) = self.runtime.lock() else {
                    return;
                };
                runtime.status_emitter = Some(status_emitter);
                Arc::clone(&runtime.injection_cancel)
            };
            let total = items.len();
            self.active_injection_jobs.fetch_add(1, Ordering::AcqRel);
            self.emit_status();

            let controller = Arc::clone(self);
            let _ = thread::Builder::new()
                .name("maobu-win32-text-inject".to_owned())
                .spawn(move || {
                    let mut workers = Vec::with_capacity(total);
                    for (target, text) in items {
                        let flag = Arc::clone(&cancel_flag);
                        if let Ok(handle) = thread::Builder::new()
                            .name(format!("maobu-inject-{}", target.profile_id))
                            .spawn(move || {
                                inject_text_via_wm_char(
                                    &target,
                                    &text,
                                    char_delay_min_ms,
                                    char_delay_max_ms,
                                    press_enter,
                                    &flag,
                                );
                            })
                        {
                            workers.push(handle);
                        }
                    }
                    for worker in workers {
                        let _ = worker.join();
                    }
                    controller
                        .active_injection_jobs
                        .fetch_sub(1, Ordering::AcqRel);
                    controller.emit_status();
                });
        }
    }
}

pub struct SyncController {
    #[cfg(windows)]
    inner: Arc<win32_engine::ControllerInner>,
    #[cfg(not(windows))]
    _unsupported: (),
}

impl SyncController {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            inner: Arc::new(win32_engine::ControllerInner::new()),
            #[cfg(not(windows))]
            _unsupported: (),
        }
    }

    pub fn emergency_stop(&self, reason: &str) -> SyncStatusSnapshot {
        #[cfg(windows)]
        {
            self.inner.stop_session(reason, true)
        }
        #[cfg(not(windows))]
        {
            let _ = reason;
            SyncStatusSnapshot::unsupported()
        }
    }

    pub fn status(&self) -> SyncStatusSnapshot {
        #[cfg(windows)]
        {
            self.inner.snapshot()
        }
        #[cfg(not(windows))]
        {
            SyncStatusSnapshot::unsupported()
        }
    }
}

impl Default for SyncController {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SyncController {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            let _ = self.inner.stop_session("controller_dropped", false);
        }
    }
}

#[tauri::command]
pub async fn sync_start(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    dashboard_session: tauri::State<'_, crate::DesktopDashboardSession>,
    controller: tauri::State<'_, Arc<SyncController>>,
    config: SyncStartConfig,
) -> Result<SyncStatusSnapshot, String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    let normalized = validate_sync_config(&config)?;
    #[cfg(not(windows))]
    {
        let _ = (dashboard_session, controller, normalized);
        Err(crate::win32_window_registry::UNSUPPORTED_PLATFORM_ERROR.to_owned())
    }
    #[cfg(windows)]
    {
        use tauri::Emitter;
        let origin_url = origin.0.clone();
        let session = dashboard_session.0.as_str().to_owned();
        let managed =
            crate::win32_window_registry::resolve_verified_windows(&origin_url, &session).await?;
        let inner = Arc::clone(&controller.inner);
        let emitter: win32_engine::StatusEmitter = Arc::new(move |snapshot| {
            let _ = app.emit_to("main", SYNC_STATE_EVENT, snapshot);
        });
        tauri::async_runtime::spawn_blocking(move || {
            inner.start_session(emitter, normalized, &managed)
        })
        .await
        .map_err(|error| format!("sync start worker failed: {error}"))?
    }
}

#[tauri::command]
pub fn sync_stop(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    controller: tauri::State<'_, Arc<SyncController>>,
) -> Result<SyncStatusSnapshot, String> {
    crate::credentials::authorize(&window, &origin)?;
    let _ = app;
    Ok(controller.emergency_stop("user_stop"))
}

#[tauri::command]
pub fn sync_pause(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    controller: tauri::State<'_, Arc<SyncController>>,
    paused: bool,
) -> Result<SyncStatusSnapshot, String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    #[cfg(windows)]
    {
        controller.inner.set_paused(paused)
    }
    #[cfg(not(windows))]
    {
        let _ = (controller, paused);
        Err(crate::win32_window_registry::UNSUPPORTED_PLATFORM_ERROR.to_owned())
    }
}

#[tauri::command]
pub async fn sync_update_slaves(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    dashboard_session: tauri::State<'_, crate::DesktopDashboardSession>,
    controller: tauri::State<'_, Arc<SyncController>>,
    profile_ids: Vec<String>,
) -> Result<SyncStatusSnapshot, String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    #[cfg(not(windows))]
    {
        let _ = (dashboard_session, controller, profile_ids);
        Err(crate::win32_window_registry::UNSUPPORTED_PLATFORM_ERROR.to_owned())
    }
    #[cfg(windows)]
    {
        let origin_url = origin.0.clone();
        let session = dashboard_session.0.as_str().to_owned();
        let managed =
            crate::win32_window_registry::resolve_verified_windows(&origin_url, &session).await?;
        let inner = Arc::clone(&controller.inner);
        tauri::async_runtime::spawn_blocking(move || inner.update_slaves(&profile_ids, &managed))
            .await
            .map_err(|error| format!("sync update worker failed: {error}"))?
    }
}

#[tauri::command]
pub async fn sync_inject_texts(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    dashboard_session: tauri::State<'_, crate::DesktopDashboardSession>,
    controller: tauri::State<'_, Arc<SyncController>>,
    req: TextInjectRequest,
) -> Result<TextInjectResult, String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    let (char_delay_min_ms, char_delay_max_ms) = validate_text_inject_delays(&req)?;
    #[cfg(not(windows))]
    {
        let _ = (
            dashboard_session,
            controller,
            char_delay_min_ms,
            char_delay_max_ms,
        );
        Err(crate::win32_window_registry::UNSUPPORTED_PLATFORM_ERROR.to_owned())
    }
    #[cfg(windows)]
    {
        let origin_url = origin.0.clone();
        let session = dashboard_session.0.as_str().to_owned();
        let managed =
            crate::win32_window_registry::resolve_verified_windows(&origin_url, &session).await?;
        let inner = Arc::clone(&controller.inner);
        let requested_ids = if !req.target_profile_ids.is_empty() {
            req.target_profile_ids.clone()
        } else {
            let active_targets =
                inner.current_injection_targets(req.include_master.unwrap_or(false));
            if !active_targets.is_empty() {
                active_targets
            } else {
                managed.iter().map(|m| m.profile_id.clone()).collect()
            }
        };

        let by_id: HashMap<&str, &crate::win32_window_registry::VerifiedManagedWindow> = managed
            .iter()
            .map(|item| (item.profile_id.as_str(), item))
            .collect();
        let mut seen = HashSet::new();
        let mut descriptors = Vec::new();
        let mut verified_map = HashMap::new();
        let mut skipped = Vec::new();
        for raw_id in requested_ids {
            let id = raw_id.trim();
            if id.is_empty() || !seen.insert(id.to_owned()) {
                continue;
            }
            if let Some(&win) = by_id.get(id) {
                descriptors.push(TextTargetDescriptor {
                    profile_id: win.profile_id.clone(),
                    name: win.name.clone(),
                    custom_no: win.display_no.clone().unwrap_or_default(),
                });
                verified_map.insert(
                    win.profile_id.clone(),
                    win32_engine::VerifiedSlaveTarget::from(win),
                );
            } else {
                skipped.push(id.to_owned());
            }
        }

        let planned = plan_text_injections(&req, &descriptors)?;
        let queued_profiles: Vec<String> = planned.iter().map(|(id, _)| id.clone()).collect();
        let queued_set: HashSet<&str> = queued_profiles.iter().map(String::as_str).collect();
        for desc in &descriptors {
            if !queued_set.contains(desc.profile_id.as_str()) {
                skipped.push(desc.profile_id.clone());
            }
        }
        let dispatch_items: Vec<(win32_engine::VerifiedSlaveTarget, String)> = planned
            .into_iter()
            .filter_map(|(id, text)| verified_map.remove(&id).map(|target| (target, text)))
            .collect();
        let job_id = format!("inj_{}", hex::encode(rand::random::<[u8; 8]>()));
        let press_enter = req.press_enter.unwrap_or(false);
        let emitter: win32_engine::StatusEmitter = {
            use tauri::Emitter;
            Arc::new(move |snapshot| {
                let _ = app.emit_to("main", SYNC_STATE_EVENT, snapshot);
            })
        };
        inner.start_injection_job(
            emitter,
            dispatch_items,
            char_delay_min_ms,
            char_delay_max_ms,
            press_enter,
        );
        Ok(TextInjectResult {
            ok: true,
            job_id,
            queued_profiles,
            skipped_profiles: skipped,
        })
    }
}

#[tauri::command]
pub fn sync_status(
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    controller: tauri::State<'_, Arc<SyncController>>,
) -> Result<SyncStatusSnapshot, String> {
    crate::credentials::authorize(&window, &origin)?;
    Ok(controller.status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_sync_start_config_and_rejects_master_in_slaves_or_bad_bounds() {
        let valid = SyncStartConfig {
            master_profile_id: "p1".into(),
            slave_profile_ids: vec!["p2".into(), "p3".into(), "p2".into()],
            sync_mouse_click: None,
            sync_mouse_move: Some(true),
            sync_scroll: None,
            sync_keyboard: None,
            jitter_min_ms: Some(15),
            jitter_max_ms: Some(85),
            click_pos_jitter_px: Some(3),
        };
        let norm = validate_sync_config(&valid).unwrap();
        assert_eq!(norm.master_profile_id, "p1");
        assert_eq!(norm.slave_profile_ids, vec!["p2", "p3"]);
        assert!(norm.sync_mouse_click);
        assert!(norm.sync_mouse_move);

        // Master inside slaves rejected
        let mut bad = valid.clone();
        bad.slave_profile_ids = vec!["p1".into(), "p2".into()];
        assert!(validate_sync_config(&bad).is_err());

        // Inverted jitter bounds rejected
        let mut inverted = valid.clone();
        inverted.jitter_min_ms = Some(100);
        inverted.jitter_max_ms = Some(20);
        assert!(validate_sync_config(&inverted).is_err());

        // Excessive click jitter rejected
        let mut excess = valid;
        excess.click_pos_jitter_px = Some(5);
        assert!(validate_sync_config(&excess).is_err());
    }

    #[test]
    fn double_esc_detector_triggers_only_within_400ms_window() {
        let mut detector = DoubleEscDetector::default();
        assert!(!detector.record_escape(1000));
        assert!(!detector.record_escape(1500)); // 500ms > 400ms
        assert!(detector.record_escape(1850)); // 350ms <= 400ms -> trigger!
        assert!(!detector.record_escape(1900)); // reset after trigger
    }

    #[test]
    fn blocks_dangerous_os_and_hotkey_shortcuts_from_forwarding() {
        assert!(should_block_forwarded_key(0x09, true, false, false, false)); // Alt+Tab
        assert!(should_block_forwarded_key(0x73, true, false, false, false)); // Alt+F4
        assert!(should_block_forwarded_key(0x45, false, false, false, true)); // Win+E
        assert!(should_block_forwarded_key(0x5B, false, false, false, false)); // LWin
        assert!(should_block_forwarded_key(0x1B, false, true, true, false)); // Ctrl+Shift+Esc
        assert!(should_block_forwarded_key(0x7B, false, true, true, false)); // Ctrl+Shift+F12
        assert!(should_block_forwarded_key(0x2E, true, true, false, false)); // Ctrl+Alt+Del

        // Normal typing & browser shortcuts are allowed
        assert!(!should_block_forwarded_key(
            0x41, false, false, false, false
        )); // 'A'
        assert!(!should_block_forwarded_key(
            0x0D, false, false, false, false
        )); // Enter
        assert!(!should_block_forwarded_key(0x52, false, true, false, false)); // Ctrl+R
        assert!(!should_block_forwarded_key(
            0x09, false, false, false, false
        )); // Tab without Alt
    }

    #[test]
    fn normalizes_and_maps_coordinates_with_strict_client_bounds() {
        // Titlebar (negative client y) and outside clicks rejected
        assert_eq!(normalize_client_point(100, -10, 800, 600), None);
        assert_eq!(normalize_client_point(800, 100, 800, 600), None);
        assert_eq!(normalize_client_point(-1, 50, 800, 600), None);

        let (rx, ry) = normalize_client_point(400, 300, 801, 601).unwrap();
        assert!((rx - 0.5).abs() < 1e-6);
        assert!((ry - 0.5).abs() < 1e-6);

        // Proportional mapping onto a different slave window size
        assert_eq!(
            map_relative_point(0.5, 0.5, 1001, 501, 0, 0, 0),
            Some((500, 250))
        );
        // Edge jitter never escapes [0, w-1] x [0, h-1]
        assert_eq!(
            map_relative_point(0.0, 0.0, 400, 300, 4, -4, -4),
            Some((0, 0))
        );
        assert_eq!(
            map_relative_point(1.0, 1.0, 400, 300, 4, 4, 4),
            Some((399, 299))
        );
        // Oversized dx/dy is clamped to jitter_px
        assert_eq!(
            map_relative_point(0.5, 0.5, 101, 101, 2, 99, -99),
            Some((52, 48))
        );
        assert_eq!(map_relative_point(f64::NAN, 0.5, 100, 100, 0, 0, 0), None);
    }

    #[test]
    fn packs_negative_screen_coordinates_cleanly_in_lparam() {
        let lp = make_xy_lparam(-200, -50);
        let x = (lp as usize & 0xFFFF) as u16 as i16 as i32;
        let y = ((lp as usize >> 16) & 0xFFFF) as u16 as i16 as i32;
        assert_eq!((x, y), (-200, -50));
    }

    #[test]
    fn renders_safe_templates_and_rejects_credential_placeholders() {
        let rendered = render_safe_template(
            "Row {{index}}: {{name}} (#{{customNo}})",
            2,
            "Shop-A",
            "108",
        )
        .unwrap();
        assert_eq!(rendered, "Row 2: Shop-A (#108)");

        for forbidden in [
            "secret={{password}}",
            "code={{twofa}}",
            "code={{2fa}}",
            "raw={{cookie}}",
            "tok={{token}}",
            "pw={{emailPassword}}",
        ] {
            assert!(render_safe_template(forbidden, 1, "A", "1").is_err());
        }

        let too_long = "x".repeat(MAX_INJECT_TEXT_CHARS + 1);
        assert!(render_safe_template(&too_long, 1, "A", "1").is_err());
    }

    #[test]
    fn plans_differentiated_text_injections_for_all_three_modes() {
        let targets = vec![
            TextTargetDescriptor {
                profile_id: "p1".into(),
                name: "Alpha".into(),
                custom_no: "11".into(),
            },
            TextTargetDescriptor {
                profile_id: "p2".into(),
                name: "Beta".into(),
                custom_no: "22".into(),
            },
        ];

        // 1. per_line_ordered
        let ordered = TextInjectRequest {
            mode: TextInjectMode::PerLineOrdered,
            target_profile_ids: vec![],
            include_master: None,
            lines: vec!["hello-{{index}}".into(), "world-{{customNo}}".into()],
            profile_texts: HashMap::new(),
            template: None,
            char_delay_min_ms: Some(20),
            char_delay_max_ms: Some(40),
            press_enter: Some(true),
        };
        assert_eq!(
            plan_text_injections(&ordered, &targets).unwrap(),
            vec![
                ("p1".into(), "hello-1".into()),
                ("p2".into(), "world-22".into()),
            ]
        );

        // 2. per_profile_map
        let mapped = TextInjectRequest {
            mode: TextInjectMode::PerProfileMap,
            target_profile_ids: vec![],
            include_master: None,
            lines: vec![],
            profile_texts: HashMap::from([("p2".into(), "only-beta-{{name}}".into())]),
            template: None,
            char_delay_min_ms: None,
            char_delay_max_ms: None,
            press_enter: None,
        };
        assert_eq!(
            plan_text_injections(&mapped, &targets).unwrap(),
            vec![("p2".into(), "only-beta-Beta".into())]
        );

        // 3. template
        let templated = TextInjectRequest {
            mode: TextInjectMode::Template,
            target_profile_ids: vec![],
            include_master: None,
            lines: vec![],
            profile_texts: HashMap::new(),
            template: Some("{{index}}-{{name}}-{{customNo}}".into()),
            char_delay_min_ms: None,
            char_delay_max_ms: None,
            press_enter: None,
        };
        assert_eq!(
            plan_text_injections(&templated, &targets).unwrap(),
            vec![
                ("p1".into(), "1-Alpha-11".into()),
                ("p2".into(), "2-Beta-22".into()),
            ]
        );
    }

    #[test]
    fn encodes_key_lparam_bits_and_verifies_sync_controller_idle_contract() {
        let down = make_key_lparam(0x1E, false, false, false) as usize as u32;
        assert_eq!(down & 0xFFFF, 1);
        assert_eq!((down >> 16) & 0xFF, 0x1E);
        assert_eq!((down >> 24) & 1, 0);
        assert_eq!((down >> 30) & 3, 0);

        let up_ext_alt = make_key_lparam(0x48, true, true, true) as usize as u32;
        assert_eq!((up_ext_alt >> 24) & 1, 1);
        assert_eq!((up_ext_alt >> 29) & 1, 1);
        assert_eq!((up_ext_alt >> 30) & 3, 3);

        let ctrl = SyncController::new();
        let initial = ctrl.status();
        assert_eq!(initial.supported, cfg!(windows));
        assert!(!initial.active);
        assert_eq!(initial.emergency_hotkey, EMERGENCY_HOTKEY_LABEL);

        let stopped = ctrl.emergency_stop("user_stop");
        assert!(!stopped.active);

        // Verify frozen camelCase IPC contract fields for maobu-sync-state / sync_status.
        let json = serde_json::to_value(&initial).unwrap();
        for key in [
            "supported",
            "active",
            "paused",
            "pausedByUser",
            "pausedByFocus",
            "masterProfileId",
            "slaveProfileIds",
            "droppedSlaveProfileIds",
            "syncMouseClick",
            "syncMouseMove",
            "syncScroll",
            "syncKeyboard",
            "jitterMinMs",
            "jitterMaxMs",
            "clickPosJitterPx",
            "emergencyHotkey",
            "activeInjectionJobs",
            "forwardedEvents",
            "lastStopReason",
            "updatedAtMs",
        ] {
            assert!(json.get(key).is_some(), "missing expected JSON key: {key}");
        }

        // Verify CJK + emoji surrogate pair rendering stays safe.
        let unicode =
            render_safe_template("你好 {{name}} 🚀 #{{index}}", 3, "店铺A", "99").unwrap();
        assert_eq!(unicode, "你好 店铺A 🚀 #3");
        assert!(unicode.encode_utf16().count() > unicode.chars().count());
    }
}
