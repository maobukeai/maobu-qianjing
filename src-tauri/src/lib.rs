mod acceptance;
mod browser;
mod credentials;
mod default_browser;
mod desktop_close;
mod diagnostics;
mod external_resources;
mod runtime_descriptor;
mod shutdown;
mod sidecar;
mod signed_updates;
mod win32_layout;
mod win32_resources;
mod win32_sync;
mod win32_window_registry;
mod window_backdrop;
mod workspaces;

use credentials::CredentialOrigin;
use rand::random;
use std::{
    error::Error,
    ffi::{OsStr, OsString},
    fs, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc,
    },
};
use tauri::{
    ipc::CapabilityBuilder,
    webview::{NewWindowResponse, PageLoadEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(crate) const DESKTOP_SESSION_HEADER: &str = "X-Maobu-Desktop-Session";
pub(crate) struct DesktopDashboardSession(zeroize::Zeroizing<String>);

const IMPORT_RESTRICTION: &str = "Windows DPAPI protects persisted browser secrets, so this import works only for the same Windows machine and account. Persisted persona fields are preserved, but runtime or browser differences can change the account-visible fingerprint.";

const WINDOWS_ACCEPTANCE_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

fn windows_acceptance_browser_args(enabled: bool, debug_port: Option<&str>) -> Option<String> {
    windows_acceptance_browser_args_for_build(cfg!(debug_assertions), enabled, debug_port)
}

fn windows_acceptance_browser_args_for_build(
    debug_build: bool,
    enabled: bool,
    debug_port: Option<&str>,
) -> Option<String> {
    if !debug_build || !enabled {
        return None;
    }
    let debug_port = debug_port.unwrap_or("0").parse::<u16>().ok()?;
    Some(format!(
        "{WINDOWS_ACCEPTANCE_BROWSER_ARGS} --remote-debugging-port={debug_port}"
    ))
}

fn trusted_loopback_capability(port: u16) -> CapabilityBuilder {
    let capability = CapabilityBuilder::new(format!("loopback-{port}"))
        .local(false)
        .window("main")
        .remote(format!("http://127.0.0.1:{port}/*"))
        .permission("allow-credential-bridge")
        .permission("allow-workspace-management")
        .permission("allow-runtime-ready")
        .permission("allow-script-capability")
        .permission("allow-signed-updates")
        .permission("allow-external-resources");
    let capability = capability
        .permission("allow-desktop-close")
        .permission("allow-window-backdrop")
        .permission("allow-window-control")
        .permission("allow-system-diagnostics")
        .permission("allow-default-browser")
        .permission("core:event:allow-listen")
        .permission("core:event:allow-unlisten");
    #[cfg(windows)]
    let capability = capability
        .permission("core:window:allow-is-maximized")
        .permission("core:window:allow-minimize")
        .permission("core:window:allow-toggle-maximize")
        .permission("core:window:allow-start-dragging")
        .permission("core:window:allow-close")
        .permission("core:window:allow-is-focused");
    capability
}

use std::sync::{Mutex, Once};

static PANIC_HOOK_ONCE: Once = Once::new();
static PANIC_LOG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
const MAX_PANIC_MESSAGE_CHARS: usize = 512;
const MAX_PANIC_LOG_BYTES: u64 = 1024 * 1024;

fn set_panic_log_dir(dir: PathBuf) {
    if let Ok(mut guard) = PANIC_LOG_DIR.lock() {
        *guard = Some(dir);
    }
}

fn sanitize_panic_message(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let mut words = Vec::new();
    let mut redact_next = false;
    for token in cleaned.split_whitespace() {
        if redact_next {
            words.push("[REDACTED]".to_owned());
            redact_next = false;
            continue;
        }
        let lower = token.to_ascii_lowercase();
        if lower == "bearer" {
            words.push(token.to_owned());
            redact_next = true;
            continue;
        }
        if let Some(eq_pos) = token.find('=') {
            let key = &lower[..eq_pos];
            if [
                "password",
                "passwd",
                "token",
                "secret",
                "nonce",
                "apikey",
                "api_key",
                "authorization",
                "x-maobu-desktop-session",
                "session",
            ]
            .iter()
            .any(|sensitive| key.ends_with(sensitive))
            {
                let prefix = &token[..=eq_pos];
                words.push(format!("{prefix}[REDACTED]"));
                continue;
            }
        }
        let trimmed = token.trim_matches(|ch: char| !ch.is_ascii_alphanumeric());
        if trimmed.len() >= 32 && trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            words.push("[REDACTED_HEX]".to_owned());
            continue;
        }
        words.push(token.to_owned());
    }
    let joined = words.join(" ");
    if joined.chars().count() <= MAX_PANIC_MESSAGE_CHARS {
        joined
    } else {
        let mut truncated: String = joined.chars().take(MAX_PANIC_MESSAGE_CHARS).collect();
        truncated.push_str("...");
        truncated
    }
}

fn format_panic_record(location: Option<(&str, u32, u32)>, raw_message: &str) -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let loc = match location {
        Some((file, line, column)) => format!("{file}:{line}:{column}"),
        None => "<unknown>".to_owned(),
    };
    let message = sanitize_panic_message(raw_message);
    format!("[maobu-desktop panic ts={timestamp}] location={loc} message={message}")
}

