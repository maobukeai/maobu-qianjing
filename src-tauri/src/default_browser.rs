use crate::credentials::CredentialOrigin;
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewWindow};
use tauri_plugin_shell::ShellExt;

pub(crate) const REGISTERED_APP_NAME: &str = "MaobuBrowser";
pub(crate) const APP_DISPLAY_NAME: &str = "猫步·千境";
pub(crate) const APP_DESCRIPTION: &str = "猫步·千境 · 多环境隔离指纹浏览器";
pub(crate) const PROG_ID_URL: &str = "MaobuBrowserURL";
pub(crate) const PROG_ID_HTML: &str = "MaobuBrowserHTML";
pub(crate) const CAPABILITIES_PATH: &str =
    r"Software\Clients\StartMenuInternet\MaobuBrowser\Capabilities";
pub(crate) const EXTERNAL_URL_EVENT: &str = "maobu:external-url";
const MAX_EXTERNAL_URL_LEN: usize = 4096;
const MAX_PENDING_EXTERNAL_URLS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultBrowserStatus {
    pub supported: bool,
    pub registered: bool,
    pub registration_current: bool,
    pub is_default_http: bool,
    pub is_default_https: bool,
    pub is_default: bool,
    pub current_http_prog_id: Option<String>,
    pub current_https_prog_id: Option<String>,
    pub exe_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalUrlEvent {
    pub id: u64,
    pub url: String,
    pub received_at_ms: u64,
}

#[derive(Default)]
struct PendingExternalUrlQueue {
    next_id: u64,
    frontend_ready: bool,
    queue: VecDeque<ExternalUrlEvent>,
}

/// Holds intercepted OS external URL launches until the renderer has mounted and drained them.
#[derive(Default)]
pub struct PendingExternalUrls {
    inner: Mutex<PendingExternalUrlQueue>,
}

impl PendingExternalUrls {
    /// Records URLs and returns `(events, should_emit_live)` depending on whether the frontend has mounted.
    pub fn enqueue(&self, urls: Vec<String>) -> (Vec<ExternalUrlEvent>, bool) {
        if urls.is_empty() {
            return (Vec::new(), false);
        }
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let Ok(mut guard) = self.inner.lock() else {
            return (Vec::new(), false);
        };
        let mut created = Vec::with_capacity(urls.len());
        for url in urls {
            guard.next_id = guard.next_id.saturating_add(1);
            let event = ExternalUrlEvent {
                id: guard.next_id,
                url,
                received_at_ms: now_ms,
            };
            if !guard.frontend_ready {
                if guard.queue.len() >= MAX_PENDING_EXTERNAL_URLS {
                    guard.queue.pop_front();
                }
                guard.queue.push_back(event.clone());
            }
            created.push(event);
        }
        (created, guard.frontend_ready)
    }

    pub fn take_pending(&self) -> Vec<ExternalUrlEvent> {
        let Ok(mut guard) = self.inner.lock() else {
            return Vec::new();
        };
        guard.frontend_ready = true;
        guard.queue.drain(..).collect()
    }
}

/// Validates and canonicalizes an incoming OS URL argument (`http://` / `https://` only).
pub fn parse_external_http_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_EXTERNAL_URL_LEN
        || trimmed.starts_with('-')
        || trimmed.bytes().any(|b| b.is_ascii_control())
    {
        return None;
    }
    let parsed = Url::parse(trimmed).ok()?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if parsed.host_str().is_none_or(|host| host.is_empty()) {
        return None;
    }
    Some(parsed.as_str().to_owned())
}

/// Extracts external HTTP(S) URLs from a process argument list (skipping argv[0]).
pub fn extract_external_urls<I, S>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut urls: Vec<String> = Vec::new();
    for arg in args.into_iter().skip(1) {
        if let Some(url) = parse_external_http_url(arg.as_ref()) {
            if urls.last().is_some_and(|prev| prev == &url) {
                continue;
            }
            urls.push(url);
        }
    }
    urls
}

pub fn build_open_command(exe_path: &str) -> String {
    format!("\"{exe_path}\" \"%1\"")
}

pub fn build_direct_launch_command(exe_path: &str) -> String {
    format!("\"{exe_path}\"")
}

pub fn build_icon_value(exe_path: &str) -> String {
    format!("{exe_path},0")
}

