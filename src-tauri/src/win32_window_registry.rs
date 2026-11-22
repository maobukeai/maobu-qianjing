//! Verified mapping from sidecar-registered running profiles to Win32 top-level browser HWNDs.
//!
//! Security boundary: frontend inputs NEVER supply raw PIDs or HWNDs. All process and window
//! ownership is derived exclusively from the local sidecar's authenticated
//! `GET /ui/api/windows/registered-launches` endpoint and re-verified against live OS process
//! image paths, process creation times (anti-PID-reuse), and strict window class whitelists.

use crate::credentials::CredentialOrigin;
use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet, VecDeque},
    time::Duration,
};
use tauri::WebviewWindow;

#[allow(dead_code)]
pub(crate) const UNSUPPORTED_PLATFORM_ERROR: &str =
    "unsupported_platform: native Win32 window control is supported on Windows only";

pub(crate) const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";
pub(crate) const FIREFOX_WINDOW_CLASS: &str = "MozillaWindowClass";
pub(crate) const MAX_PROCESS_TREE_DEPTH: usize = 8;

const MAX_REGISTERED_LAUNCHES_BYTES: usize = 2 * 1024 * 1024;
const WINDOWS_TO_UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;
const TICKS_PER_MILLI: u64 = 10_000;
const MAX_CREATION_AFTER_START_MS: u64 = 120_000;
const MAX_START_AFTER_CREATION_MS: u64 = 300_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectPx {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl RectPx {
    pub const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }

    pub const fn width(&self) -> i32 {
        self.right.saturating_sub(self.left)
    }

    pub const fn height(&self) -> i32 {
        self.bottom.saturating_sub(self.top)
    }

    pub const fn area(&self) -> i64 {
        let w = self.width();
        let h = self.height();
        if w <= 0 || h <= 0 {
            0
        } else {
            (w as i64) * (h as i64)
        }
    }

    pub const fn is_non_empty(&self) -> bool {
        self.width() > 0 && self.height() > 0
    }
}

fn default_engine() -> String {
    "chromium".to_owned()
}

fn deserialize_optional_display_no<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match value {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_owned())
            }
        }
        Some(serde_json::Value::Number(number)) => Some(number.to_string()),
        Some(_) => None,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredLaunch {
    pub profile_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_optional_display_no")]
    pub display_no: Option<String>,
    #[serde(default)]
    pub window_label: Option<String>,
    #[serde(default = "default_engine")]
    pub engine: String,
    pub pid: u32,
    #[serde(default)]
    pub owner_pid: Option<u32>,
    #[serde(default)]
    pub binary_path: String,
    #[serde(default)]
    pub started_at: u64,
}

