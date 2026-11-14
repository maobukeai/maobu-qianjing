//! Explicit, debug-only native window acceptance. Never falls back to the real home.
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const PREFIX: &str = "maobu-native-acceptance-";
const MARKER: &str = "acceptance-marker.json";
const PROTOCOL: &str = "maobu-native-acceptance-v1";
#[cfg(debug_assertions)]
const DEBUG_BINARY_PROTOCOL: &str = "MAOBU_NATIVE_ACCEPTANCE_DEBUG_V1";
pub const RESTRICTED: &str =
    "原生隔离验收禁止更新、重启、外部打开及保存文件对话框。请在正式应用中执行此操作。";

#[derive(Debug, PartialEq, Eq)]
struct Request {
    root: PathBuf,
    proof: String,
    validate_only: bool,
}

fn parse(args: &[OsString], debug_build: bool) -> Result<Option<Request>, String> {
    let requested = args
        .iter()
        .any(|arg| arg.to_string_lossy().starts_with("--native-acceptance"));
    if !requested {
        return Ok(None);
    }
    if !debug_build {
        return Err("Native acceptance arguments are forbidden in release builds".into());
    }
    let mut root = None;
    let mut proof = None;
    let mut validate_only = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].to_str() {
            Some("--native-acceptance-root") if root.is_none() => {
                index += 1;
                root = Some(PathBuf::from(args.get(index).ok_or("Missing acceptance root")?));
            }
            Some("--native-acceptance-proof") if proof.is_none() => {
                index += 1;
                proof = Some(args.get(index).and_then(|value| value.to_str()).ok_or("Missing acceptance proof")?.to_owned());
            }
            Some("--native-acceptance-validate") if !validate_only => validate_only = true,
            _ => return Err("Acceptance cannot be combined with unknown, duplicate, background or import arguments".into()),
        }
        index += 1;
    }
    let proof = proof.ok_or("Missing acceptance proof")?;
    if proof.len() != 64
        || !proof
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Invalid acceptance proof".into());
    }
    Ok(Some(Request {
        root: root.ok_or("Missing acceptance root")?,
        proof,
        validate_only,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Marker {
    version: u32,
    protocol: String,
    proof: String,
    created_at_ms: u64,
    creator_pid: u32,
    root: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptancePaths {
    pub root: PathBuf,
    pub backend_home: PathBuf,
    pub webview_data: PathBuf,
    pub roaming: PathBuf,
    pub local: PathBuf,
    pub temp: PathBuf,
    pub artifacts: PathBuf,
}

impl AcceptancePaths {
    pub fn runtime_descriptor(&self) -> PathBuf {
        self.backend_home.join("agent-runtime.json")
    }
    pub fn disabled_desktop_executable(&self) -> PathBuf {
        self.root.join("native-relaunch-disabled.exe")
    }
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn ordinary_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Acceptance directory is missing")?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(
            "Acceptance directories must be ordinary directories without reparse points".into(),
        );
    }
    Ok(())
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    let result = path
        .canonicalize()
        .map_err(|_| "Acceptance path cannot be resolved")?;
    Ok(crate::cli_compatible_windows_path(&result))
}

fn validate_root(
    request: &Request,
    system_temp: &Path,
    now: u64,
) -> Result<AcceptancePaths, String> {
    let root = &request.root;
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("Acceptance root must be an absolute canonical local path".into());
    }
    #[cfg(windows)]
    if !matches!(root.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
    {
        return Err(
            "Acceptance root must use a local drive path, without UNC/device prefixes".into(),
        );
    }
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Invalid acceptance directory name")?;
    let suffix = name
        .strip_prefix(PREFIX)
        .ok_or("Acceptance root is not launcher-owned")?;
    if suffix.len() < 6
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid acceptance directory suffix".into());
    }
    if root.parent().ok_or("Missing acceptance parent")? != canonical(system_temp)?
        || canonical(root)? != *root
    {
        return Err(
            "Acceptance root must be a direct canonical child of the system temporary directory"
                .into(),
        );
    }
    ordinary_directory(root)?;
    let marker_path = root.join(MARKER);
    let metadata =
        fs::symlink_metadata(&marker_path).map_err(|_| "Acceptance ownership marker is missing")?;
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > 4096 {
        return Err("Acceptance ownership marker must be a bounded ordinary file".into());
    }
    let bytes = fs::read(marker_path).map_err(|_| "Cannot read acceptance marker")?;
    if bytes.len() > 4096 {
        return Err("Acceptance marker changed while reading".into());
    }
    let marker: Marker =
        serde_json::from_slice(&bytes).map_err(|_| "Malformed acceptance ownership marker")?;
    if marker.version != 1
        || marker.protocol != PROTOCOL
        || marker.proof != request.proof
        || marker.root != *root
        || marker.creator_pid == 0
    {
        return Err("Acceptance ownership proof does not match".into());
    }
    if marker.created_at_ms > now.saturating_add(300_000)
        || now.saturating_sub(marker.created_at_ms) > 86_400_000
    {
        return Err("Acceptance marker expired; prepare a new isolated session".into());
    }
    let roaming = root.join("roaming");
    let local = root.join("local");
    let paths = AcceptancePaths {
        root: root.clone(),
        backend_home: roaming.join("com.maobu.local"),
        webview_data: local.join("com.maobu.local").join("webview"),
        roaming,
        local,
        temp: root.join("temp"),
        artifacts: root.join("artifacts"),
    };
    for directory in [
        &paths.roaming,
        &paths.local,
        &paths.backend_home,
        &paths.local.join("com.maobu.local"),
        &paths.webview_data,
        &paths.temp,
        &paths.artifacts,
    ] {
        ordinary_directory(directory)?;
        if canonical(directory)? != *directory {
            return Err("Acceptance directory path changed".into());
        }
    }
    match fs::symlink_metadata(paths.disabled_desktop_executable()) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return Err("Acceptance background-relaunch disabled path must remain absent".into()),
    }
    Ok(paths)
}

