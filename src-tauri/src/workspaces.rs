use crate::credentials::CredentialOrigin;
use reqwest::{header, redirect::Policy, Client, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;
use zeroize::Zeroizing;

const CATALOG_FILE: &str = "desktop-workspaces.json";
const MAX_CATALOG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    version: u32,
    active_id: String,
    workspaces: Vec<WorkspaceRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceRecord {
    id: String,
    name: String,
    color: String,
    icon: String,
    created_at: u64,
    updated_at: u64,
    last_opened_at: u64,
    archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWorkspace {
    pub id: String,
    pub root: PathBuf,
}

#[derive(Clone)]
pub struct WorkspaceRuntime {
    pub home: PathBuf,
    pub active: ResolvedWorkspace,
}

impl WorkspaceRuntime {
    pub fn validate_restart(
        &self,
        expected_id: &str,
        target_id: &str,
    ) -> Result<ResolvedWorkspace, String> {
        if !valid_workspace_id(expected_id) || !valid_workspace_id(target_id) {
            return Err("workspace restart ID is invalid".to_owned());
        }
        if expected_id != self.active.id {
            return Err("the current workspace changed; reopen its workspace menu".to_owned());
        }
        let resolved = resolve_active_workspace(&self.home)?;
        if resolved.id != target_id {
            return Err(
                "workspace activation changed before restart; refresh and retry".to_owned(),
            );
        }
        Ok(resolved)
    }

    fn location(&self, kind: &str) -> Result<PathBuf, String> {
        check_directory(&self.active.root, false)?;
        let path = match kind {
            "data" => self.active.root.clone(),
            "backups" => self.active.root.join("backups"),
            "logs" => self.active.root.join("logs"),
            _ => return Err("unknown workspace location".to_owned()),
        };
        if !check_directory(&path, true)? {
            // Only these fixed children of the running workspace may be created.
            fs::create_dir(&path).map_err(|error| error.to_string())?;
        }
        check_directory(&path, false)?;
        Ok(path)
    }
}

pub fn valid_workspace_id(id: &str) -> bool {
    id == "default"
        || (id.len() == 35
            && id.starts_with("ws_")
            && id[3..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

pub(crate) fn workspace_root(home: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_workspace_id(id) {
        return Err("workspace ID is invalid".to_owned());
    }
    Ok(if id == "default" {
        home.to_path_buf()
    } else {
        home.join("workspaces").join(id)
    })
}

fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points need the same refusal as symlinks.
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    false
}

fn checked_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_link(&metadata) => Err(format!(
            "workspace path must not be a link or reparse point: {}",
            path.display()
        )),
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "cannot inspect workspace path {}: {error}",
            path.display()
        )),
    }
}

fn check_directory(path: &Path, allow_missing: bool) -> Result<bool, String> {
    match checked_metadata(path)? {
        Some(metadata) if metadata.is_dir() => Ok(true),
        Some(_) => Err(format!(
            "workspace directory is not a directory: {}",
            path.display()
        )),
        None if allow_missing => Ok(false),
        None => Err(format!(
            "workspace directory is not prepared: {}",
            path.display()
        )),
    }
}

fn validate_record(record: &WorkspaceRecord) -> Result<(), String> {
    let name_len = record.name.chars().count();
    let icon_len = record.icon.chars().count();
    if !valid_workspace_id(&record.id)
        || name_len == 0
        || name_len > 80
        || record.name.trim() != record.name
        || record.name.chars().any(char::is_control)
        || icon_len == 0
        || icon_len > 64
        || record.icon.chars().any(char::is_control)
        || record.color.len() != 7
        || !record.color.starts_with('#')
        || !record.color.as_bytes()[1..]
            .iter()
            .all(u8::is_ascii_hexdigit)
    {
        return Err("workspace catalog contains invalid workspace metadata".to_owned());
    }
    // Deserialization rejects negative, fractional, string and missing timestamps.
    let _timestamps = (record.created_at, record.updated_at, record.last_opened_at);
    Ok(())
}