fn is_reparse_or_symlink(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    false
}

fn write_panic_log_line(dir: &Path, line: &str) {
    if is_reparse_or_symlink(dir) {
        return;
    }
    if fs::create_dir_all(dir).is_err() || is_reparse_or_symlink(dir) {
        return;
    }
    let log_path = dir.join("desktop-panic.log");
    if is_reparse_or_symlink(&log_path) {
        return;
    }
    if let Ok(metadata) = fs::symlink_metadata(&log_path) {
        if !metadata.is_file() || metadata.len() >= MAX_PANIC_LOG_BYTES {
            return;
        }
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(&log_path) {
        let _ = io::Write::write_all(&mut file, format!("{line}\n").as_bytes());
        let _ = io::Write::flush(&mut file);
    }
}

fn install_panic_hook() {
    PANIC_HOOK_ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let location = info
                .location()
                .map(|location| (location.file(), location.line(), location.column()));
            let raw_message = if let Some(text) = info.payload().downcast_ref::<&str>() {
                *text
            } else if let Some(text) = info.payload().downcast_ref::<String>() {
                text.as_str()
            } else {
                "non-string panic payload"
            };
            let line = format_panic_record(location, raw_message);
            let _ = io::Write::write_all(&mut io::stderr(), format!("{line}\n").as_bytes());
            if let Ok(guard) = PANIC_LOG_DIR.try_lock() {
                if let Some(dir) = guard.as_ref() {
                    write_panic_log_line(dir, &line);
                }
            }
        }));
    });
}

#[derive(Default)]
struct RevealRequested(AtomicBool);

fn boxed(error: impl Into<String>) -> Box<dyn Error> {
    io::Error::other(error.into()).into()
}

#[cfg(windows)]
fn present_startup_failure(error: &tauri::Error) {
    use windows::{
        core::{w, PCWSTR},
        Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND},
    };
    let message = format!(
        "请先尝试重新启动。如果安装资源缺失，可重新运行可信的安装包。若提示工作区数据异常，请先备份数据目录再处理。\n\n错误详情：{error}"
    );
    let text: Vec<u16> = message
        .replace('\0', " ")
        .encode_utf16()
        .chain([0])
        .collect();
    // The event loop may not exist yet, so use a native dialog independent of WebView2.
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(text.as_ptr()),
            w!("无法启动猫步·千境"),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }
}

struct StartupCleanup<F: FnOnce()> {
    cleanup: Option<F>,
}

impl<F: FnOnce()> StartupCleanup<F> {
    fn new(cleanup: F) -> Self {
        Self {
            cleanup: Some(cleanup),
        }
    }

    fn disarm(&mut self) {
        let _ = self.cleanup.take();
    }
}

impl<F: FnOnce()> Drop for StartupCleanup<F> {
    fn drop(&mut self) {
        if let Some(cleanup) = self.cleanup.take() {
            cleanup();
        }
    }
}

fn background_requested<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .any(|arg| arg.as_ref() == OsStr::new("--background"))
}