struct RootLock {
    path: PathBuf,
    file: Option<File>,
}
impl RootLock {
    fn acquire(paths: &AcceptancePaths, proof: &str) -> Result<Self, String> {
        let path = paths.root.join("acceptance.lock");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let mut file = options.open(&path).map_err(|_| {
            "This acceptance root is already in use or locked; prepare a fresh session"
        })?;
        file.write_all(proof.as_bytes())
            .map_err(|_| "Cannot write acceptance lock")?;
        Ok(Self {
            path,
            file: Some(file),
        })
    }
}
impl Drop for RootLock {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

#[derive(Default)]
pub struct AcceptanceMode {
    pub paths: Option<AcceptancePaths>,
    _lock: Option<RootLock>,
}
impl AcceptanceMode {
    pub fn active(&self) -> bool {
        self.paths.is_some()
    }
    /// Called before any Tauri/plugin setup. CLI validation never starts an app.
    pub fn preflight() -> Result<(Self, bool), String> {
        let Some(request) = parse(
            &std::env::args_os().skip(1).collect::<Vec<_>>(),
            cfg!(debug_assertions),
        )?
        else {
            return Ok((Self::default(), false));
        };
        if !cfg!(windows) {
            return Err("Native acceptance currently supports Windows only".into());
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "System clock is unavailable")?
            .as_millis() as u64;
        let paths = validate_root(&request, &std::env::temp_dir(), now)?;
        validate_environment(&paths)?;
        #[cfg(windows)]
        validate_registry_overrides()?;
        if request.validate_only {
            #[cfg(debug_assertions)]
            println!(
                "{}",
                serde_json::json!({"protocol": DEBUG_BINARY_PROTOCOL, "validated": true, "paths": paths})
            );
            return Ok((Self::default(), true));
        }
        let lock = RootLock::acquire(&paths, &request.proof)?;
        // Process scoped, before any threads/plugins. Never change HOME or USERPROFILE.
        std::env::set_var("APPDATA", &paths.roaming);
        std::env::set_var("LOCALAPPDATA", &paths.local);
        std::env::set_var("TEMP", &paths.temp);
        std::env::set_var("TMP", &paths.temp);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &paths.webview_data);
        // MCP discovery must never follow an inherited production descriptor,
        // and a failed probe must not relaunch a desktop without the QA arguments.
        std::env::set_var("ALIASMODE_RUNTIME_DESCRIPTOR", paths.runtime_descriptor());
        std::env::set_var("ALIASMODE_DESKTOP_EXE", paths.disabled_desktop_executable());
        Ok((
            Self {
                paths: Some(paths),
                _lock: Some(lock),
            },
            false,
        ))
    }
}

fn validate_environment(paths: &AcceptancePaths) -> Result<(), String> {
    validate_environment_values(paths, |name| std::env::var_os(name))
}
fn validate_environment_values(
    paths: &AcceptancePaths,
    value: impl Fn(&str) -> Option<OsString>,
) -> Result<(), String> {
    for name in [
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER",
        "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER",
        "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
        "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE",
        "WEBVIEW2_RELEASE_CHANNELS",
        "WEBVIEW2_CHANNEL_SEARCH_KIND",
        "ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG",
        "ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG_PORT",
    ] {
        if value(name).is_some_and(|value| !value.is_empty()) {
            return Err(format!(
                "Acceptance refuses inherited {name}; no debugging or browser override is allowed"
            ));
        }
    }
    if value("WEBVIEW2_USER_DATA_FOLDER")
        .is_some_and(|value| !value.is_empty() && PathBuf::from(value) != paths.webview_data)
    {
        return Err("Acceptance refuses a WebView user-data environment override".into());
    }
    Ok(())
}