/// Resolve without writing the catalog or silently recreating a registered root.
/// Absence of a catalog is the one legacy-compatible default-workspace case.
pub fn resolve_active_workspace(home: &Path) -> Result<ResolvedWorkspace, String> {
    check_directory(home, true)?;
    let catalog_path = home.join(CATALOG_FILE);
    let Some(metadata) = checked_metadata(&catalog_path)? else {
        validate_active_root(home, true)?;
        return Ok(ResolvedWorkspace {
            id: "default".to_owned(),
            root: home.to_path_buf(),
        });
    };
    if !metadata.is_file() || metadata.len() > MAX_CATALOG_BYTES {
        return Err("workspace catalog is not a supported regular file".to_owned());
    }
    let bytes = fs::read(&catalog_path).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err("workspace catalog is too large".to_owned());
    }
    let catalog: Catalog = serde_json::from_slice(&bytes)
        .map_err(|_| "workspace catalog is malformed; it was left unchanged".to_owned())?;
    if catalog.version != 1
        || catalog.workspaces.is_empty()
        || !valid_workspace_id(&catalog.active_id)
    {
        return Err("workspace catalog schema is unsupported".to_owned());
    }
    check_directory(&home.join("workspaces"), true)?;
    let mut ids = HashSet::new();
    for record in &catalog.workspaces {
        validate_record(record)?;
        if !ids.insert(record.id.as_str()) {
            return Err("workspace catalog contains duplicate IDs".to_owned());
        }
        check_directory(&workspace_root(home, &record.id)?, true)?;
    }
    if !ids.contains("default") {
        return Err("workspace catalog must preserve the default workspace".to_owned());
    }
    let record = catalog
        .workspaces
        .iter()
        .find(|record| record.id == catalog.active_id)
        .ok_or_else(|| "active workspace is missing from the catalog".to_owned())?;
    if record.archived {
        return Err("the active workspace is archived".to_owned());
    }
    let root = workspace_root(home, &record.id)?;
    validate_active_root(&root, false)?;
    Ok(ResolvedWorkspace {
        id: record.id.clone(),
        root,
    })
}

fn validate_active_root(root: &Path, allow_missing: bool) -> Result<(), String> {
    if !check_directory(root, allow_missing)? {
        return Ok(());
    }
    // These are direct mutable roots, never arbitrary paths supplied by the UI.
    for name in [
        "profiles",
        "inbox",
        "extensions",
        "custom-scripts",
        "runtimes",
        "logs",
        "backups",
    ] {
        check_directory(&root.join(name), true)?;
    }
    for name in [
        "profiles.sqlite",
        "profiles.sqlite-wal",
        "profiles.sqlite-shm",
        "config.json",
        "shell.json",
        "agent-runtime.json",
    ] {
        if checked_metadata(&root.join(name))?.is_some_and(|metadata| !metadata.is_file()) {
            return Err(format!("workspace data file is not a regular file: {name}"));
        }
    }
    Ok(())
}

fn command_origin_allowed(label: &str, actual_origin: &str, expected_origin: &str) -> bool {
    label == "main" && actual_origin == expected_origin
}

pub(crate) fn authorize_workspace_window(
    window: &WebviewWindow,
    origin: &CredentialOrigin,
) -> Result<(), String> {
    let actual = window
        .url()
        .map_err(|_| "cannot verify workspace window origin".to_owned())?
        .origin()
        .ascii_serialization();
    if !command_origin_allowed(window.label(), &actual, &origin.0) {
        return Err("workspace command rejected the window origin".to_owned());
    }
    Ok(())
}