pub fn prog_id_matches_maobu(prog_id: Option<&str>) -> bool {
    prog_id.is_some_and(|value| {
        let trimmed = value.trim();
        trimmed.eq_ignore_ascii_case(PROG_ID_URL) || trimmed.eq_ignore_ascii_case(PROG_ID_HTML)
    })
}

/// Queues URLs or emits them immediately to the main window if the frontend has mounted.
pub fn handle_incoming_external_urls(app: &AppHandle, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    let state = app.state::<PendingExternalUrls>();
    let (events, live) = state.enqueue(urls);
    if live {
        if let Some(window) = app.get_webview_window("main") {
            for event in events {
                let _ = window.emit(EXTERNAL_URL_EVENT, &event);
            }
        } else {
            for event in events {
                let _ = app.emit(EXTERNAL_URL_EVENT, &event);
            }
        }
    }
}

#[cfg(windows)]
mod win_impl {
    use super::*;
    use std::path::PathBuf;
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR},
            System::Registry::{
                RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegDeleteValueW, RegOpenKeyExW,
                RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE,
                KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE,
            },
            UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST},
        },
    };

    const MAX_REG_SZ_BYTES: u32 = 4096;

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn win_err(context: &str, code: WIN32_ERROR) -> String {
        format!("{context} (Win32 error {})", code.0)
    }

    fn current_exe_display_path() -> Result<(String, String), String> {
        let exe = std::env::current_exe()
            .map_err(|err| format!("Failed to locate application executable: {err}"))?;
        let cleaned: PathBuf = crate::cli_compatible_windows_path(&exe);
        let full = cleaned.to_string_lossy().into_owned();
        if full.is_empty() {
            return Err("Application executable path is empty".to_owned());
        }
        let filename = cleaned
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("aliasmode.exe")
            .to_owned();
        Ok((full, filename))
    }

    fn read_hkcu_sz(subkey: &str, value_name: Option<&str>) -> Option<String> {
        let wide_subkey = to_wide(subkey);
        let wide_name = value_name.map(to_wide);
        let name_ptr = wide_name
            .as_ref()
            .map_or(PCWSTR::null(), |buf| PCWSTR(buf.as_ptr()));
        let mut key = HKEY::default();
        let opened = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(wide_subkey.as_ptr()),
                None,
                KEY_QUERY_VALUE,
                &mut key,
            )
        };
        if opened != ERROR_SUCCESS {
            return None;
        }
        let mut kind = REG_VALUE_TYPE(0);
        let mut size = 0u32;
        let query_len = unsafe {
            RegQueryValueExW(key, name_ptr, None, Some(&mut kind), None, Some(&mut size))
        };
        if query_len != ERROR_SUCCESS || kind != REG_SZ || size == 0 || size > MAX_REG_SZ_BYTES {
            unsafe {
                let _ = RegCloseKey(key);
            }
            return None;
        }
        let mut bytes = vec![0u8; size as usize];
        let query = unsafe {
            RegQueryValueExW(
                key,
                name_ptr,
                None,
                Some(&mut kind),
                Some(bytes.as_mut_ptr()),
                Some(&mut size),
            )
        };
        unsafe {
            let _ = RegCloseKey(key);
        }
        if query != ERROR_SUCCESS || kind != REG_SZ {
            return None;
        }
        let units: Vec<u16> = bytes[..size as usize]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|&u| u != 0)
            .collect();
        Some(String::from_utf16_lossy(&units))
    }

    fn write_hkcu_sz(subkey: &str, value_name: Option<&str>, value: &str) -> Result<(), String> {
        let wide_subkey = to_wide(subkey);
        let mut key = HKEY::default();
        let created = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(wide_subkey.as_ptr()),
                None,
                None,
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE | KEY_QUERY_VALUE,
                None,
                &mut key,
                None,
            )
        };
        if created != ERROR_SUCCESS {
            return Err(win_err(
                &format!("Failed to open registry key HKCU\\{subkey}"),
                created,
            ));
        }

        let wide_name = value_name.map(to_wide);
        let name_ptr = wide_name
            .as_ref()
            .map_or(PCWSTR::null(), |buf| PCWSTR(buf.as_ptr()));
        let wide_val = to_wide(value);
        let bytes: Vec<u8> = wide_val.iter().flat_map(|u| u.to_le_bytes()).collect();
        let written = unsafe { RegSetValueExW(key, name_ptr, None, REG_SZ, Some(&bytes)) };
        unsafe {
            let _ = RegCloseKey(key);
        }
        if written != ERROR_SUCCESS {
            return Err(win_err(
                &format!("Failed to write registry value under HKCU\\{subkey}"),
                written,
            ));
        }
        Ok(())
    }

    fn delete_hkcu_value(subkey: &str, value_name: &str) -> Result<(), String> {
        let wide_subkey = to_wide(subkey);
        let mut key = HKEY::default();
        let opened = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(wide_subkey.as_ptr()),
                None,
                KEY_SET_VALUE,
                &mut key,
            )
        };
        if opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND {
            return Ok(());
        }
        if opened != ERROR_SUCCESS {
            return Err(win_err(
                &format!("Failed to open registry key HKCU\\{subkey}"),
                opened,
            ));
        }
        let wide_name = to_wide(value_name);
        let deleted = unsafe { RegDeleteValueW(key, PCWSTR(wide_name.as_ptr())) };
        unsafe {
            let _ = RegCloseKey(key);
        }
        if deleted == ERROR_SUCCESS || deleted == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(win_err(
                &format!("Failed to delete value {value_name} from HKCU\\{subkey}"),
                deleted,
            ))
        }
    }

    fn delete_hkcu_tree(subkey: &str) -> Result<(), String> {
        let wide_subkey = to_wide(subkey);
        let deleted = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(wide_subkey.as_ptr())) };
        if deleted == ERROR_SUCCESS
            || deleted == ERROR_FILE_NOT_FOUND
            || deleted == ERROR_PATH_NOT_FOUND
        {
            Ok(())
        } else {
            Err(win_err(
                &format!("Failed to delete registry key HKCU\\{subkey}"),
                deleted,
            ))
        }
    }

    fn read_scheme_user_choice(scheme: &str) -> Option<String> {
        let latest = format!(
            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\{scheme}\UserChoiceLatest\ProgId"
        );
        if let Some(prog_id) = read_hkcu_sz(&latest, Some("ProgId")) {
            if !prog_id.trim().is_empty() {
                return Some(prog_id);
            }
        }
        let legacy = format!(
            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\{scheme}\UserChoice"
        );
        read_hkcu_sz(&legacy, Some("ProgId")).filter(|value| !value.trim().is_empty())
    }

    pub fn query_status() -> Result<DefaultBrowserStatus, String> {
        let exe_path = current_exe_display_path().ok().map(|(full, _)| full);
        let reg_cap = read_hkcu_sz(
            r"Software\RegisteredApplications",
            Some(REGISTERED_APP_NAME),
        );
        let registered = reg_cap
            .as_deref()
            .is_some_and(|val| val.eq_ignore_ascii_case(CAPABILITIES_PATH))
            && read_hkcu_sz(
                &format!(r"{CAPABILITIES_PATH}\URLAssociations"),
                Some("https"),
            )
            .as_deref()
            .is_some_and(|val| val.eq_ignore_ascii_case(PROG_ID_URL));

        let open_cmd = read_hkcu_sz(
            &format!(r"Software\Classes\{PROG_ID_URL}\shell\open\command"),
            None,
        );
        let registration_current = registered
            && exe_path.as_deref().is_some_and(|exe| {
                open_cmd
                    .as_deref()
                    .is_some_and(|cmd| cmd.eq_ignore_ascii_case(&build_open_command(exe)))
            });

        let current_http_prog_id = read_scheme_user_choice("http");
        let current_https_prog_id = read_scheme_user_choice("https");
        let is_default_http = prog_id_matches_maobu(current_http_prog_id.as_deref());
        let is_default_https = prog_id_matches_maobu(current_https_prog_id.as_deref());

        Ok(DefaultBrowserStatus {
            supported: true,
            registered,
            registration_current,
            is_default_http,
            is_default_https,
            is_default: is_default_http && is_default_https,
            current_http_prog_id,
            current_https_prog_id,
            exe_path,
        })
    }

    pub fn register_current_user() -> Result<DefaultBrowserStatus, String> {
        let (exe_path, exe_filename) = current_exe_display_path()?;
        let open_cmd = build_open_command(&exe_path);
        let launch_cmd = build_direct_launch_command(&exe_path);
        let icon_value = build_icon_value(&exe_path);

        let start_menu_root = format!(r"Software\Clients\StartMenuInternet\{REGISTERED_APP_NAME}");
        write_hkcu_sz(
            r"Software\RegisteredApplications",
            Some(REGISTERED_APP_NAME),
            CAPABILITIES_PATH,
        )?;
        write_hkcu_sz(&start_menu_root, None, APP_DISPLAY_NAME)?;
        write_hkcu_sz(
            &format!(r"{start_menu_root}\DefaultIcon"),
            None,
            &icon_value,
        )?;
        write_hkcu_sz(
            &format!(r"{start_menu_root}\shell\open\command"),
            None,
            &launch_cmd,
        )?;
        write_hkcu_sz(CAPABILITIES_PATH, Some("ApplicationName"), APP_DISPLAY_NAME)?;
        write_hkcu_sz(
            CAPABILITIES_PATH,
            Some("ApplicationDescription"),
            APP_DESCRIPTION,
        )?;
        write_hkcu_sz(CAPABILITIES_PATH, Some("ApplicationIcon"), &icon_value)?;
        write_hkcu_sz(
            &format!(r"{CAPABILITIES_PATH}\Startmenu"),
            Some("StartMenuInternet"),
            REGISTERED_APP_NAME,
        )?;
        write_hkcu_sz(
            &format!(r"{CAPABILITIES_PATH}\URLAssociations"),
            Some("http"),
            PROG_ID_URL,
        )?;
        write_hkcu_sz(
            &format!(r"{CAPABILITIES_PATH}\URLAssociations"),
            Some("https"),
            PROG_ID_URL,
        )?;
        write_hkcu_sz(
            &format!(r"{CAPABILITIES_PATH}\FileAssociations"),
            Some(".htm"),
            PROG_ID_HTML,
        )?;
        write_hkcu_sz(
            &format!(r"{CAPABILITIES_PATH}\FileAssociations"),
            Some(".html"),
            PROG_ID_HTML,
        )?;

        let url_class = format!(r"Software\Classes\{PROG_ID_URL}");
        write_hkcu_sz(&url_class, None, "猫步·千境 URL")?;
        write_hkcu_sz(&url_class, Some("URL Protocol"), "")?;
        write_hkcu_sz(&format!(r"{url_class}\DefaultIcon"), None, &icon_value)?;
        write_hkcu_sz(&format!(r"{url_class}\shell\open\command"), None, &open_cmd)?;

        let html_class = format!(r"Software\Classes\{PROG_ID_HTML}");
        write_hkcu_sz(&html_class, None, "猫步·千境 HTML Document")?;
        write_hkcu_sz(&format!(r"{html_class}\DefaultIcon"), None, &icon_value)?;
        write_hkcu_sz(
            &format!(r"{html_class}\shell\open\command"),
            None,
            &open_cmd,
        )?;

        let app_class = format!(r"Software\Classes\Applications\{exe_filename}");
        write_hkcu_sz(&app_class, Some("FriendlyAppName"), APP_DISPLAY_NAME)?;
        write_hkcu_sz(&format!(r"{app_class}\shell\open\command"), None, &open_cmd)?;

        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
        query_status()
    }

    pub fn unregister_current_user() -> Result<DefaultBrowserStatus, String> {
        delete_hkcu_value(r"Software\RegisteredApplications", REGISTERED_APP_NAME)?;
        delete_hkcu_tree(&format!(
            r"Software\Clients\StartMenuInternet\{REGISTERED_APP_NAME}"
        ))?;
        delete_hkcu_tree(&format!(r"Software\Classes\{PROG_ID_URL}"))?;
        delete_hkcu_tree(&format!(r"Software\Classes\{PROG_ID_HTML}"))?;
        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
        query_status()
    }
}

