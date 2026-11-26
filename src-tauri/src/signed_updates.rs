//! Application updates use only the publisher and public key embedded at build time.
//! Dashboard release browsing preferences never alter this installation authority.
use crate::{credentials::CredentialOrigin, sidecar::SidecarSupervisor};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::future::Future;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const NOT_CONFIGURED: &str =
    "This build has no signed update publisher. GitHub release browsing remains available.";
const INVALID_CONFIG: &str = "This build's signed update publisher is invalid. Install a correctly configured build to enable installation.";
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone)]
struct Publisher {
    public_key: String,
    endpoint: Url,
}
fn publisher_from(
    public_key: Option<&str>,
    endpoint: Option<&str>,
) -> Result<Option<Publisher>, String> {
    let key = public_key.unwrap_or_default().trim();
    let endpoint = endpoint.unwrap_or_default().trim();
    if key.is_empty() && endpoint.is_empty() {
        return Ok(None);
    }
    if key.is_empty() || endpoint.is_empty() || key.len() > 4096 {
        return Err(INVALID_CONFIG.to_owned());
    }
    let decoded = STANDARD
        .decode(key)
        .map_err(|_| INVALID_CONFIG.to_owned())?;
    let decoded = std::str::from_utf8(&decoded).map_err(|_| INVALID_CONFIG.to_owned())?;
    let lines: Vec<_> = decoded.lines().collect();
    if lines.len() != 2 || !lines[0].starts_with("untrusted comment: ") {
        return Err(INVALID_CONFIG.to_owned());
    }
    let key_bytes = STANDARD
        .decode(lines[1])
        .map_err(|_| INVALID_CONFIG.to_owned())?;
    if key_bytes.len() != 42 || &key_bytes[..2] != b"Ed" {
        return Err(INVALID_CONFIG.to_owned());
    }
    let endpoint = safe_https_url(endpoint).map_err(|_| INVALID_CONFIG.to_owned())?;
    Ok(Some(Publisher {
        public_key: key.to_owned(),
        endpoint,
    }))
}
fn publisher() -> Result<Option<Publisher>, String> {
    publisher_from(
        option_env!("MAOBU_UPDATE_PUBLIC_KEY"),
        option_env!("MAOBU_UPDATE_ENDPOINT"),
    )
}
fn safe_https_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid signed update URL".to_owned())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(
            "Signed update URLs must use HTTPS without credentials, queries, or fragments"
                .to_owned(),
        );
    }
    Ok(url)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    version: String,
    current_version: String,
    notes: String,
    published_at: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedUpdateStatus {
    configured: bool,
    status: String,
    current_version: String,
    endpoint: Option<String>,
    message: String,
    update: Option<AvailableUpdate>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedUpdateProgress {
    phase: &'static str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}
pub struct SignedUpdateState {
    busy: AtomicBool,
    pending: Mutex<Option<Update>>,
    status: Mutex<SignedUpdateStatus>,
}
impl Default for SignedUpdateState {
    fn default() -> Self {
        let (configured, endpoint, message) = match publisher() {
            Ok(Some(value)) => (
                true,
                Some(value.endpoint.to_string()),
                "Signed updates are ready. Check this build's publisher for a new version."
                    .to_owned(),
            ),
            Ok(None) => (false, None, NOT_CONFIGURED.to_owned()),
            Err(error) => (false, None, error),
        };
        Self {
            busy: AtomicBool::new(false),
            pending: Mutex::new(None),
            status: Mutex::new(SignedUpdateStatus {
                configured,
                endpoint,
                message,
                current_version: VERSION.to_owned(),
                status: if configured { "idle" } else { "disabled" }.to_owned(),
                update: None,
            }),
        }
    }
}
struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl SignedUpdateState {
    pub fn for_acceptance() -> Self {
        Self {
            busy: AtomicBool::new(false),
            pending: Mutex::new(None),
            status: Mutex::new(SignedUpdateStatus {
                configured: false,
                endpoint: None,
                message: crate::acceptance::RESTRICTED.to_owned(),
                current_version: VERSION.to_owned(),
                status: "disabled".to_owned(),
                update: None,
            }),
        }
    }
    fn begin(&self) -> Result<BusyGuard<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "A signed update operation is already in progress".to_owned())?;
        Ok(BusyGuard(&self.busy))
    }
    fn read(&self) -> Result<SignedUpdateStatus, String> {
        self.status
            .lock()
            .map(|value| value.clone())
            .map_err(|_| "Signed update state is unavailable".to_owned())
    }
    fn begin_check(&self, startup: bool) -> Result<Option<BusyGuard<'_>>, String> {
        let guard = match self.begin() {
            Ok(guard) => guard,
            Err(_) if startup => return Ok(None),
            Err(error) => return Err(error),
        };
        if startup {
            let current = self.read()?;
            if !current.configured || current.status != "idle" {
                return Ok(None);
            }
        }
        Ok(Some(guard))
    }
    fn set(
        &self,
        status: &str,
        message: &str,
        update: Option<AvailableUpdate>,
    ) -> Result<SignedUpdateStatus, String> {
        let mut value = self
            .status
            .lock()
            .map_err(|_| "Signed update state is unavailable".to_owned())?;
        value.status = status.to_owned();
        value.message = message.to_owned();
        value.update = update;
        Ok(value.clone())
    }
}
pub(crate) fn register(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(Some(value)) = publisher() {
        app.plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(value.public_key)
                .build(),
        )?;
    }
    Ok(())
}
fn available(update: &Update) -> AvailableUpdate {
    AvailableUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update
            .body
            .clone()
            .unwrap_or_default()
            .chars()
            .take(24_000)
            .collect(),
        published_at: update
            .raw_json
            .get("pub_date")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    }
}