impl RegisteredLaunch {
    pub fn normalized_engine(&self) -> &'static str {
        if self.engine.eq_ignore_ascii_case("firefox") {
            "firefox"
        } else {
            "chromium"
        }
    }

    pub fn expected_window_class(&self) -> &'static str {
        if self.normalized_engine() == "firefox" {
            FIREFOX_WINDOW_CLASS
        } else {
            CHROMIUM_WINDOW_CLASS
        }
    }

    pub fn title_hint(&self) -> Option<String> {
        if let Some(label) = self
            .window_label
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return Some(label.to_owned());
        }
        let name = self.name.trim();
        let display_no = self.display_no.as_deref().map(str::trim).unwrap_or("");
        if !display_no.is_empty() && !name.is_empty() {
            Some(format!("#{display_no}"))
        } else if !name.is_empty() {
            Some(name.to_owned())
        } else if !display_no.is_empty() {
            Some(format!("#{display_no}"))
        } else {
            None
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RegisteredLaunchesPayload {
    List(Vec<RegisteredLaunch>),
    Wrapped { launches: Vec<RegisteredLaunch> },
}

pub(crate) fn parse_registered_launches_payload(
    bytes: &[u8],
) -> Result<Vec<RegisteredLaunch>, String> {
    if bytes.len() > MAX_REGISTERED_LAUNCHES_BYTES {
        return Err("registered launches response exceeded safety size limit".to_owned());
    }
    let payload: RegisteredLaunchesPayload = serde_json::from_slice(bytes)
        .map_err(|_| "registered launches response was malformed".to_owned())?;
    let list = match payload {
        RegisteredLaunchesPayload::List(items) => items,
        RegisteredLaunchesPayload::Wrapped { launches } => launches,
    };
    let own_pid = std::process::id();
    let mut seen_profiles = HashSet::new();
    let mut sanitized = Vec::with_capacity(list.len());
    for item in list {
        let profile_id = item.profile_id.trim();
        if profile_id.is_empty() || item.pid == 0 || item.pid == own_pid {
            continue;
        }
        if seen_profiles.insert(profile_id.to_owned()) {
            sanitized.push(item);
        }
    }
    Ok(sanitized)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedWindowInfo {
    pub profile_id: String,
    pub name: String,
    pub display_no: Option<String>,
    pub engine: String,
    pub pid: u32,
    pub window_pid: u32,
    pub hwnd_hex: String,
    pub title: String,
    pub class_name: String,
    pub rect: RectPx,
    pub client_rect: RectPx,
    pub is_minimized: bool,
    pub is_maximized: bool,
    pub is_topmost: bool,
    pub monitor_id: String,
    pub dpi: u32,
    pub window_count: usize,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct VerifiedProcessTree {
    pub launch: RegisteredLaunch,
    pub root_pid: u32,
    pub root_creation_time: u64,
    pub allowed_pids: HashSet<u32>,
    pub expected_class: &'static str,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) struct VerifiedManagedWindow {
    pub profile_id: String,
    pub name: String,
    pub display_no: Option<String>,
    pub engine: String,
    pub root_pid: u32,
    pub hwnd_raw: isize,
    pub all_hwnds: Vec<isize>,
    pub allowed_pids: HashSet<u32>,
    pub expected_class: &'static str,
    pub info: ManagedWindowInfo,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WindowCandidate {
    pub hwnd_raw: isize,
    pub pid: u32,
    pub visible: bool,
    pub has_owner: bool,
    pub is_tool_window: bool,
    pub is_cloaked: bool,
    pub is_minimized: bool,
    pub is_maximized: bool,
    pub is_topmost: bool,
    pub class_name: String,
    pub title: String,
    pub rect: RectPx,
    pub client_rect: RectPx,
    pub monitor_id: String,
    pub dpi: u32,
    pub z_order: usize,
}

pub(crate) fn format_hwnd_hex(hwnd_raw: isize) -> String {
    format!("0x{:08X}", hwnd_raw as usize)
}

pub(crate) fn normalize_executable_path(path: &str) -> String {
    let trimmed = path.trim();
    let stripped = if let Some(rest) = trimmed.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = trimmed.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        trimmed.to_owned()
    };
    stripped.replace('/', r"\").to_ascii_lowercase()
}

pub(crate) fn matches_expected_binary(
    actual_path: &str,
    expected_path: &str,
    engine: &str,
) -> bool {
    let actual_norm = normalize_executable_path(actual_path);
    if actual_norm.is_empty() {
        return false;
    }
    let expected_norm = normalize_executable_path(expected_path);
    if !expected_norm.is_empty() {
        return actual_norm == expected_norm;
    }
    let basename = actual_norm
        .rsplit('\\')
        .next()
        .unwrap_or(actual_norm.as_str());
    if engine.eq_ignore_ascii_case("firefox") {
        matches!(basename, "firefox.exe" | "camoufox.exe" | "aliasmode.exe")
    } else {
        matches!(
            basename,
            "chrome.exe" | "chromium.exe" | "cloakbrowser.exe" | "aliasmode.exe"
        )
    }
}

pub(crate) fn filetime_to_unix_ms(filetime_100ns: u64) -> Option<u64> {
    filetime_100ns
        .checked_sub(WINDOWS_TO_UNIX_EPOCH_TICKS)
        .map(|ticks| ticks / TICKS_PER_MILLI)
}

pub(crate) fn creation_time_matches_launch(
    root_creation_ft: u64,
    launch_started_at_ms: u64,
) -> bool {
    if launch_started_at_ms == 0 {
        return root_creation_ft > WINDOWS_TO_UNIX_EPOCH_TICKS;
    }
    let Some(created_ms) = filetime_to_unix_ms(root_creation_ft) else {
        return false;
    };
    created_ms <= launch_started_at_ms.saturating_add(MAX_CREATION_AFTER_START_MS)
        && launch_started_at_ms <= created_ms.saturating_add(MAX_START_AFTER_CREATION_MS)
}

pub(crate) fn collect_descendant_pids(
    root_pid: u32,
    root_creation_time: u64,
    children_map: &HashMap<u32, Vec<u32>>,
    creation_times: &HashMap<u32, u64>,
    max_depth: usize,
) -> HashSet<u32> {
    let mut allowed = HashSet::new();
    if root_pid == 0 {
        return allowed;
    }
    allowed.insert(root_pid);
    let mut queue = VecDeque::new();
    queue.push_back((root_pid, 0usize));

    while let Some((pid, depth)) = queue.pop_front() {
        if depth >= max_depth {
            continue;
        }
        let Some(children) = children_map.get(&pid) else {
            continue;
        };
        for &child_pid in children {
            if child_pid == 0 || allowed.contains(&child_pid) {
                continue;
            }
            let Some(&child_creation_time) = creation_times.get(&child_pid) else {
                continue;
            };
            // Defend against PID reuse: a genuine descendant cannot predate the root process.
            if child_creation_time < root_creation_time {
                continue;
            }
            allowed.insert(child_pid);
            queue.push_back((child_pid, depth + 1));
        }
    }
    allowed
}

pub(crate) fn is_eligible_browser_window(
    candidate: &WindowCandidate,
    allowed_pids: &HashSet<u32>,
    expected_class: &str,
    own_pid: u32,
) -> bool {
    if candidate.hwnd_raw == 0 || candidate.pid == 0 || candidate.pid == own_pid {
        return false;
    }
    if !allowed_pids.contains(&candidate.pid) {
        return false;
    }
    if !candidate.visible || candidate.has_owner || candidate.is_tool_window || candidate.is_cloaked
    {
        return false;
    }
    if candidate.class_name != expected_class {
        return false;
    }
    candidate.is_minimized || candidate.rect.is_non_empty()
}

pub(crate) fn select_primary_window(
    candidates: &[WindowCandidate],
    root_pid: u32,
    title_hint: Option<&str>,
) -> Option<usize> {
    let hint = title_hint.map(str::trim).filter(|value| !value.is_empty());
    candidates
        .iter()
        .enumerate()
        .max_by_key(|(_, candidate)| {
            let is_root = candidate.pid == root_pid;
            let matches_title = hint.is_some_and(|needle| candidate.title.contains(needle));
            let client_area = candidate.client_rect.area();
            (
                is_root,
                matches_title,
                client_area,
                Reverse(candidate.z_order),
            )
        })
        .map(|(index, _)| index)
}

#[allow(dead_code)]
pub(crate) async fn fetch_registered_launches(
    origin: &str,
    dashboard_session: &str,
) -> Result<Vec<RegisteredLaunch>, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|error| format!("could not initialize sidecar registry client: {error}"))?;
    let response = client
        .get(format!("{origin}/ui/api/windows/registered-launches"))
        .header(crate::DESKTOP_SESSION_HEADER, dashboard_session)
        .send()
        .await
        .map_err(|error| format!("could not query registered launches from sidecar: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "sidecar rejected registered-launches request with status {}",
            response.status().as_u16()
        ));
    }
    if response.content_length().unwrap_or(0) > MAX_REGISTERED_LAUNCHES_BYTES as u64 {
        return Err("registered launches response exceeded safety size limit".to_owned());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("could not read registered launches response: {error}"))?;
    parse_registered_launches_payload(&bytes)
}

#[cfg(windows)]
mod win32 {
    use super::{
        collect_descendant_pids, creation_time_matches_launch, format_hwnd_hex,
        is_eligible_browser_window, matches_expected_binary, select_primary_window,
        ManagedWindowInfo, RectPx, RegisteredLaunch, VerifiedManagedWindow, VerifiedProcessTree,
        WindowCandidate, MAX_PROCESS_TREE_DEPTH,
    };
    use std::{
        collections::{HashMap, HashSet},
        ffi::c_void,
        mem::size_of,
    };
    use windows::{
        core::{BOOL, PWSTR},
        Win32::{
            Foundation::{CloseHandle, FILETIME, HANDLE, HWND, LPARAM, RECT},
            Graphics::{
                Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
                Gdi::{
                    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITORINFOEXW,
                    MONITOR_DEFAULTTONEAREST,
                },
            },
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                    TH32CS_SNAPPROCESS,
                },
                Threading::{
                    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
                    PROCESS_ACCESS_RIGHTS, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
                },
            },
            UI::{
                HiDpi::GetDpiForWindow,
                WindowsAndMessaging::{
                    EnumWindows, GetClassNameW, GetClientRect, GetWindow, GetWindowLongW,
                    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
                    IsWindowVisible, IsZoomed, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
                    WS_EX_TOPMOST,
                },
            },
        },
    };

    pub(crate) struct OwnedHandle(pub(crate) HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    pub(crate) fn open_process(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> Option<OwnedHandle> {
        if pid == 0 {
            return None;
        }
        unsafe { OpenProcess(access, false, pid) }
            .ok()
            .filter(|handle| !handle.is_invalid())
            .map(OwnedHandle)
    }

    fn filetime_to_u64(ft: FILETIME) -> u64 {
        ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
    }

    pub(crate) fn query_process_creation_time(handle: HANDLE) -> Option<u64> {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) }
            .ok()?;
        Some(filetime_to_u64(creation))
    }

    fn query_process_image_path(handle: HANDLE) -> Option<String> {
        let mut buffer = vec![0u16; 1024];
        let mut len = buffer.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buffer.as_mut_ptr()),
                &mut len,
            )
        }
        .ok()?;
        if len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..len as usize]))
    }

    fn query_process_identity(pid: u32) -> Option<(String, u64)> {
        let handle = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let image = query_process_image_path(handle.0)?;
        let creation = query_process_creation_time(handle.0)?;
        Some((image, creation))
    }

    fn snapshot_process_children() -> Result<HashMap<u32, Vec<u32>>, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|error| format!("CreateToolhelp32Snapshot failed: {error}"))?;
        let snapshot = OwnedHandle(snapshot);

        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_ok() {
            loop {
                if entry.th32ProcessID != 0 && entry.th32ParentProcessID != entry.th32ProcessID {
                    children
                        .entry(entry.th32ParentProcessID)
                        .or_default()
                        .push(entry.th32ProcessID);
                }
                if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
                    break;
                }
            }
        }
        Ok(children)
    }

    pub(crate) fn resolve_process_trees(
        launches: &[RegisteredLaunch],
    ) -> Result<Vec<VerifiedProcessTree>, String> {
        if launches.is_empty() {
            return Ok(Vec::new());
        }
        let children_map = snapshot_process_children()?;
        let mut creation_cache: HashMap<u32, Option<u64>> = HashMap::new();
        let mut trees = Vec::new();

        for launch in launches {
            let root_pid = launch.pid;
            let Some((image_path, root_creation_time)) = query_process_identity(root_pid) else {
                continue;
            };
            if !matches_expected_binary(
                &image_path,
                &launch.binary_path,
                launch.normalized_engine(),
            ) {
                continue;
            }
            if !creation_time_matches_launch(root_creation_time, launch.started_at) {
                continue;
            }

            // Collect candidate descendant PIDs first so we only OpenProcess on subtree members.
            let mut to_probe = Vec::new();
            let mut seen = HashSet::from([root_pid]);
            let mut frontier = std::collections::VecDeque::from([(root_pid, 0usize)]);
            while let Some((pid, depth)) = frontier.pop_front() {
                if depth >= MAX_PROCESS_TREE_DEPTH {
                    continue;
                }
                if let Some(children) = children_map.get(&pid) {
                    for &child in children {
                        if child != 0 && seen.insert(child) {
                            to_probe.push(child);
                            frontier.push_back((child, depth + 1));
                        }
                    }
                }
            }

            let mut creation_times = HashMap::new();
            creation_times.insert(root_pid, root_creation_time);
            for pid in to_probe {
                let ct = *creation_cache.entry(pid).or_insert_with(|| {
                    let handle = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
                    query_process_creation_time(handle.0)
                });
                if let Some(ct) = ct {
                    creation_times.insert(pid, ct);
                }
            }

            let allowed_pids = collect_descendant_pids(
                root_pid,
                root_creation_time,
                &children_map,
                &creation_times,
                MAX_PROCESS_TREE_DEPTH,
            );
            trees.push(VerifiedProcessTree {
                expected_class: launch.expected_window_class(),
                launch: launch.clone(),
                root_pid,
                root_creation_time,
                allowed_pids,
            });
        }

        Ok(trees)
    }

    pub(crate) fn read_window_class(hwnd: HWND) -> String {
        let mut buf = [0u16; 128];
        let len = unsafe { GetClassNameW(hwnd, &mut buf) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }

    fn read_window_title(hwnd: HWND) -> String {
        let mut buf = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }

    fn is_window_cloaked(hwnd: HWND) -> bool {
        let mut cloaked: u32 = 0;
        let result = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut c_void,
                size_of::<u32>() as u32,
            )
        };
        result.is_ok() && cloaked != 0
    }

    pub(crate) fn monitor_id_for_hwnd(hwnd: HWND) -> String {
        let hmon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        if hmon.is_invalid() {
            return String::new();
        }
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        let ok = unsafe {
            GetMonitorInfoW(hmon, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool()
        };
        if !ok {
            return format!("monitor-{:x}", hmon.0 as usize);
        }
        let end = info
            .szDevice
            .iter()
            .position(|&ch| ch == 0)
            .unwrap_or(info.szDevice.len());
        let name = String::from_utf16_lossy(&info.szDevice[..end]);
        if name.is_empty() {
            format!("monitor-{:x}", hmon.0 as usize)
        } else {
            name
        }
    }

    fn to_rect_px(rect: RECT) -> RectPx {
        RectPx::new(rect.left, rect.top, rect.right, rect.bottom)
    }

    struct EnumContext {
        own_pid: u32,
        all_allowed_pids: HashSet<u32>,
        candidates: Vec<WindowCandidate>,
    }

    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut EnumContext);
        let mut wnd_pid = 0u32;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut wnd_pid));
        if wnd_pid == 0 || wnd_pid == ctx.own_pid || !ctx.all_allowed_pids.contains(&wnd_pid) {
            return BOOL(1);
        }
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let has_owner = GetWindow(hwnd, GW_OWNER)
            .map(|owner| !owner.0.is_null())
            .unwrap_or(false);
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let is_tool_window = (ex_style & WS_EX_TOOLWINDOW.0) != 0;
        let is_topmost = (ex_style & WS_EX_TOPMOST.0) != 0;
        let is_cloaked = is_window_cloaked(hwnd);
        let is_minimized = IsIconic(hwnd).as_bool();
        let is_maximized = IsZoomed(hwnd).as_bool();
        let class_name = read_window_class(hwnd);
        let title = read_window_title(hwnd);
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        let mut client_rect = RECT::default();
        let _ = GetClientRect(hwnd, &mut client_rect);
        let dpi = {
            let value = GetDpiForWindow(hwnd);
            if value == 0 {
                96
            } else {
                value
            }
        };
        let z_order = ctx.candidates.len();
        ctx.candidates.push(WindowCandidate {
            hwnd_raw: hwnd.0 as isize,
            pid: wnd_pid,
            visible: true,
            has_owner,
            is_tool_window,
            is_cloaked,
            is_minimized,
            is_maximized,
            is_topmost,
            class_name,
            title,
            rect: to_rect_px(rect),
            client_rect: to_rect_px(client_rect),
            monitor_id: monitor_id_for_hwnd(hwnd),
            dpi,
            z_order,
        });
        BOOL(1)
    }

    pub(crate) fn enumerate_managed_windows(
        launches: &[RegisteredLaunch],
    ) -> Result<Vec<VerifiedManagedWindow>, String> {
        let trees = resolve_process_trees(launches)?;
        if trees.is_empty() {
            return Ok(Vec::new());
        }
        let own_pid = std::process::id();
        let mut all_allowed_pids = HashSet::new();
        for tree in &trees {
            all_allowed_pids.extend(tree.allowed_pids.iter().copied());
        }
        let mut ctx = EnumContext {
            own_pid,
            all_allowed_pids,
            candidates: Vec::new(),
        };
        unsafe {
            EnumWindows(
                Some(enum_windows_proc),
                LPARAM(&mut ctx as *mut EnumContext as isize),
            )
        }
        .map_err(|error| format!("EnumWindows failed: {error}"))?;

        let mut managed = Vec::new();
        for tree in trees {
            let matching: Vec<WindowCandidate> = ctx
                .candidates
                .iter()
                .filter(|candidate| {
                    is_eligible_browser_window(
                        candidate,
                        &tree.allowed_pids,
                        tree.expected_class,
                        own_pid,
                    )
                })
                .cloned()
                .collect();
            let title_hint = tree.launch.title_hint();
            let Some(primary_idx) =
                select_primary_window(&matching, tree.root_pid, title_hint.as_deref())
            else {
                continue;
            };
            let primary = &matching[primary_idx];
            let all_hwnds: Vec<isize> = matching.iter().map(|c| c.hwnd_raw).collect();
            let info = ManagedWindowInfo {
                profile_id: tree.launch.profile_id.clone(),
                name: tree.launch.name.clone(),
                display_no: tree.launch.display_no.clone(),
                engine: tree.launch.normalized_engine().to_owned(),
                pid: tree.root_pid,
                window_pid: primary.pid,
                hwnd_hex: format_hwnd_hex(primary.hwnd_raw),
                title: primary.title.clone(),
                class_name: primary.class_name.clone(),
                rect: primary.rect,
                client_rect: primary.client_rect,
                is_minimized: primary.is_minimized,
                is_maximized: primary.is_maximized,
                is_topmost: primary.is_topmost,
                monitor_id: primary.monitor_id.clone(),
                dpi: primary.dpi,
                window_count: all_hwnds.len(),
            };
            managed.push(VerifiedManagedWindow {
                profile_id: tree.launch.profile_id,
                name: tree.launch.name,
                display_no: tree.launch.display_no,
                engine: info.engine.clone(),
                root_pid: tree.root_pid,
                hwnd_raw: primary.hwnd_raw,
                all_hwnds,
                allowed_pids: tree.allowed_pids,
                expected_class: tree.expected_class,
                info,
            });
        }

        managed.sort_by(|a, b| {
            let a_num = a
                .display_no
                .as_deref()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(u64::MAX);
            let b_num = b
                .display_no
                .as_deref()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(u64::MAX);
            a_num
                .cmp(&b_num)
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.profile_id.cmp(&b.profile_id))
        });

        Ok(managed)
    }

    /// Second-pass live verification performed immediately before dispatching input or layout ops.
    pub(crate) fn verify_live_window(
        hwnd_raw: isize,
        allowed_pids: &HashSet<u32>,
        expected_class: &str,
    ) -> bool {
        if hwnd_raw == 0 {
            return false;
        }
        let hwnd = HWND(hwnd_raw as *mut c_void);
        if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
            return false;
        }
        let mut pid = 0u32;
        let _ = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 || pid == std::process::id() || !allowed_pids.contains(&pid) {
            return false;
        }
        read_window_class(hwnd) == expected_class
    }

    pub(crate) fn verify_child_belongs_to_pids(
        child_hwnd: HWND,
        allowed_pids: &HashSet<u32>,
    ) -> bool {
        if child_hwnd.0.is_null() {
            return false;
        }
        if !unsafe { IsWindow(Some(child_hwnd)).as_bool() } {
            return false;
        }
        let mut pid = 0u32;
        let _ = unsafe { GetWindowThreadProcessId(child_hwnd, Some(&mut pid)) };
        pid != 0 && pid != std::process::id() && allowed_pids.contains(&pid)
    }
}