#[cfg(not(windows))]
mod win_impl {
    use super::*;

    pub fn query_status() -> Result<DefaultBrowserStatus, String> {
        Ok(DefaultBrowserStatus {
            supported: false,
            registered: false,
            registration_current: false,
            is_default_http: false,
            is_default_https: false,
            is_default: false,
            current_http_prog_id: None,
            current_https_prog_id: None,
            exe_path: std::env::current_exe()
                .ok()
                .map(|p| p.to_string_lossy().into_owned()),
        })
    }

    pub fn register_current_user() -> Result<DefaultBrowserStatus, String> {
        Err("Setting as system default browser is currently supported only on Windows.".to_owned())
    }

    pub fn unregister_current_user() -> Result<DefaultBrowserStatus, String> {
        Err("Setting as system default browser is currently supported only on Windows.".to_owned())
    }
}

#[tauri::command]
pub fn default_browser_status(
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
) -> Result<DefaultBrowserStatus, String> {
    crate::credentials::authorize(&window, &origin)?;
    win_impl::query_status()
}

#[tauri::command]
pub fn default_browser_register(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
) -> Result<DefaultBrowserStatus, String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    win_impl::register_current_user()
}

#[tauri::command]
#[allow(deprecated)] // Open Windows Default Apps settings without exposing generic shell access to JS.
pub fn default_browser_open_settings(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
) -> Result<(), String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    #[cfg(windows)]
    {
        let deep_link = format!("ms-settings:defaultapps?registeredAppUser={REGISTERED_APP_NAME}");
        if app.shell().open(deep_link, None).is_ok() {
            return Ok(());
        }
        app.shell()
            .open("ms-settings:defaultapps", None)
            .map_err(|_| "Could not open Windows Default Apps settings.".to_owned())
    }
    #[cfg(not(windows))]
    {
        Err("Opening Windows Default Apps settings is supported only on Windows.".to_owned())
    }
}