fn packaged_node_package_version(root: &Path, package: &str) -> Result<String, Box<dyn Error>> {
    let manifest = package
        .split('/')
        .fold(root.join("node_modules"), |path, segment| {
            path.join(segment)
        })
        .join("package.json");
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).map_err(|error| {
            boxed(format!(
                "packaged agent dependency is unavailable: {package}: {error}"
            ))
        })?)?;
    value
        .get("version")
        .and_then(|version| version.as_str())
        .map(str::to_owned)
        .ok_or_else(|| {
            boxed(format!(
                "packaged agent dependency has no version: {package}"
            ))
        })
}

fn cli_compatible_windows_path(path: &Path) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();
    text.strip_prefix(r"\\?\UNC\")
        .map(|path| PathBuf::from(format!(r"\\{path}")))
        .or_else(|| text.strip_prefix(r"\\?\").map(PathBuf::from))
        .unwrap_or_else(|| path.to_path_buf())
}

#[derive(Debug, PartialEq)]
struct CloakpitImportRequest {
    source: Option<PathBuf>,
    profile_root: Option<PathBuf>,
}

fn parse_cloakpit_import_args(
    args: impl IntoIterator<Item = OsString>,
) -> Result<Option<CloakpitImportRequest>, String> {
    let args: Vec<OsString> = args.into_iter().collect();
    let marker = OsString::from("--import-cloakpit");
    let Some(index) = args.iter().position(|arg| arg == &marker) else {
        return Ok(None);
    };
    if args[..index].iter().any(|arg| !arg.is_empty()) {
        return Err("--import-cloakpit cannot be combined with other arguments".to_owned());
    }
    let mut source = None;
    let mut profile_root = None;
    let mut cursor = index + 1;
    while cursor < args.len() {
        if args[cursor] == "--cloakpit-profile-root" {
            cursor += 1;
            let value = args
                .get(cursor)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "--cloakpit-profile-root requires a directory".to_owned())?;
            if profile_root.replace(PathBuf::from(value)).is_some() {
                return Err("--cloakpit-profile-root was provided more than once".to_owned());
            }
        } else if args[cursor].to_string_lossy().starts_with("--") {
            return Err(format!(
                "unknown import option: {}",
                args[cursor].to_string_lossy()
            ));
        } else if source.replace(PathBuf::from(&args[cursor])).is_some() {
            return Err("only one Cloakpit source directory can be imported".to_owned());
        }
        cursor += 1;
    }
    Ok(Some(CloakpitImportRequest {
        source,
        profile_root,
    }))
}

fn present_import_result(app: &tauri::AppHandle, ok: bool, message: &str) {
    app.dialog()
        .message(message)
        .title(if ok {
            "Cloakpit import complete"
        } else {
            "Cloakpit import failed"
        })
        .kind(if ok {
            MessageDialogKind::Info
        } else {
            MessageDialogKind::Error
        })
        .buttons(MessageDialogButtons::Ok)
        .blocking_show();
}

#[cfg(test)]
mod tests {
    use super::{
        background_requested, cli_compatible_windows_path, parse_cloakpit_import_args,
        trusted_loopback_capability, windows_acceptance_browser_args,
        windows_acceptance_browser_args_for_build, CloakpitImportRequest, StartupCleanup,
    };
    use std::{
        cell::Cell,
        ffi::OsString,
        path::{Path, PathBuf},
    };
    use tauri::{ipc::RuntimeCapability, utils::acl::capability::CapabilityFile};

    #[test]
    fn titlebar_capability_stays_bound_to_the_verified_main_origin() {
        let CapabilityFile::Capability(capability) = trusted_loopback_capability(50401).build()
        else {
            panic!("one desktop capability is required");
        };
        assert!(!capability.local);
        assert_eq!(capability.windows, ["main"]);
        assert!(capability.webviews.is_empty());
        assert_eq!(
            capability.remote.unwrap().urls,
            ["http://127.0.0.1:50401/*"]
        );
        let permissions = serde_json::to_value(capability.permissions).unwrap();
        let permissions = permissions.as_array().unwrap();
        assert!(permissions
            .iter()
            .any(|permission| permission == "allow-signed-updates"));
        assert!(permissions
            .iter()
            .any(|permission| permission == "allow-external-resources"));
        assert!(permissions
            .iter()
            .any(|permission| permission == "allow-desktop-close"));
        assert!(permissions
            .iter()
            .any(|permission| permission == "allow-window-backdrop"));
        assert!(permissions
            .iter()
            .any(|permission| permission == "allow-window-control"));
        assert!(permissions
            .iter()
            .any(|permission| permission == "allow-system-diagnostics"));
        assert!(permissions
            .iter()
            .any(|permission| permission == "allow-default-browser"));
        assert!(!permissions.iter().any(|permission| permission
            .as_str()
            .is_some_and(|value| value.starts_with("shell:"))));
        assert!(!permissions.iter().any(|permission| permission
            .as_str()
            .is_some_and(|value| value.starts_with("updater:"))));
        #[cfg(windows)]
        {
            assert_eq!(permissions.len(), 19);
            for permission in [
                "core:window:allow-is-maximized",
                "core:window:allow-minimize",
                "core:window:allow-toggle-maximize",
                "core:window:allow-start-dragging",
                "core:window:allow-close",
                "core:window:allow-is-focused",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
            ] {
                assert!(permissions.iter().any(|entry| entry == permission));
            }
        }
        #[cfg(not(windows))]
        assert_eq!(permissions.len(), 13);
        assert!(!permissions.iter().any(|permission| {
            permission.as_str().is_some_and(|permission| {
                permission.ends_with(":default")
                    || permission.ends_with("allow-destroy")
                    || permission.ends_with("allow-exit")
                    || permission.ends_with("allow-emit")
                    || permission.ends_with("allow-create")
            })
        }));
    }

    #[test]
    fn startup_cleanup_runs_only_while_armed() {
        let cleaned = Cell::new(0);
        {
            let _guard = StartupCleanup::new(|| cleaned.set(cleaned.get() + 1));
        }
        assert_eq!(cleaned.get(), 1);

        {
            let mut guard = StartupCleanup::new(|| cleaned.set(cleaned.get() + 1));
            guard.disarm();
        }
        assert_eq!(cleaned.get(), 1);
    }

    #[test]
    fn recognizes_only_the_explicit_background_switch() {
        assert!(background_requested(["aliasmode.exe", "--background"]));
        assert!(!background_requested([
            "aliasmode.exe",
            "--background-worker"
        ]));
        assert!(!background_requested(["aliasmode.exe"]));
    }

    #[test]
    fn enables_webview_debugging_only_for_acceptance() {
        assert_eq!(windows_acceptance_browser_args(false, Some("50401")), None);
        assert_eq!(
            windows_acceptance_browser_args_for_build(true, true, None),
            Some("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=0".to_owned()),
        );
        assert_eq!(
            windows_acceptance_browser_args_for_build(true, true, Some("50401")),
            Some("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=50401".to_owned()),
        );
        assert_eq!(
            windows_acceptance_browser_args(true, Some("50401")),
            windows_acceptance_browser_args_for_build(cfg!(debug_assertions), true, Some("50401")),
        );
    }

    #[test]
    fn webview_debugging_is_rejected_by_release_policy_even_when_requested() {
        for enabled in [false, true] {
            for port in [None, Some("0"), Some("50401"), Some("65535")] {
                assert_eq!(
                    windows_acceptance_browser_args_for_build(false, enabled, port),
                    None
                );
            }
        }
        for port in ["-1", "65536", "50401 --remote-debugging-pipe", "invalid"] {
            assert_eq!(
                windows_acceptance_browser_args_for_build(true, true, Some(port)),
                None
            );
        }
    }

    #[test]
    fn removes_windows_namespace_prefix_before_cli_use() {
        assert_eq!(
            cli_compatible_windows_path(Path::new(r"\\?\C:\Users\Maobu\playwright")),
            PathBuf::from(r"C:\Users\Maobu\playwright"),
        );
        assert_eq!(
            cli_compatible_windows_path(Path::new(r"\\?\UNC\server\share\playwright")),
            PathBuf::from(r"\\server\share\playwright"),
        );
    }

    #[test]
    fn parses_installed_cloakpit_import_arguments() {
        let args = [
            "--import-cloakpit",
            r"C:\Cloakpit",
            "--cloakpit-profile-root",
            r"D:\Legacy\profiles",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_cloakpit_import_args(args).unwrap(),
            Some(CloakpitImportRequest {
                source: Some(PathBuf::from(r"C:\Cloakpit")),
                profile_root: Some(PathBuf::from(r"D:\Legacy\profiles")),
            }),
        );
        assert_eq!(
            parse_cloakpit_import_args([OsString::from("--import-cloakpit")]).unwrap(),
            Some(CloakpitImportRequest {
                source: None,
                profile_root: None
            }),
        );
        assert!(parse_cloakpit_import_args(
            ["--import-cloakpit", "one", "two"].map(OsString::from)
        )
        .is_err());
        assert_eq!(
            parse_cloakpit_import_args(Vec::<OsString>::new()).unwrap(),
            None
        );
    }

    #[test]
    fn panic_formatter_redacts_secrets_and_bounds_length() {
        let secret_hex = "a".repeat(64);
        let raw = format!(
            "failed request\nBearer secret-jwt-token password=hunter2 token=abc {secret_hex}"
        );
        let record = super::format_panic_record(Some(("src/lib.rs", 42, 7)), &raw);
        assert!(record.contains("location=src/lib.rs:42:7"));
        assert!(!record.contains("secret-jwt-token"));
        assert!(!record.contains("hunter2"));
        assert!(!record.contains("abc"));
        assert!(!record.contains(&secret_hex));
        assert!(!record.contains('\n'));
        assert!(record.contains("Bearer [REDACTED]"));
        assert!(record.contains("password=[REDACTED]"));
        assert!(record.contains("token=[REDACTED]"));
        assert!(record.contains("[REDACTED_HEX]"));

        let long = "x".repeat(1000);
        let bounded = super::sanitize_panic_message(&long);
        assert!(bounded.len() <= super::MAX_PANIC_MESSAGE_CHARS + 3);
        assert!(bounded.ends_with("..."));
    }

    #[test]
    fn panic_log_writer_appends_safely_within_size_limit() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        super::write_panic_log_line(&logs, "line-one");
        super::write_panic_log_line(&logs, "line-two");
        let content = std::fs::read_to_string(logs.join("desktop-panic.log")).unwrap();
        assert_eq!(content, "line-one\nline-two\n");
    }
}