#[allow(deprecated)]
#[tauri::command]
pub fn open_workspace_location(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    workspace: tauri::State<'_, WorkspaceRuntime>,
    kind: String,
) -> Result<(), String> {
    authorize_workspace_window(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    let directory = crate::cli_compatible_windows_path(&workspace.location(&kind)?);
    let path = directory
        .to_str()
        .ok_or_else(|| "workspace path is not valid Unicode".to_owned())?;
    // The already bundled shell plugin uses the platform file opener (including
    // Linux desktop fallbacks). No shell command or user-controlled path is built.
    app.shell()
        .open(path.to_owned(), None)
        .map_err(|error| error.to_string())
}

fn valid_backup_id(id: &str) -> bool {
    id.len() == 36
        && id.starts_with("bak_")
        && id.as_bytes()[4..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportResult {
    saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

/// Holds only one response chunk in memory. Drop closes and deletes an uncommitted
/// temporary file, including on network, disk, length or hash errors.
struct BackupSink {
    file: Option<fs::File>,
    temporary: PathBuf,
    destination: PathBuf,
    received: u64,
    expected: u64,
    digest: Sha256,
    committed: bool,
}

impl BackupSink {
    fn new(destination: &Path, expected: u64) -> Result<Self, String> {
        if !destination
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("mqbackup"))
        {
            return Err("choose a file with the .mqbackup extension".to_owned());
        }
        if checked_metadata(destination)?.is_some_and(|metadata| !metadata.is_file()) {
            return Err("backup destination is not a regular file".to_owned());
        }
        let parent = destination
            .parent()
            .ok_or_else(|| "backup destination has no parent directory".to_owned())?;
        let temporary = parent.join(format!(
            ".mqbackup-{}.partial",
            hex::encode(rand::random::<[u8; 16]>())
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&temporary)
            .map_err(|error| format!("could not create backup export: {error}"))?;
        Ok(Self {
            file: Some(file),
            temporary,
            destination: destination.into(),
            received: 0,
            expected,
            digest: Sha256::new(),
            committed: false,
        })
    }

    fn write_chunk(&mut self, chunk: &[u8]) -> Result<(), String> {
        let received = self
            .received
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| "backup export length overflow".to_owned())?;
        if received > self.expected {
            return Err("backup export exceeded its expected length".to_owned());
        }
        self.file
            .as_mut()
            .ok_or_else(|| "backup export file is closed".to_owned())?
            .write_all(chunk)
            .map_err(|error| format!("could not write backup export: {error}"))?;
        self.digest.update(chunk);
        self.received = received;
        Ok(())
    }

    fn finish(mut self, expected_sha256: &str) -> Result<(), String> {
        if self.received != self.expected {
            return Err("backup export did not receive the complete file".to_owned());
        }
        let actual = hex::encode(self.digest.clone().finalize());
        if actual != expected_sha256.to_ascii_lowercase() {
            return Err("backup export SHA-256 verification failed".to_owned());
        }
        self.file
            .as_ref()
            .ok_or_else(|| "backup export file is closed".to_owned())?
            .sync_all()
            .map_err(|error| format!("could not finish backup export: {error}"))?;
        self.file.take();
        if checked_metadata(&self.destination)?.is_some_and(|metadata| !metadata.is_file()) {
            return Err("backup destination changed before export completed".to_owned());
        }
        replace_export(&self.temporary, &self.destination)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for BackupSink {
    fn drop(&mut self) {
        self.file.take();
        if !self.committed {
            let _ = fs::remove_file(&self.temporary);
        }
    }
}

#[cfg(not(windows))]
fn replace_export(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("could not commit backup export: {error}"))
}

#[cfg(windows)]
fn replace_export(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MOVE_FILE_FLAGS,
        },
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let flags = MOVE_FILE_FLAGS(MOVEFILE_REPLACE_EXISTING.0 | MOVEFILE_WRITE_THROUGH.0);
    unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr()), flags) }
        .map_err(|error| format!("could not commit backup export: {error}"))
}

async fn save_backup_response(mut response: Response, destination: &Path) -> Result<(), String> {
    if !response.status().is_success() {
        return Err(format!(
            "backup export answered HTTP {}",
            response.status().as_u16()
        ));
    }
    let expected = response
        .content_length()
        .filter(|length| *length > 0)
        .ok_or_else(|| "backup export did not provide its complete file length".to_owned())?;
    let sha256 = response
        .headers()
        .get("X-Backup-SHA256")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "backup export did not provide a valid SHA-256".to_owned())?
        .to_owned();
    let mut sink = BackupSink::new(destination, expected)?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("backup export was interrupted: {error}"))?
    {
        sink.write_chunk(&chunk)?;
    }
    sink.finish(&sha256)
}