#[cfg(windows)]
fn validate_registry_overrides() -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
            System::Registry::*,
        },
    };
    let executable =
        std::env::current_exe().map_err(|_| "Cannot determine acceptance executable")?;
    let exe = executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid executable name")?;
    let ids = ["com.maobu.local", exe, "*"];
    let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    // Read-only checks of both policy views. Values are never copied into diagnostics.
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let mut entries: Vec<(String, String)> = Vec::new();
            for kind in [
                "UserDataFolder",
                "AdditionalBrowserArguments",
                "BrowserExecutableFolder",
                "ReleaseChannelPreference",
                "ReleaseChannels",
                "ChannelSearchKind",
                "DowngradeVersion",
            ] {
                for id in ids {
                    entries.push((
                        format!(r"Software\Policies\Microsoft\Edge\WebView2\{kind}"),
                        id.into(),
                    ));
                }
            }
            for id in ids {
                for kind in [
                    "userDataFolder",
                    "additionalBrowserArguments",
                    "browserExecutableFolder",
                    "releaseChannelPreference",
                ] {
                    entries.push((format!(r"Software\Policies\Microsoft\EmbeddedBrowserWebView\LoaderOverride\{id}"), kind.into()));
                }
            }
            for (path, name) in entries {
                let path = wide(&path);
                let mut key = HKEY::default();
                let opened = unsafe {
                    RegOpenKeyExW(
                        hive,
                        PCWSTR(path.as_ptr()),
                        None,
                        KEY_QUERY_VALUE | view,
                        &mut key,
                    )
                };
                if opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND {
                    continue;
                }
                if opened != ERROR_SUCCESS {
                    return Err("Cannot safely inspect WebView policy overrides".into());
                }
                let name = wide(&name);
                let mut size = 0;
                let queried = unsafe {
                    RegQueryValueExW(
                        key,
                        PCWSTR(name.as_ptr()),
                        None,
                        None,
                        None,
                        Some(&mut size),
                    )
                };
                unsafe {
                    let _ = RegCloseKey(key);
                }
                if queried == ERROR_FILE_NOT_FOUND {
                    continue;
                }
                if queried != ERROR_SUCCESS {
                    return Err("Cannot safely inspect WebView policy value".into());
                }
                return Err("Acceptance refuses an existing WebView loader policy override; registry was left unchanged".into());
            }
        }
    }
    Ok(())
}

pub fn ensure_action_allowed(app: &tauri::AppHandle) -> Result<(), String> {
    action_policy(
        app.try_state::<AcceptanceMode>()
            .is_some_and(|state| state.active()),
    )
}