fn expected_release_filenames(version: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![format!("MaobuBrowser_{version}_x64-setup.exe")]
    }
    #[cfg(target_os = "macos")]
    {
        vec![format!(
            "MaobuBrowser_{version}_{}.app.tar.gz",
            std::env::consts::ARCH
        )]
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let arch = std::env::consts::ARCH;
        let deb_arch = match arch {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            other => other,
        };
        vec![
            format!("MaobuBrowser_{version}_{arch}.AppImage"),
            format!("MaobuBrowser_{version}_{deb_arch}.deb"),
        ]
    }
}

/**
 * The pinned Tauri CLI signs a trusted comment containing `file:<filename>`.
 * Binding that authenticated name to the manifest version prevents relabeling
 * an old, validly signed installer as a higher version. The official plugin
 * performs all cryptographic verification before any cleanup or installation.
 */
fn validate_release(version: &str, download_url: &Url, signature: &str) -> Result<(), String> {
    safe_https_url(download_url.as_str())?;
    if version.len() > 128
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
    {
        return Err("Invalid signed release version".to_owned());
    }
    let candidates = expected_release_filenames(version);
    let download_name = download_url
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .unwrap_or_default();
    let decoded_name = percent_encoding::percent_decode_str(download_name)
        .decode_utf8()
        .ok();
    let filename = candidates
        .iter()
        .find(|candidate| decoded_name.as_deref() == Some(candidate.as_str()))
        .ok_or_else(|| {
            "The signed release asset does not match this platform and version".to_owned()
        })?;
    if signature.len() > 16 * 1024 {
        return Err("Invalid signed release signature".to_owned());
    }
    let decoded = STANDARD
        .decode(signature.trim())
        .map_err(|_| "Invalid signed release signature".to_owned())?;
    let text =
        std::str::from_utf8(&decoded).map_err(|_| "Invalid signed release signature".to_owned())?;
    let comments: Vec<_> = text
        .lines()
        .filter_map(|line| line.strip_prefix("trusted comment: "))
        .collect();
    if comments.len() != 1
        || !comments[0]
            .split('\t')
            .any(|field| field == format!("file:{filename}"))
    {
        return Err("The signature does not bind this exact release version".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub fn signed_update_status(
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    state: tauri::State<'_, SignedUpdateState>,
) -> Result<SignedUpdateStatus, String> {
    crate::credentials::authorize(&window, &origin)?;
    state.read()
}
#[tauri::command]
pub async fn signed_update_check(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    state: tauri::State<'_, SignedUpdateState>,
    startup: Option<bool>,
) -> Result<SignedUpdateStatus, String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    let Some(config) = publisher()? else {
        return state.read();
    };
    let Some(_busy) = state.begin_check(startup.unwrap_or(false))? else {
        return state.read();
    };
    state.set("checking", "Checking the signed publisher channel…", None)?;
    *state
        .pending
        .lock()
        .map_err(|_| "Signed update state is unavailable".to_owned())? = None;
    let checked = async {
        let updater = app
            .updater_builder()
            .endpoints(vec![config.endpoint])
            .map_err(|_| "The signed update publisher is invalid".to_owned())?
            .timeout(Duration::from_secs(20))
            .configure_client(|client| {
                client
                    .https_only(true)
                    .redirect(reqwest::redirect::Policy::limited(5))
            })
            .build()
            .map_err(|_| "The signed updater could not be initialized".to_owned())?;
        let Some(mut update) = updater.check().await.map_err(|_| {
            "Could not check the signed update publisher. Check your connection and try again."
                .to_owned()
        })?
        else {
            return state.set(
                "up-to-date",
                "This build is up to date on its signed publisher channel.",
                None,
            );
        };
        validate_release(&update.version, &update.download_url, &update.signature)?;
        update.timeout = Some(Duration::from_secs(10 * 60));
        let info = available(&update);
        *state
            .pending
            .lock()
            .map_err(|_| "Signed update state is unavailable".to_owned())? = Some(update);
        state.set(
            "available",
            "A signed publisher update is available. Download and verify it before installing.",
            Some(info),
        )
    }
    .await;
    if let Err(ref error) = checked {
        let _ = state.set("error", error, None);
    }
    checked
}
async fn install_after_cleanup<C, F, I, R>(cleanup: C, install: I, recover: R) -> Result<(), String>
where
    C: FnOnce() -> F,
    F: Future<Output = Result<(), String>>,
    I: FnOnce() -> Result<(), String>,
    R: FnOnce(),
{
    cleanup().await?;
    if install().is_err() {
        recover();
        return Err(
            "The signed installer could not start. The app is restarting with your saved sessions."
                .to_owned(),
        );
    }
    Ok(())
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn signed_update_install(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    state: tauri::State<'_, SignedUpdateState>,
    sidecar: tauri::State<'_, SidecarSupervisor>,
    closing: tauri::State<'_, Arc<crate::shutdown::CloseState>>,
    expected_version: String,
    on_progress: Channel<SignedUpdateProgress>,
) -> Result<(), String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    if publisher()?.is_none() {
        return Err(NOT_CONFIGURED.to_owned());
    }
    let _busy = state.begin()?;
    let update = state
        .pending
        .lock()
        .map_err(|_| "Signed update state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Check for a signed update before installing".to_owned())?;
    if update.version != expected_version {
        return Err(
            "The update changed. Check the signed publisher again before installing.".to_owned(),
        );
    }
    validate_release(&update.version, &update.download_url, &update.signature)?;
    let _transition = closing.begin_update()?;
    let info = available(&update);
    state.set(
        "downloading",
        "Downloading and verifying the publisher's signed update…",
        Some(info.clone()),
    )?;
    let install: Result<(), String> = async {
        let mut downloaded = 0_u64;
        let progress = on_progress.clone(); let finishing = on_progress.clone();
        let overflow = Arc::new(tokio::sync::Notify::new());
        let overflow_signal = overflow.clone();
        let download = update.download(move |chunk, total| {
            downloaded = downloaded.saturating_add(chunk as u64);
            if downloaded > MAX_UPDATE_BYTES || total.is_some_and(|bytes| bytes > MAX_UPDATE_BYTES) { overflow_signal.notify_one(); }
            let _ = progress.send(SignedUpdateProgress { phase: "downloading", downloaded_bytes: downloaded, total_bytes: total });
        }, move || { let _ = finishing.send(SignedUpdateProgress { phase: "verifying", downloaded_bytes: 0, total_bytes: None }); });
        let bytes = tokio::select! {
            biased;
            _ = overflow.notified() => return Err("The update exceeds the 512 MiB download limit. No application changes were made.".to_owned()),
            result = download => result.map_err(|_| "Update download or signature verification failed. Your current app and browser sessions were preserved.".to_owned())?,
        };
        if bytes.len() as u64 > MAX_UPDATE_BYTES { return Err("The update exceeds the 512 MiB download limit. No application changes were made.".to_owned()); }
        // download() returns only after the official plugin has authenticated bytes.
        let _ = on_progress.send(SignedUpdateProgress { phase: "closing", downloaded_bytes: bytes.len() as u64, total_bytes: Some(bytes.len() as u64) });
        state.set("installing", "Signature verified. Saving browser sessions and preparing installation…", Some(info))?;
        install_after_cleanup(|| async {
            if crate::shutdown::graceful_sidecar_cleanup(&sidecar).await.is_err() {
                let error = "Could not safely close browser sessions. The signed update was cancelled.".to_owned();
                crate::shutdown::exit_after_cleanup_failure(app.clone(), &sidecar, error.clone());
                return Err(error);
            }
            Ok(())
        }, || {
            let _ = on_progress.send(SignedUpdateProgress { phase: "installing", downloaded_bytes: bytes.len() as u64, total_bytes: Some(bytes.len() as u64) });
            update.install(bytes).map_err(|_| "The signed installer could not start".to_owned())
        }, || { app.request_restart(); }).await?;
        let _ = on_progress.send(SignedUpdateProgress { phase: "complete", downloaded_bytes: 0, total_bytes: None });
        #[cfg(not(windows))]
        app.restart();
        Ok(())
    }.await;
    if let Err(ref error) = install {
        let _ = state.set("error", error, None);
    }
    install
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_acceptance_disables_even_a_configured_publisher_without_a_startup_check() {
        let state = SignedUpdateState::for_acceptance();
        let status = state.read().unwrap();
        assert!(!status.configured);
        assert_eq!(status.status, "disabled");
        assert_eq!(status.message, crate::acceptance::RESTRICTED);
        assert!(status.endpoint.is_none());
        assert!(status.update.is_none());
        assert!(state.pending.lock().unwrap().is_none());
        assert!(state.begin_check(true).unwrap().is_none());
    }

    #[test]
    fn startup_check_skips_disabled_busy_and_already_checked_states() {
        let state = SignedUpdateState::default();
        {
            let mut status = state.status.lock().unwrap();
            status.configured = false;
            status.status = "disabled".to_owned();
        }
        assert!(state.begin_check(true).unwrap().is_none());
        {
            let mut status = state.status.lock().unwrap();
            status.configured = true;
            status.status = "idle".to_owned();
        }
        let busy = state.begin_check(true).unwrap().unwrap();
        assert!(state.begin_check(true).unwrap().is_none());
        assert!(state.begin_check(false).is_err());
        drop(busy);
        let update = AvailableUpdate {
            version: "1.2.3".to_owned(),
            current_version: VERSION.to_owned(),
            notes: "fixture".to_owned(),
            published_at: None,
        };
        state
            .set("available", "Existing manual result", Some(update))
            .unwrap();
        assert!(state.begin_check(true).unwrap().is_none());
        let existing = state.read().unwrap();
        assert_eq!(existing.status, "available");
        assert_eq!(existing.update.unwrap().version, "1.2.3");
        assert!(state.begin_check(false).unwrap().is_some());
        state.set("error", "Failed fixture check", None).unwrap();
        assert!(state.begin_check(true).unwrap().is_none());
        assert!(state.begin_check(false).unwrap().is_some());
    }
    fn test_key() -> String {
        let mut bytes = vec![1_u8; 42];
        bytes[..2].copy_from_slice(b"Ed");
        STANDARD.encode(format!(
            "untrusted comment: test-only public fixture\n{}\n",
            STANDARD.encode(bytes)
        ))
    }
    #[test]
    fn missing_or_incomplete_publisher_disables_installation() {
        assert!(publisher_from(None, None).unwrap().is_none());
        assert!(publisher_from(Some(&test_key()), None).is_err());
        assert!(publisher_from(None, Some("https://example.com/latest.json")).is_err());
        assert!(
            publisher_from(Some("not-a-key"), Some("https://example.com/latest.json")).is_err()
        );
        if option_env!("MAOBU_UPDATE_PUBLIC_KEY").is_none()
            && option_env!("MAOBU_UPDATE_ENDPOINT").is_none()
        {
            let state = SignedUpdateState::default();
            let status = state.read().unwrap();
            assert!(!status.configured);
            assert_eq!(status.status, "disabled");
            assert!(status.update.is_none());
            assert!(status.endpoint.is_none());
        }
    }
    #[test]
    fn publisher_is_pinned_to_a_valid_https_endpoint_without_embedded_secrets() {
        let key = test_key();
        for endpoint in [
            "http://example.com/latest.json",
            "file:///tmp/installer",
            "https://user:secret@example.com/latest.json",
            "https://example.com/latest.json?token=secret",
            "https://example.com/latest.json#fragment",
        ] {
            let error = publisher_from(Some(&key), Some(endpoint)).err().unwrap();
            assert!(!error.contains("secret"));
        }
        assert!(publisher_from(
            Some(&key),
            Some(
                "https://github.com/maobukeai/maobu-qianjing/releases/latest/download/latest.json"
            )
        )
        .unwrap()
        .is_some());
    }
    #[test]
    fn operation_guard_releases_on_all_paths() {
        let state = SignedUpdateState::default();
        let busy = state.begin().unwrap();
        assert!(state.begin().is_err());
        drop(busy);
        assert!(state.begin().is_ok());
    }
    #[test]
    fn failed_install_restarts_the_app_only_after_confirmed_session_cleanup() {
        use std::cell::RefCell;
        let actions = RefCell::new(Vec::new());
        let result = tauri::async_runtime::block_on(install_after_cleanup(
            || async {
                actions.borrow_mut().push("cleanup");
                Ok(())
            },
            || {
                actions.borrow_mut().push("install");
                Err("failed".to_owned())
            },
            || {
                actions.borrow_mut().push("restart");
            },
        ));
        assert!(result.unwrap_err().contains("app is restarting"));
        assert_eq!(*actions.borrow(), ["cleanup", "install", "restart"]);
        actions.borrow_mut().clear();
        let result = tauri::async_runtime::block_on(install_after_cleanup(
            || async {
                actions.borrow_mut().push("cleanup");
                Err("uncertain".to_owned())
            },
            || {
                actions.borrow_mut().push("install");
                Ok(())
            },
            || {
                actions.borrow_mut().push("restart");
            },
        ));
        assert!(result.is_err());
        assert_eq!(*actions.borrow(), ["cleanup"]);
    }
    #[cfg(windows)]
    #[test]
    fn release_metadata_cannot_relabel_an_older_signed_installer() {
        let signature = STANDARD.encode("untrusted comment: fixture\nsig\ntrusted comment: timestamp:1\tfile:MaobuBrowser_1.2.3_x64-setup.exe\nglobal\n");
        let url = Url::parse("https://github.com/maobukeai/maobu-qianjing/releases/download/v1.2.3/MaobuBrowser_1.2.3_x64-setup.exe").unwrap();
        assert!(validate_release("1.2.3", &url, &signature).is_ok());
        assert!(validate_release("9.9.9", &url, &signature).is_err());
        let relabeled = Url::parse("https://example.com/MaobuBrowser_9.9.9_x64-setup.exe").unwrap();
        assert!(validate_release("9.9.9", &relabeled, &signature).is_err());
        assert!(validate_release(
            "1.2.3",
            &Url::parse("http://example.com/MaobuBrowser_1.2.3_x64-setup.exe").unwrap(),
            &signature
        )
        .is_err());
        assert!(validate_release("1.2.3", &url, "invalid").is_err());
    }
}