pub fn run() {
    install_panic_hook();
    // This must precede even plugin creation: the production singleton otherwise
    // forwards unknown QA arguments to an already running real desktop process.
    let (acceptance_mode, validation_only) = match acceptance::AcceptanceMode::preflight() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Native acceptance preflight failed: {error}");
            std::process::exit(2);
        }
    };
    if validation_only {
        return;
    }
    let isolated_acceptance = acceptance_mode.active();
    // WebKitGTK's DMA-BUF renderer shows an empty window with several graphics drivers
    // (NVIDIA in particular). The dashboard needs no GPU path.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    let startup_external_urls = default_browser::extract_external_urls(
        std::env::args_os().map(|arg| arg.to_string_lossy().into_owned()),
    );
    let background = startup_external_urls.is_empty() && background_requested(std::env::args_os());
    let pending_external_urls = default_browser::PendingExternalUrls::default();
    pending_external_urls.enqueue(startup_external_urls);
    let import_request = parse_cloakpit_import_args(std::env::args_os().skip(1));
    let builder = tauri::Builder::default()
        .manage(acceptance_mode)
        .manage(RevealRequested::default())
        .manage(pending_external_urls)
        .manage(Arc::new(shutdown::CloseState::default()))
        .manage(Arc::new(win32_sync::SyncController::new()))
        .manage(if isolated_acceptance {
            signed_updates::SignedUpdateState::for_acceptance()
        } else {
            signed_updates::SignedUpdateState::default()
        });
    // An acceptance root has its own exclusive lock; never contact the real app.
    let builder = if isolated_acceptance {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let external_urls =
                default_browser::extract_external_urls(argv.iter().map(String::as_str));
            if !external_urls.is_empty() {
                default_browser::handle_incoming_external_urls(app, external_urls);
            } else if background_requested(argv) {
                return;
            }
            app.state::<RevealRequested>()
                .0
                .store(true, Ordering::Release);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
    };
    let app = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            runtime_descriptor::agent_runtime_ready,
            runtime_descriptor::script_capability,
            shutdown::restart_after_mode_change,
            shutdown::restart_workspace,
            shutdown::desktop_close_register,
            shutdown::desktop_close_unregister,
            shutdown::desktop_close_resolve,
            workspaces::open_workspace_location,
            workspaces::export_workspace_backup,
            signed_updates::signed_update_status,
            signed_updates::signed_update_check,
            signed_updates::signed_update_install,
            external_resources::open_external_resource,
            default_browser::default_browser_status,
            default_browser::default_browser_register,
            default_browser::default_browser_open_settings,
            default_browser::default_browser_unregister,
            default_browser::default_browser_take_pending_urls,
            window_backdrop::set_window_theme,
            win32_layout::window_list_monitors,
            win32_window_registry::window_list_managed,
            win32_layout::window_arrange,
            win32_layout::window_action,
            win32_sync::sync_start,
            win32_sync::sync_stop,
            win32_sync::sync_pause,
            win32_sync::sync_update_slaves,
            win32_sync::sync_inject_texts,
            win32_sync::sync_status,
            win32_resources::system_trim_process_memory,
            diagnostics::system_diagnostic_probe,
        ])
        .setup(move |app| {
            if !isolated_acceptance {
                signed_updates::register(app.handle())?;
            }
            let acceptance_paths = app.state::<acceptance::AcceptanceMode>().paths.clone();
            let data_dir = match &acceptance_paths {
                Some(paths) => paths.backend_home.clone(),
                None => app.path().app_data_dir()?,
            };
            match import_request {
                Err(error) => {
                    present_import_result(
                        app.handle(),
                        false,
                        &format!("{error}. {IMPORT_RESTRICTION}"),
                    );
                    app.handle().exit(1);
                    return Ok(());
                }
                Ok(Some(request)) => {
                    let result = tauri::async_runtime::block_on(sidecar::run_import(
                        app.handle(),
                        &data_dir,
                        request.source.as_deref(),
                        request.profile_root.as_deref(),
                    ));
                    match result {
                        Ok(record) => {
                            present_import_result(app.handle(), record.ok, &record.message);
                            app.handle().exit(if record.ok { 0 } else { 1 });
                        }
                        Err(error) => {
                            present_import_result(
                                app.handle(),
                                false,
                                &format!("{error}. {IMPORT_RESTRICTION}"),
                            );
                            app.handle().exit(1);
                        }
                    }
                    return Ok(());
                }
                Ok(None) => {}
            }
            // Explicit legacy imports above retain their original global-home destination.
            // Normal startup resolves the catalog without rewriting it or falling back
            // from a damaged registered workspace to a fresh/default store.
            let workspace_home = data_dir;
            let active_workspace =
                workspaces::resolve_active_workspace(&workspace_home).map_err(boxed)?;
            let data_dir = active_workspace.root.clone();
            set_panic_log_dir(data_dir.join("logs"));
            app.manage(workspaces::WorkspaceRuntime {
                home: workspace_home.clone(),
                active: active_workspace.clone(),
            });
            fs::create_dir_all(data_dir.join("profiles"))?;
            fs::create_dir_all(data_dir.join("inbox"))?;

            let resource_dir = app.path().resource_dir()?;
            let mut firefox = browser::verify_firefox_resource(&resource_dir).map_err(boxed)?;
            if let Some(firefox) = firefox.as_mut() {
                firefox.executable = cli_compatible_windows_path(&firefox.executable);
            }
            let playwright_runtime = cli_compatible_windows_path(
                &resource_dir
                    .join("playwright")
                    .canonicalize()
                    .map_err(|error| {
                        boxed(format!(
                            "packaged Playwright runtime is unavailable: {error}"
                        ))
                    })?,
            );
            let playwright_manifest = playwright_runtime
                .join("node_modules")
                .join("playwright-core")
                .join("package.json");
            let node_executable = playwright_runtime.join("node").join(if cfg!(windows) {
                "node.exe"
            } else {
                "node"
            });
            let worker_script = playwright_runtime.join("worker.mjs");
            let firefox_worker_script = playwright_runtime.join("firefox-worker.mjs");
            let playwright_worker_script = playwright_runtime.join("playwright-worker.mjs");
            let agent_root = playwright_runtime.join("agent");
            if !playwright_manifest.is_file()
                || !node_executable.is_file()
                || !worker_script.is_file()
                || !firefox_worker_script.is_file()
                || !playwright_worker_script.is_file()
                || !agent_root.join("mcp-host.mjs").is_file()
                || !agent_root.join("mcp-scope.mjs").is_file()
                || !agent_root.join("playwright-proxy.mjs").is_file()
                || !agent_root.join("playwright-runner.mjs").is_file()
                || !agent_root.join("script-recorder.mjs").is_file()
                || !agent_root.join("runtime-client.mjs").is_file()
            {
                return Err(boxed("packaged Playwright and MCP runtime is incomplete"));
            }
            for (package, expected) in [
                ("playwright-core", "1.58.2"),
                ("@modelcontextprotocol/sdk", "1.30.0"),
                ("@playwright/mcp", "0.0.56"),
                ("playwright", "1.58.0-alpha-2026-01-16"),
            ] {
                if packaged_node_package_version(&playwright_runtime, package)? != expected {
                    return Err(boxed(format!(
                        "packaged agent dependency version mismatch: {package}"
                    )));
                }
            }
            if !cfg!(dev) {
                let helper = std::env::current_exe()?
                    .parent()
                    .ok_or_else(|| boxed("猫步·千境安装目录不可用"))?
                    .join(if cfg!(windows) {
                        "aliasmode-mcp.exe"
                    } else {
                        "aliasmode-mcp"
                    });
                if !helper.is_file() {
                    return Err(boxed("猫步·千境已安装的智能体辅助程序不可用"));
                }
            }
            let nonce = hex::encode(random::<[u8; 32]>());
            let agent_nonce = hex::encode(random::<[u8; 32]>());
            let dashboard_session = zeroize::Zeroizing::new(hex::encode(random::<[u8; 32]>()));
            let handle = app.handle().clone();
            let (sidecar, port) = tauri::async_runtime::block_on(sidecar::launch_and_verify(
                &handle,
                &data_dir,
                &workspace_home,
                &active_workspace.id,
                firefox.as_ref(),
                &playwright_runtime,
                &nonce,
                &agent_nonce,
                &dashboard_session,
                background,
            ))
            .map_err(boxed)?;
            let cleanup_sidecar = sidecar.clone();
            let mut startup_cleanup = StartupCleanup::new(move || {
                let _ = cleanup_sidecar.kill_owned();
            });

            let runtime_descriptor = runtime_descriptor::RuntimeDescriptorState::new(
                // MCP discovers the single desktop process at the stable global
                // home. Its port/nonce identify the active workspace's sidecar;
                // browser state and the startup health proof still use data_dir.
                &workspace_home,
                nonce,
                agent_nonce,
                port,
                sidecar.pid(),
            )
            .map_err(boxed)?;
            app.manage(runtime_descriptor);

            let origin = format!("http://127.0.0.1:{port}");
            app.manage(CredentialOrigin(origin.clone()));
            app.manage(sidecar.clone());
            if let Err(error) = app.add_capability(trusted_loopback_capability(port)) {
                return Err(error.into());
            }

            let allowed_port = port;
            let dashboard_script = format!(
                "({})({port}, \"{}\");",
                include_str!("dashboard-fetch.js"),
                dashboard_session.as_str()
            );
            app.manage(DesktopDashboardSession(dashboard_session));
            let url = format!("{origin}/")
                .parse()
                .map_err(|error| boxed(format!("invalid sidecar URL: {error}")))?;
            let backdrop = window_backdrop::probe_windows_backdrop(isolated_acceptance);
            let initial_dark = window_backdrop::initial_dark_mode();
            let webview_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .initialization_script(dashboard_script)
                .initialization_script(backdrop.init_script())
                .title(if isolated_acceptance {
                    "猫步·千境 · 隔离验收"
                } else {
                    "猫步·千境"
                })
                .visible(!background)
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .on_page_load(move |window, payload| {
                    if !matches!(payload.event(), PageLoadEvent::Finished) {
                        return;
                    }
                    let reveal_requested = window
                        .app_handle()
                        .state::<RevealRequested>()
                        .0
                        .load(Ordering::Acquire);
                    if background
                        && !reveal_requested
                        && (window.hide().is_err() || window.is_visible().unwrap_or(true))
                    {
                        window.app_handle().exit(1);
                        return;
                    }
                    let runtime = window
                        .app_handle()
                        .state::<runtime_descriptor::RuntimeDescriptorState>();
                    runtime.activate();
                    if runtime.publish("local").is_err() {
                        window.app_handle().exit(1);
                    }
                });
            let webview_builder = if let Some(paths) = &acceptance_paths {
                webview_builder
                    .data_directory(paths.webview_data.clone())
                    // Native UI acceptance must not write the user's Downloads folder.
                    .on_download(|_, _| false)
            } else {
                webview_builder
            };
            #[cfg(windows)]
            let webview_builder = webview_builder
                .decorations(false)
                .resizable(true)
                .shadow(true)
                // Appended to Tauri's existing document-start initialization.
                .initialization_script("window.__MAOBU_FRAMELESS__ = true;");
            #[cfg(windows)]
            let webview_builder = if backdrop != window_backdrop::BackdropKind::None {
                // Keep transparent(false) so tao/wry never fall back to CPU softbuffer;
                // only make WebView2's DefaultBackgroundColor transparent for DWM Mica.
                webview_builder.background_color(tauri::window::Color(0, 0, 0, 0))
            } else {
                webview_builder
            };
            #[cfg(windows)]
            let webview_builder = if isolated_acceptance {
                webview_builder
            } else if let Some(args) = windows_acceptance_browser_args(
                matches!(
                    std::env::var("ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG").as_deref(),
                    Ok("1")
                ),
                std::env::var("ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG_PORT")
                    .ok()
                    .as_deref(),
            ) {
                webview_builder.additional_browser_args(&args)
            } else {
                webview_builder
            };
            let window = match webview_builder
                .on_navigation(move |url| {
                    (url.scheme() == "http"
                        && url.host_str() == Some("127.0.0.1")
                        && url.port() == Some(allowed_port))
                        || ((url.scheme() == "https" || url.scheme() == "http")
                            && url.host_str() == Some("tauri.localhost"))
                        || (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()
            {
                Ok(window) => window,
                Err(error) => return Err(error.into()),
            };
            if backdrop != window_backdrop::BackdropKind::None {
                window_backdrop::apply_backdrop(&window, backdrop, initial_dark);
            }

            shutdown::install_close_handler(app.handle().clone(), window.clone(), sidecar, origin);
            if app.state::<RevealRequested>().0.load(Ordering::Acquire) {
                let _ = window.show();
                let _ = window.set_focus();
            } else if background {
                window.hide()?;
            }
            startup_cleanup.disarm();
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("猫步·千境桌面程序启动失败：{error}");
            #[cfg(windows)]
            if !isolated_acceptance {
                present_startup_failure(&error);
            }
            std::process::exit(1);
        }
    };

    let requested_exit_code = Arc::new(AtomicI32::new(0));
    let exit_code = Arc::clone(&requested_exit_code);
    app.run_return(move |app, event| match event {
        tauri::RunEvent::ExitRequested {
            code: Some(code), ..
        } => exit_code.store(code, Ordering::Release),
        tauri::RunEvent::Exit => {
            if let Some(sync) = app.try_state::<Arc<win32_sync::SyncController>>() {
                let _ = sync.emergency_stop("app_exit");
            }
            if let Some(runtime) = app.try_state::<runtime_descriptor::RuntimeDescriptorState>() {
                let _ = runtime.remove_owned();
            }
            if let Some(sidecar) = app.try_state::<sidecar::SidecarSupervisor>() {
                // Cmd+Q, the Dock's Quit and a Linux desktop session end the app without
                // a close request, so save sessions and close browsers here before the
                // sidecar stops.
                #[cfg(not(windows))]
                let _ = tauri::async_runtime::block_on(shutdown::graceful_sidecar_cleanup(
                    sidecar.inner(),
                ));
                let _ = sidecar.kill_owned();
            }
        }
        _ => {}
    });

    let exit_code = requested_exit_code.load(Ordering::Acquire);
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}