fn action_policy(active: bool) -> Result<(), String> {
    if active {
        Err(RESTRICTED.into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }
    fn fixture() -> (tempfile::TempDir, Request, u64) {
        let parent = tempfile::tempdir().unwrap();
        let root = canonical(parent.path())
            .unwrap()
            .join("maobu-native-acceptance-testing01");
        for child in [
            "roaming/com.maobu.local",
            "local/com.maobu.local/webview",
            "temp",
            "artifacts",
        ] {
            fs::create_dir_all(root.join(child)).unwrap();
        }
        let now = 1_800_000_000_000;
        let proof = "a".repeat(64);
        fs::write(root.join(MARKER), serde_json::to_vec(&serde_json::json!({"version":1,"protocol":PROTOCOL,"proof":proof,"createdAtMs":now,"creatorPid":123,"root":root})).unwrap()).unwrap();
        (
            parent,
            Request {
                root,
                proof,
                validate_only: false,
            },
            now,
        )
    }
    #[test]
    fn acceptance_arguments_never_fall_back_or_mix_with_import_and_release() {
        assert_eq!(parse(&args(&["--background"]), false).unwrap(), None);
        for values in [
            vec!["--native-acceptance-root", "C:/Temp/qa"],
            vec!["--native-acceptance-invalid"],
            vec!["--native-acceptance-validate"],
        ] {
            assert!(parse(&args(&values), false).is_err());
            assert!(parse(&args(&values), true).is_err());
        }
        let proof = "a".repeat(64);
        let mut values = args(&[
            "--native-acceptance-root",
            "C:/Temp/qa",
            "--native-acceptance-proof",
            &proof,
        ]);
        assert!(parse(&values, true).unwrap().is_some());
        for extra in [
            "--background",
            "--import-cloakpit",
            "--native-acceptance-validate",
            "--native-acceptance-root",
        ] {
            let mut invalid = values.clone();
            invalid.extend(args(&[extra, extra]));
            assert!(parse(&invalid, true).is_err());
        }
        values.push("--native-acceptance-validate".into());
        assert!(parse(&values, true).unwrap().unwrap().validate_only);
    }
    #[test]
    fn acceptance_root_requires_fresh_marker_and_fixed_temp_descendants_without_writing() {
        let (parent, mut request, now) = fixture();
        let paths = validate_root(&request, parent.path(), now).unwrap();
        assert!(paths.backend_home.starts_with(&paths.root));
        assert!(paths.webview_data.starts_with(&paths.root));
        assert!(!paths.root.join("acceptance.lock").exists());
        request.proof = "b".repeat(64);
        assert!(validate_root(&request, parent.path(), now).is_err());
        request.proof = "a".repeat(64);
        assert!(validate_root(&request, parent.path(), now + 86_400_001).is_err());
        assert!(validate_root(&request, parent.path(), now - 300_001).is_err());
        assert!(validate_root(&request, &parent.path().join("other"), now).is_err());
        fs::remove_dir(&paths.webview_data).unwrap();
        assert!(validate_root(&request, parent.path(), now).is_err());
        assert!(!paths.webview_data.exists());
    }
    #[test]
    fn acceptance_rejects_missing_truncated_or_oversized_ownership_and_relative_roots() {
        let (parent, mut request, now) = fixture();
        for marker in [b"{}".to_vec(), vec![0; 4097]] {
            fs::write(request.root.join(MARKER), marker).unwrap();
            assert!(validate_root(&request, parent.path(), now).is_err());
        }
        fs::remove_file(request.root.join(MARKER)).unwrap();
        assert!(validate_root(&request, parent.path(), now).is_err());
        request.root = "maobu-native-acceptance-relative".into();
        assert!(validate_root(&request, parent.path(), now).is_err());
    }
    #[test]
    fn acceptance_refuses_a_background_relaunch_executable_inside_its_root() {
        let (parent, request, now) = fixture();
        let paths = validate_root(&request, parent.path(), now).unwrap();
        assert_eq!(
            paths.runtime_descriptor(),
            paths.backend_home.join("agent-runtime.json")
        );
        fs::write(paths.disabled_desktop_executable(), b"not an executable").unwrap();
        assert!(validate_root(&request, parent.path(), now).is_err());
    }
    #[test]
    fn acceptance_lock_is_per_root_and_releases_only_its_own_session() {
        let (parent, request, now) = fixture();
        let paths = validate_root(&request, parent.path(), now).unwrap();
        let lock = RootLock::acquire(&paths, &request.proof).unwrap();
        assert!(RootLock::acquire(&paths, &request.proof).is_err());
        drop(lock);
        let _next = RootLock::acquire(&paths, &request.proof).unwrap();
        assert!(request.root.join(MARKER).exists());
    }
    #[test]
    fn acceptance_refuses_inherited_debug_and_user_data_overrides() {
        let (parent, request, now) = fixture();
        let paths = validate_root(&request, parent.path(), now).unwrap();
        assert!(validate_environment_values(&paths, |_| None).is_ok());
        for name in [
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER",
            "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER",
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
            "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE",
            "WEBVIEW2_RELEASE_CHANNELS",
            "WEBVIEW2_CHANNEL_SEARCH_KIND",
            "ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG",
            "ALIASMODE_ACCEPTANCE_WEBVIEW_DEBUG_PORT",
            "WEBVIEW2_USER_DATA_FOLDER",
        ] {
            assert!(validate_environment_values(&paths, |key| (key == name)
                .then(|| "unsafe".into()))
            .is_err());
        }
        assert!(
            validate_environment_values(&paths, |name| (name == "WEBVIEW2_USER_DATA_FOLDER")
                .then(|| paths.webview_data.as_os_str().to_owned()))
            .is_ok()
        );
    }
    #[test]
    fn acceptance_restricted_operations_never_report_success() {
        assert!(action_policy(false).is_ok());
        assert_eq!(action_policy(true), Err(RESTRICTED.into()));
    }
    #[cfg(windows)]
    #[test]
    fn acceptance_refuses_directory_junctions() {
        use std::os::windows::fs::symlink_dir;
        let (parent, request, now) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let destination = request.root.join("artifacts");
        fs::remove_dir(&destination).unwrap();
        // Developer Mode/admin is optional on Windows; the guard is also used for junction metadata.
        if symlink_dir(outside.path(), &destination).is_ok() {
            assert!(validate_root(&request, parent.path(), now).is_err());
            fs::remove_dir(destination).unwrap();
        }
    }
}