#[tauri::command]
pub async fn export_workspace_backup(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    runtime: tauri::State<'_, crate::runtime_descriptor::RuntimeDescriptorState>,
    dashboard_session: tauri::State<'_, crate::DesktopDashboardSession>,
    backup_id: String,
) -> Result<BackupExportResult, String> {
    authorize_workspace_window(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    if !valid_backup_id(&backup_id) {
        return Err("backup export ID is invalid".to_owned());
    }
    let source_origin = origin.0.clone();
    let nonce = Zeroizing::new(crate::runtime_descriptor::script_capability(
        window.clone(),
        origin,
        runtime,
    )?);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .add_filter("猫步·千境备份", &["mqbackup"])
        .set_file_name(format!("猫步千境-备份-{backup_id}.mqbackup"))
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let chosen = receiver
        .await
        .map_err(|_| "backup save dialog was closed unexpectedly".to_owned())?;
    let Some(chosen) = chosen else {
        return Ok(BackupExportResult {
            saved: false,
            path: None,
        });
    };
    let destination = chosen.into_path().map_err(|error| error.to_string())?;
    let client = Client::builder()
        .no_proxy()
        .no_gzip()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!(
            "{source_origin}/ui/api/workspace/backups/{backup_id}/download"
        ))
        .header(header::ACCEPT_ENCODING, "identity")
        .header(crate::DESKTOP_SESSION_HEADER, dashboard_session.0.as_str())
        .bearer_auth(nonce.as_str())
        .send()
        .await
        .map_err(|error| format!("could not download workspace backup: {error}"))?;
    save_backup_response(response, &destination).await?;
    Ok(BackupExportResult {
        saved: true,
        path: Some(destination.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tempfile::tempdir;

    const ID: &str = "ws_0123456789abcdef0123456789abcdef";

    fn record(id: &str) -> Value {
        json!({"id":id,"name":"Workspace","color":"#8d75cd","icon":"folder","createdAt":0,"updatedAt":1,"lastOpenedAt":0,"archived":false})
    }
    fn write_catalog(home: &Path, active: &str, records: Vec<Value>) {
        fs::write(
            home.join(CATALOG_FILE),
            serde_json::to_vec(&json!({"version":1,"activeId":active,"workspaces":records}))
                .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn missing_catalog_keeps_legacy_data_in_default_root_without_writing() {
        let home = tempdir().unwrap();
        fs::write(home.path().join("profiles.sqlite"), b"existing data").unwrap();
        assert_eq!(
            resolve_active_workspace(home.path()).unwrap(),
            ResolvedWorkspace {
                id: "default".into(),
                root: home.path().to_path_buf()
            }
        );
        assert_eq!(
            fs::read(home.path().join("profiles.sqlite")).unwrap(),
            b"existing data"
        );
        assert!(!home.path().join(CATALOG_FILE).exists());
    }

    #[test]
    fn resolves_only_prepared_active_roots_and_keeps_default_at_home() {
        let home = tempdir().unwrap();
        write_catalog(home.path(), ID, vec![record("default"), record(ID)]);
        assert!(resolve_active_workspace(home.path()).is_err());
        let root = home.path().join("workspaces").join(ID);
        fs::create_dir_all(&root).unwrap();
        assert_eq!(resolve_active_workspace(home.path()).unwrap().root, root);
        write_catalog(home.path(), "default", vec![record("default"), record(ID)]);
        assert_eq!(
            resolve_active_workspace(home.path()).unwrap().root,
            home.path()
        );
    }

    #[test]
    fn rejects_unsafe_ids_and_does_not_accept_path_syntax() {
        for id in [
            "",
            "../default",
            "ws_../data",
            "ws_0123456789ABCDEF0123456789abcdef",
            "default/other",
            "ws_0123456789abcdef0123456789abcde",
            "ws_é123456789abcdef0123456789abcdef",
        ] {
            assert!(!valid_workspace_id(id), "{id}");
        }
        assert!(valid_workspace_id(ID));
        assert!(valid_workspace_id("default"));
    }

    #[test]
    fn refuses_malformed_missing_archived_duplicate_and_negative_catalog_entries() {
        let home = tempdir().unwrap();
        for contents in [b"{broken".as_slice(), b"{}".as_slice()] {
            fs::write(home.path().join(CATALOG_FILE), contents).unwrap();
            assert!(resolve_active_workspace(home.path()).is_err());
            assert_eq!(fs::read(home.path().join(CATALOG_FILE)).unwrap(), contents);
        }
        write_catalog(home.path(), ID, vec![record("default")]);
        assert!(resolve_active_workspace(home.path()).is_err());
        let mut archived = record("default");
        archived["archived"] = json!(true);
        write_catalog(home.path(), "default", vec![archived]);
        assert!(resolve_active_workspace(home.path()).is_err());
        write_catalog(
            home.path(),
            "default",
            vec![record("default"), record("default")],
        );
        assert!(resolve_active_workspace(home.path()).is_err());
        let mut negative = record("default");
        negative["createdAt"] = json!(-1);
        write_catalog(home.path(), "default", vec![negative]);
        assert!(resolve_active_workspace(home.path()).is_err());
    }

    #[test]
    fn restart_is_bound_to_the_running_source_and_committed_target() {
        let home = tempdir().unwrap();
        fs::create_dir_all(home.path().join("workspaces").join(ID)).unwrap();
        let runtime = WorkspaceRuntime {
            home: home.path().into(),
            active: ResolvedWorkspace {
                id: "default".into(),
                root: home.path().into(),
            },
        };
        write_catalog(home.path(), ID, vec![record("default"), record(ID)]);
        assert!(runtime.validate_restart("default", ID).is_ok());
        assert!(runtime.validate_restart(ID, ID).is_err());
        assert!(runtime.validate_restart("default", "default").is_err());
        write_catalog(home.path(), "default", vec![record("default"), record(ID)]);
        assert!(runtime.validate_restart("default", ID).is_err());
    }

    #[test]
    fn workspace_commands_require_the_main_window_and_exact_origin() {
        assert!(command_origin_allowed(
            "main",
            "http://127.0.0.1:50001",
            "http://127.0.0.1:50001"
        ));
        for (label, actual) in [
            ("other", "http://127.0.0.1:50001"),
            ("main", "http://127.0.0.1:50002"),
            ("main", "https://example.com"),
            ("main", "tauri://localhost"),
        ] {
            assert!(!command_origin_allowed(
                label,
                actual,
                "http://127.0.0.1:50001"
            ));
        }
    }

    #[test]
    fn location_commands_only_resolve_current_workspace_fixed_directories() {
        let home = tempdir().unwrap();
        let runtime = WorkspaceRuntime {
            home: home.path().into(),
            active: ResolvedWorkspace {
                id: "default".into(),
                root: home.path().into(),
            },
        };
        assert_eq!(runtime.location("data").unwrap(), home.path());
        assert_eq!(
            runtime.location("backups").unwrap(),
            home.path().join("backups")
        );
        assert_eq!(runtime.location("logs").unwrap(), home.path().join("logs"));
        for kind in ["../outside", "C:\\Windows", "backup", ""] {
            assert!(runtime.location(kind).is_err());
        }
    }

    #[test]
    fn backup_export_accepts_only_index_ids_not_source_paths() {
        assert!(valid_backup_id("bak_0123456789abcdef0123456789abcdef"));
        for id in [
            "bak_../backup",
            "../backup.mqbackup",
            "bak_0123456789ABCDEF0123456789abcdef",
            "job_0123456789abcdef0123456789abcdef",
            "bak_0123456789abcdef0123456789abcde",
        ] {
            assert!(!valid_backup_id(id));
        }
    }

    #[test]
    fn backup_sink_commits_only_complete_verified_data_and_preserves_existing_files() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("export.mqbackup");
        fs::write(&target, b"original file").unwrap();
        let body = b"verified backup payload";
        let hash = hex::encode(Sha256::digest(body));
        {
            let mut partial = BackupSink::new(&target, body.len() as u64).unwrap();
            partial.write_chunk(&body[..4]).unwrap();
            assert!(partial.finish(&hash).is_err());
        }
        assert_eq!(fs::read(&target).unwrap(), b"original file");
        {
            let mut wrong = BackupSink::new(&target, body.len() as u64).unwrap();
            wrong.write_chunk(body).unwrap();
            assert!(wrong.finish(&"0".repeat(64)).is_err());
        }
        assert_eq!(fs::read(&target).unwrap(), b"original file");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        let mut complete = BackupSink::new(&target, body.len() as u64).unwrap();
        for chunk in body.chunks(3) {
            complete.write_chunk(chunk).unwrap();
        }
        complete.finish(&hash).unwrap();
        assert_eq!(fs::read(&target).unwrap(), body);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        assert!(BackupSink::new(&directory.path().join("profiles.sqlite"), 0).is_err());
    }

    #[test]
    fn http_backup_stream_checks_transport_length_and_hash_before_commit() {
        use std::io::Read;
        use std::net::TcpListener;
        let directory = tempdir().unwrap();
        let target = directory.path().join("stream.mqbackup");
        let body = b"streamed and verified archive bytes";
        for (extra, corrupt, success) in [(0, false, true), (4, false, false), (0, true, false)] {
            fs::write(&target, b"previous backup").unwrap();
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let bytes = body.to_vec();
            let sha = if corrupt {
                "0".repeat(64)
            } else {
                hex::encode(Sha256::digest(body))
            };
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0u8; 2048];
                let _ = socket.read(&mut request);
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nX-Backup-SHA256: {}\r\nConnection: close\r\n\r\n",bytes.len()+extra,sha).unwrap();
                for chunk in bytes.chunks(5) {
                    socket.write_all(chunk).unwrap();
                }
            });
            let result = tauri::async_runtime::block_on(async {
                let response = Client::builder()
                    .no_proxy()
                    .no_gzip()
                    .timeout(Duration::from_secs(3))
                    .build()
                    .unwrap()
                    .get(format!("http://{address}/download"))
                    .send()
                    .await
                    .unwrap();
                save_backup_response(response, &target).await
            });
            server.join().unwrap();
            assert_eq!(result.is_ok(), success, "{result:?}");
            assert_eq!(
                fs::read(&target).unwrap(),
                if success {
                    body.as_slice()
                } else {
                    b"previous backup".as_slice()
                }
            );
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_catalog_and_workspace_directory_symlinks() {
        use std::os::unix::fs::symlink;
        let home = tempdir().unwrap();
        let other = tempdir().unwrap();
        fs::write(other.path().join("catalog.json"), b"{}").unwrap();
        symlink(
            other.path().join("catalog.json"),
            home.path().join(CATALOG_FILE),
        )
        .unwrap();
        assert!(resolve_active_workspace(home.path()).is_err());
        fs::remove_file(home.path().join(CATALOG_FILE)).unwrap();
        write_catalog(home.path(), ID, vec![record("default"), record(ID)]);
        fs::create_dir(home.path().join("workspaces")).unwrap();
        symlink(other.path(), home.path().join("workspaces").join(ID)).unwrap();
        assert!(resolve_active_workspace(home.path()).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn refuses_workspace_junctions_without_following_them() {
        use std::os::windows::process::CommandExt;
        let home = tempdir().unwrap();
        let other = tempdir().unwrap();
        fs::create_dir(home.path().join("workspaces")).unwrap();
        let link = home.path().join("workspaces").join(ID);
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(other.path())
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(status.status.success(), "could not create test junction");
        write_catalog(home.path(), ID, vec![record("default"), record(ID)]);
        assert!(resolve_active_workspace(home.path()).is_err());
        // Remove the junction itself, never recurse through its destination.
        fs::remove_dir(link).unwrap();
    }
}