#[tauri::command]
pub fn default_browser_unregister(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
) -> Result<DefaultBrowserStatus, String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    win_impl::unregister_current_user()
}

#[tauri::command]
pub fn default_browser_take_pending_urls(
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    pending: tauri::State<'_, PendingExternalUrls>,
) -> Result<Vec<ExternalUrlEvent>, String> {
    crate::credentials::authorize(&window, &origin)?;
    Ok(pending.take_pending())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_safe_http_and_https_urls() {
        assert_eq!(
            parse_external_http_url("https://example.com/path?a=1#frag").as_deref(),
            Some("https://example.com/path?a=1#frag")
        );
        assert_eq!(
            parse_external_http_url("  http://localhost:8080/login ").as_deref(),
            Some("http://localhost:8080/login")
        );
        for rejected in [
            "",
            "   ",
            "--background",
            "-flag",
            "javascript:alert(1)",
            "file:///C:/secret.html",
            "data:text/html,hi",
            "mailto:user@example.com",
            "https://example.com/\nline",
            "not a url",
        ] {
            assert_eq!(
                parse_external_http_url(rejected),
                None,
                "expected reject for {rejected}"
            );
        }
        let oversized = format!("https://example.com/{}", "a".repeat(MAX_EXTERNAL_URL_LEN));
        assert_eq!(parse_external_http_url(&oversized), None);
    }

    #[test]
    fn extracts_external_urls_skipping_exe_flags_and_consecutive_dupes() {
        let extracted = extract_external_urls([
            r"C:\Program Files\Maobu\aliasmode.exe",
            "--background",
            "https://github.com/maobukeai",
            "https://github.com/maobukeai",
            "javascript:alert(1)",
            "http://example.org/docs",
        ]);
        assert_eq!(
            extracted,
            vec![
                "https://github.com/maobukeai".to_owned(),
                "http://example.org/docs".to_owned(),
            ]
        );
    }

    #[test]
    fn formats_registry_commands_and_matches_prog_ids() {
        assert_eq!(
            build_open_command(r"C:\Apps\猫步\aliasmode.exe"),
            "\"C:\\Apps\\猫步\\aliasmode.exe\" \"%1\""
        );
        assert_eq!(
            build_icon_value(r"C:\Apps\猫步\aliasmode.exe"),
            r"C:\Apps\猫步\aliasmode.exe,0"
        );
        assert!(prog_id_matches_maobu(Some("MaobuBrowserURL")));
        assert!(prog_id_matches_maobu(Some("maobubrowserhtml")));
        assert!(!prog_id_matches_maobu(Some("MSEdgeHTM")));
        assert!(!prog_id_matches_maobu(None));
    }

    #[test]
    fn pending_queue_buffers_until_taken_then_switches_to_live_emit() {
        let state = PendingExternalUrls::default();
        let (first_events, live_before_take) = state.enqueue(vec!["https://a.example/".to_owned()]);
        assert!(!live_before_take);
        assert_eq!(first_events.len(), 1);
        assert_eq!(first_events[0].id, 1);

        let drained = state.take_pending();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].url, "https://a.example/");
        assert!(state.take_pending().is_empty());

        let (second_events, live_after_take) = state.enqueue(vec!["https://b.example/".to_owned()]);
        assert!(live_after_take);
        assert_eq!(second_events[0].id, 2);
        assert!(state.take_pending().is_empty());
    }
}