#[cfg(windows)]
pub(crate) use win32::{
    enumerate_managed_windows, open_process, query_process_creation_time, read_window_class,
    resolve_process_trees, verify_child_belongs_to_pids, verify_live_window,
};

#[cfg(not(windows))]
#[allow(dead_code)]
pub(crate) fn resolve_process_trees(
    _launches: &[RegisteredLaunch],
) -> Result<Vec<VerifiedProcessTree>, String> {
    Err(UNSUPPORTED_PLATFORM_ERROR.to_owned())
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub(crate) fn enumerate_managed_windows(
    _launches: &[RegisteredLaunch],
) -> Result<Vec<VerifiedManagedWindow>, String> {
    Err(UNSUPPORTED_PLATFORM_ERROR.to_owned())
}

pub(crate) async fn resolve_verified_windows(
    origin: &str,
    dashboard_session: &str,
) -> Result<Vec<VerifiedManagedWindow>, String> {
    #[cfg(not(windows))]
    {
        let _ = (origin, dashboard_session);
        Err(UNSUPPORTED_PLATFORM_ERROR.to_owned())
    }
    #[cfg(windows)]
    {
        let launches = fetch_registered_launches(origin, dashboard_session).await?;
        tauri::async_runtime::spawn_blocking(move || enumerate_managed_windows(&launches))
            .await
            .map_err(|error| format!("window registry worker failed: {error}"))?
    }
}

#[tauri::command]
pub async fn window_list_managed(
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    dashboard_session: tauri::State<'_, crate::DesktopDashboardSession>,
) -> Result<Vec<ManagedWindowInfo>, String> {
    crate::credentials::authorize(&window, &origin)?;
    let origin_url = origin.0.clone();
    let session = dashboard_session.0.as_str().to_owned();
    let windows = resolve_verified_windows(&origin_url, &session).await?;
    Ok(windows.into_iter().map(|item| item.info).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_candidate(
        hwnd_raw: isize,
        pid: u32,
        class_name: &str,
        title: &str,
        client_w: i32,
        client_h: i32,
        z_order: usize,
    ) -> WindowCandidate {
        WindowCandidate {
            hwnd_raw,
            pid,
            visible: true,
            has_owner: false,
            is_tool_window: false,
            is_cloaked: false,
            is_minimized: false,
            is_maximized: false,
            is_topmost: false,
            class_name: class_name.to_owned(),
            title: title.to_owned(),
            rect: RectPx::new(0, 0, client_w + 16, client_h + 40),
            client_rect: RectPx::new(0, 0, client_w, client_h),
            monitor_id: r"\\.\DISPLAY1".to_owned(),
            dpi: 96,
            z_order,
        }
    }

    #[test]
    fn parses_array_and_wrapped_registered_launches_and_filters_unsafe_entries() {
        let own_pid = std::process::id();
        let raw = serde_json::json!([
            {
                "profileId": "p1",
                "name": "Alpha",
                "displayNo": 7,
                "engine": "chromium",
                "pid": 12345,
                "binaryPath": r"C:\Apps\cloakbrowser.exe",
                "startedAt": 1_750_000_000_000u64
            },
            {
                "profileId": "p2",
                "name": "Fox",
                "displayNo": "12",
                "engine": "firefox",
                "pid": 22345,
                "ownerPid": 22000,
                "binaryPath": r"C:\Apps\aliasmode.exe",
                "startedAt": 1_750_000_001_000u64
            },
            { "profileId": "", "pid": 99999 },
            { "profileId": "zero-pid", "pid": 0 },
            { "profileId": "self-pid", "pid": own_pid },
            { "profileId": "p1", "name": "Duplicate", "pid": 54321 }
        ]);
        let parsed = parse_registered_launches_payload(&serde_json::to_vec(&raw).unwrap()).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].profile_id, "p1");
        assert_eq!(parsed[0].display_no.as_deref(), Some("7"));
        assert_eq!(parsed[0].expected_window_class(), CHROMIUM_WINDOW_CLASS);
        assert_eq!(parsed[1].profile_id, "p2");
        assert_eq!(parsed[1].display_no.as_deref(), Some("12"));
        assert_eq!(parsed[1].expected_window_class(), FIREFOX_WINDOW_CLASS);

        let wrapped = serde_json::json!({ "ok": true, "launches": [
            { "profileId": "p3", "name": "Wrapped", "pid": 33333 }
        ]});
        let parsed_wrapped =
            parse_registered_launches_payload(&serde_json::to_vec(&wrapped).unwrap()).unwrap();
        assert_eq!(parsed_wrapped.len(), 1);
        assert_eq!(parsed_wrapped[0].profile_id, "p3");
        assert_eq!(parsed_wrapped[0].normalized_engine(), "chromium");
    }

    #[test]
    fn normalizes_paths_and_enforces_binary_verification() {
        assert_eq!(
            normalize_executable_path(r"\\?\C:/Program Files/Maobu/CloakBrowser.EXE"),
            r"c:\program files\maobu\cloakbrowser.exe"
        );
        assert!(matches_expected_binary(
            r"\\?\C:\Maobu\cloakbrowser.exe",
            r"c:/Maobu/CloakBrowser.exe",
            "chromium"
        ));
        assert!(!matches_expected_binary(
            r"C:\Windows\System32\notepad.exe",
            r"C:\Maobu\cloakbrowser.exe",
            "chromium"
        ));
        // Empty expected path falls back to strict browser executable whitelist.
        assert!(matches_expected_binary(
            r"C:\Users\u\firefox.exe",
            "",
            "firefox"
        ));
        assert!(!matches_expected_binary(
            r"C:\Users\u\chrome.exe",
            "",
            "firefox"
        ));
        assert!(!matches_expected_binary(
            r"C:\Windows\explorer.exe",
            "",
            "chromium"
        ));
    }

    #[test]
    fn rejects_pid_reuse_via_creation_time_checks() {
        let started_ms: u64 = 1_750_000_000_000;
        let exact_ft = WINDOWS_TO_UNIX_EPOCH_TICKS + started_ms * TICKS_PER_MILLI;
        assert_eq!(filetime_to_unix_ms(exact_ft), Some(started_ms));
        assert!(creation_time_matches_launch(exact_ft, started_ms));
        // Spawned 15s before launch row recorded -> valid
        assert!(creation_time_matches_launch(
            WINDOWS_TO_UNIX_EPOCH_TICKS + (started_ms - 15_000) * TICKS_PER_MILLI,
            started_ms
        ));
        // Reused PID spawned 10 minutes after launch -> rejected
        assert!(!creation_time_matches_launch(
            WINDOWS_TO_UNIX_EPOCH_TICKS + (started_ms + 600_000) * TICKS_PER_MILLI,
            started_ms
        ));
        // Unrelated pre-existing PID spawned 1 hour earlier -> rejected
        assert!(!creation_time_matches_launch(
            WINDOWS_TO_UNIX_EPOCH_TICKS + (started_ms - 3_600_000) * TICKS_PER_MILLI,
            started_ms
        ));
    }

    #[test]
    fn collects_descendants_with_depth_limit_cycle_guard_and_pid_reuse_defense() {
        let mut children = HashMap::new();
        // Chain 100 -> 101 -> 102 -> ... -> 110 (depth 10), plus cycle back to 100
        for pid in 100u32..110 {
            children.insert(pid, vec![pid + 1]);
        }
        children.get_mut(&102).unwrap().push(100); // cycle
        children.get_mut(&100).unwrap().push(200); // recycled older PID
        children.get_mut(&100).unwrap().push(201); // unreadable elevated PID (no creation time)

        let mut creation_times = HashMap::new();
        let root_ct = 500_000u64;
        for pid in 100u32..=110 {
            creation_times.insert(pid, root_ct + (pid - 100) as u64 * 10);
        }
        creation_times.insert(200, root_ct - 1); // older than root -> must be excluded

        let allowed = collect_descendant_pids(100, root_ct, &children, &creation_times, 8);
        assert!(allowed.contains(&100));
        assert!(allowed.contains(&108)); // depth 8 included
        assert!(!allowed.contains(&109)); // depth 9 excluded
        assert!(!allowed.contains(&200)); // older PID reuse excluded
        assert!(!allowed.contains(&201)); // missing creation time excluded
    }

    #[test]
    fn filters_windows_strictly_by_class_owner_cloaked_tool_and_visibility() {
        let allowed = HashSet::from([1000u32, 1001u32]);
        let own_pid = 9999u32;

        let valid = sample_candidate(1, 1000, CHROMIUM_WINDOW_CLASS, "Alpha", 1200, 800, 0);
        assert!(is_eligible_browser_window(
            &valid,
            &allowed,
            CHROMIUM_WINDOW_CLASS,
            own_pid
        ));

        // Hidden Chromium helper class must be rejected
        let helper = sample_candidate(2, 1000, "Chrome_WidgetWin_0", "", 1200, 800, 1);
        assert!(!is_eligible_browser_window(
            &helper,
            &allowed,
            CHROMIUM_WINDOW_CLASS,
            own_pid
        ));

        // Wrong engine class must be rejected
        assert!(!is_eligible_browser_window(
            &valid,
            &allowed,
            FIREFOX_WINDOW_CLASS,
            own_pid
        ));

        // Owned popup / tool window / cloaked / invisible / zero-sized rejected
        let mut owned = valid.clone();
        owned.has_owner = true;
        assert!(!is_eligible_browser_window(
            &owned,
            &allowed,
            CHROMIUM_WINDOW_CLASS,
            own_pid
        ));

        let mut tool = valid.clone();
        tool.is_tool_window = true;
        assert!(!is_eligible_browser_window(
            &tool,
            &allowed,
            CHROMIUM_WINDOW_CLASS,
            own_pid
        ));

        let mut cloaked = valid.clone();
        cloaked.is_cloaked = true;
        assert!(!is_eligible_browser_window(
            &cloaked,
            &allowed,
            CHROMIUM_WINDOW_CLASS,
            own_pid
        ));

        // Minimized browser window with empty rect IS allowed so arrange/restore works
        let mut minimized = valid.clone();
        minimized.is_minimized = true;
        minimized.rect = RectPx::new(-32000, -32000, -32000, -32000);
        assert!(is_eligible_browser_window(
            &minimized,
            &allowed,
            CHROMIUM_WINDOW_CLASS,
            own_pid
        ));

        // Non-minimized empty window rejected
        let mut empty = valid.clone();
        empty.rect = RectPx::new(100, 100, 100, 100);
        assert!(!is_eligible_browser_window(
            &empty,
            &allowed,
            CHROMIUM_WINDOW_CLASS,
            own_pid
        ));

        // Own app PID never matched even if somehow in allowed
        let own_set = HashSet::from([own_pid]);
        let mut own_wnd = valid;
        own_wnd.pid = own_pid;
        assert!(!is_eligible_browser_window(
            &own_wnd,
            &own_set,
            CHROMIUM_WINDOW_CLASS,
            own_pid
        ));
    }

    #[test]
    fn ranks_primary_window_by_root_pid_then_label_then_area_then_zorder() {
        let candidates = vec![
            // Child PID, huge area, frontmost Z
            sample_candidate(1, 2001, CHROMIUM_WINDOW_CLASS, "#7 Alpha", 1920, 1080, 0),
            // Root PID, smaller area, no label match
            sample_candidate(2, 2000, CHROMIUM_WINDOW_CLASS, "Blank", 800, 600, 3),
            // Root PID, label match, smaller area
            sample_candidate(
                3,
                2000,
                CHROMIUM_WINDOW_CLASS,
                "#7 Alpha - Web",
                900,
                700,
                2,
            ),
            // Root PID, label match, larger area, lower Z
            sample_candidate(
                4,
                2000,
                CHROMIUM_WINDOW_CLASS,
                "#7 Alpha - Main",
                1200,
                800,
                4,
            ),
            // Root PID, label match, same area, better Z
            sample_candidate(
                5,
                2000,
                CHROMIUM_WINDOW_CLASS,
                "#7 Alpha - Top",
                1200,
                800,
                1,
            ),
        ];
        let winner = select_primary_window(&candidates, 2000, Some("#7 Alpha"));
        assert_eq!(winner, Some(4));
    }

    #[test]
    fn resolves_title_hints_and_serializes_managed_window_info_camel_case() {
        let with_label = RegisteredLaunch {
            profile_id: "p1".into(),
            name: "Shop".into(),
            display_no: Some("9".into()),
            window_label: Some("Shop · #9".into()),
            engine: "chromium".into(),
            pid: 4242,
            owner_pid: None,
            binary_path: String::new(),
            started_at: 0,
        };
        assert_eq!(with_label.title_hint().as_deref(), Some("Shop · #9"));

        let mut without_label = with_label.clone();
        without_label.window_label = None;
        assert_eq!(without_label.title_hint().as_deref(), Some("#9"));

        assert_eq!(format_hwnd_hex(0x001A_04B2), "0x001A04B2");

        let info = ManagedWindowInfo {
            profile_id: "p1".into(),
            name: "Shop".into(),
            display_no: Some("9".into()),
            engine: "chromium".into(),
            pid: 4242,
            window_pid: 4242,
            hwnd_hex: format_hwnd_hex(0x001A_04B2),
            title: "Shop · #9".into(),
            class_name: CHROMIUM_WINDOW_CLASS.into(),
            rect: RectPx::new(0, 0, 1280, 720),
            client_rect: RectPx::new(0, 0, 1264, 681),
            is_minimized: false,
            is_maximized: false,
            is_topmost: true,
            monitor_id: r"\\.\DISPLAY1".into(),
            dpi: 120,
            window_count: 1,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["profileId"], "p1");
        assert_eq!(json["displayNo"], "9");
        assert_eq!(json["windowPid"], 4242);
        assert_eq!(json["hwndHex"], "0x001A04B2");
        assert_eq!(json["className"], CHROMIUM_WINDOW_CLASS);
        assert_eq!(json["isMinimized"], false);
        assert_eq!(json["isMaximized"], false);
        assert_eq!(json["isTopmost"], true);
        assert_eq!(json["monitorId"], r"\\.\DISPLAY1");
        assert_eq!(json["windowCount"], 1);
    }
}
