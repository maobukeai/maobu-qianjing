use crate::desktop_close::{CloseGate, CloseIntent, Resolution, INTENT_EVENT, RESOLVED_EVENT};
use crate::sidecar::SidecarSupervisor;
use crate::{credentials::CredentialOrigin, workspaces::WorkspaceRuntime};
use reqwest::{redirect::Policy, Client};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

#[derive(Default)]
pub(crate) struct CloseState {
    transition: AtomicU8,
    frontend: Mutex<CloseGate>,
}

const IDLE: u8 = 0;
const CLOSING: u8 = 1;
const UPDATING: u8 = 2;
const UPDATE_IN_PROGRESS: &str =
    "A signed update is in progress. Wait for it to finish before closing or restarting the app.";

pub(crate) struct UpdateCloseGuard<'a>(&'a CloseState);
impl Drop for UpdateCloseGuard<'_> {
    fn drop(&mut self) {
        self.0.transition.store(IDLE, Ordering::Release);
    }
}

impl CloseState {
    fn begin(&self) -> Result<(), String> {
        self.transition
            .compare_exchange(IDLE, CLOSING, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|active| {
                if active == UPDATING {
                    UPDATE_IN_PROGRESS.to_owned()
                } else {
                    "desktop shutdown or restart is already in progress".to_owned()
                }
            })
    }
    /// Download through installer handoff is one transition, shared with close/restart.
    pub(crate) fn begin_update(&self) -> Result<UpdateCloseGuard<'_>, String> {
        self.transition
            .compare_exchange(IDLE, UPDATING, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| UpdateCloseGuard(self))
            .map_err(|active| {
                if active == UPDATING {
                    UPDATE_IN_PROGRESS.to_owned()
                } else {
                    "desktop shutdown or restart is already in progress".to_owned()
                }
            })
    }
    fn updating(&self) -> bool {
        self.transition.load(Ordering::Acquire) == UPDATING
    }
}

#[derive(Debug, Deserialize)]
struct Roster {
    profiles: Vec<RosterProfile>,
}

#[derive(Debug, Deserialize)]
struct RosterProfile {
    running: bool,
}

async fn active_browser_count(origin: &str, dashboard_session: &str) -> Result<usize, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!("{origin}/ui/api/profiles"))
        .header(crate::DESKTOP_SESSION_HEADER, dashboard_session)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() || response.content_length().unwrap_or(0) > 2 * 1024 * 1024 {
        return Err("profile activity is unavailable".to_owned());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("profile activity is unavailable".to_owned());
    }
    let roster: Roster =
        serde_json::from_slice(&bytes).map_err(|_| "profile activity is unavailable".to_owned())?;
    Ok(roster
        .profiles
        .iter()
        .filter(|profile| profile.running)
        .count())
}

#[derive(Clone, Copy)]
enum CleanupAction {
    Exit,
    Restart,
}

pub(crate) async fn graceful_sidecar_cleanup(sidecar: &SidecarSupervisor) -> Result<(), String> {
    sidecar.request_shutdown()?;
    sidecar.wait_for_shutdown().await
}

pub(crate) fn exit_after_cleanup_failure(
    app: AppHandle,
    sidecar: &SidecarSupervisor,
    error: String,
) {
    exit_after_cleanup_failure_message(
        app,
        sidecar,
        "猫步·千境关闭失败",
        format!("猫步·千境无法确认浏览器是否已安全清理。{error}"),
    );
}

fn exit_after_cleanup_failure_message(
    app: AppHandle,
    sidecar: &SidecarSupervisor,
    title: &str,
    message: String,
) {
    let _ = sidecar.kill_owned();
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| app.exit(1));
}

fn finish_after_cleanup(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    action: CleanupAction,
) {
    let _ = window.hide();
    tauri::async_runtime::spawn(async move {
        match graceful_sidecar_cleanup(&sidecar).await {
            Ok(()) => match action {
                CleanupAction::Exit => app.exit(0),
                CleanupAction::Restart => app.request_restart(),
            },
            Err(error) => exit_after_cleanup_failure(app, &sidecar, error),
        }
    });
}

#[tauri::command]
pub fn restart_after_mode_change(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: tauri::State<'_, SidecarSupervisor>,
    origin: tauri::State<'_, CredentialOrigin>,
    workspace: tauri::State<'_, WorkspaceRuntime>,
    closing: tauri::State<'_, Arc<CloseState>>,
) -> Result<(), String> {
    crate::workspaces::authorize_workspace_window(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    // The compatibility command cannot restart into an unchecked catalog target.
    workspace.validate_restart(&workspace.active.id, &workspace.active.id)?;
    closing.begin()?;
    finish_after_cleanup(app, window, sidecar.inner().clone(), CleanupAction::Restart);
    Ok(())
}

#[tauri::command]
pub fn restart_workspace(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: tauri::State<'_, SidecarSupervisor>,
    origin: tauri::State<'_, CredentialOrigin>,
    workspace: tauri::State<'_, WorkspaceRuntime>,
    closing: tauri::State<'_, Arc<CloseState>>,
    expected_workspace_id: String,
    target_workspace_id: String,
) -> Result<(), String> {
    crate::workspaces::authorize_workspace_window(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    workspace.validate_restart(&expected_workspace_id, &target_workspace_id)?;
    closing.begin()?;
    if let Err(error) = workspace.validate_restart(&expected_workspace_id, &target_workspace_id) {
        closing.transition.store(IDLE, Ordering::Release);
        return Err(error);
    }
    let workspace = workspace.inner().clone();
    let sidecar = sidecar.inner().clone();
    let _ = window.hide();
    tauri::async_runtime::spawn(async move {
        match graceful_sidecar_cleanup(&sidecar).await {
            Ok(()) => match workspace.validate_restart(&expected_workspace_id, &target_workspace_id) {
                Ok(_) => app.request_restart(),
                Err(error) => exit_after_cleanup_failure_message(
                    app, &sidecar, "工作区切换已停止",
                    format!("工作区目录或切换目标发生变化，猫步·千境已停止重启。请检查工作区后重新打开应用。{error}"),
                ),
            },
            Err(error) => exit_after_cleanup_failure(app, &sidecar, error),
        }
    });
    Ok(())
}

fn ask_to_close(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    state: Arc<CloseState>,
    active: Result<usize, String>,
    intent: Option<CloseIntent>,
) {
    let message = match active {
        Ok(count) => format!(
            "当前有 {count} 个浏览器会话正在运行。猫步·千境将在退出前保存会话状态并关闭浏览器。"
        ),
        Err(_) => "无法确认浏览器运行状态。猫步·千境将在退出前保存会话状态并关闭正在运行的浏览器。"
            .to_owned(),
    };
    app.dialog()
        .message(message)
        .parent(&window)
        .title("关闭猫步·千境？")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNo)
        .show(move |confirmed| {
            if confirmed {
                finish_after_cleanup(app, window, sidecar, CleanupAction::Exit);
            } else {
                if let Some(intent) = intent {
                    if let Ok(mut gate) = state.frontend.lock() {
                        gate.finish_cancel(&intent);
                    }
                    emit_close_resolved(&window, &intent, "cancelled");
                }
                state.transition.store(IDLE, Ordering::Release);
            }
        });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloseRegistration {
    session_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseResolved {
    session_id: String,
    request_id: String,
    outcome: &'static str,
}
fn emit_close_resolved(window: &WebviewWindow, intent: &CloseIntent, outcome: &'static str) {
    let _ = window.emit_to(
        window.label(),
        RESOLVED_EVENT,
        CloseResolved {
            session_id: intent.session_id.clone(),
            request_id: intent.request_id.clone(),
            outcome,
        },
    );
}

#[tauri::command]
pub(crate) fn desktop_close_register(
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    closing: tauri::State<'_, Arc<CloseState>>,
) -> Result<CloseRegistration, String> {
    crate::credentials::authorize(&window, &origin)?;
    let session_id = hex::encode(rand::random::<[u8; 32]>());
    let cancelled = {
        let mut gate = closing
            .frontend
            .lock()
            .map_err(|_| "Desktop close state is unavailable")?;
        if closing.transition.load(Ordering::Acquire) != IDLE && !gate.awaiting() {
            return Err("Desktop shutdown or recovery is already in progress".into());
        }
        let cancelled = gate.register(session_id.clone())?;
        if closing.transition.load(Ordering::Acquire) != IDLE && cancelled.is_none() {
            gate.unregister(&session_id);
            return Err("Desktop shutdown or recovery is already in progress".into());
        }
        cancelled
    };
    if let Some(intent) = cancelled {
        closing.transition.store(IDLE, Ordering::Release);
        emit_close_resolved(&window, &intent, "cancelled");
    }
    Ok(CloseRegistration { session_id })
}

#[tauri::command]
pub(crate) fn desktop_close_unregister(
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    closing: tauri::State<'_, Arc<CloseState>>,
    session_id: String,
) -> Result<(), String> {
    crate::credentials::authorize(&window, &origin)?;
    let cancelled = closing
        .frontend
        .lock()
        .map_err(|_| "Desktop close state is unavailable")?
        .unregister(&session_id);
    if let Some(intent) = cancelled {
        closing.transition.store(IDLE, Ordering::Release);
        emit_close_resolved(&window, &intent, "cancelled");
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn desktop_close_resolve(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    sidecar: tauri::State<'_, SidecarSupervisor>,
    closing: tauri::State<'_, Arc<CloseState>>,
    session_id: String,
    request_id: String,
    delivery_id: u32,
    decision: String,
) -> Result<Resolution, String> {
    crate::credentials::authorize(&window, &origin)?;
    if !matches!(decision.as_str(), "hold" | "cancel" | "proceed") {
        return Err("Invalid desktop close decision".into());
    }
    let resolution = {
        let mut gate = closing
            .frontend
            .lock()
            .map_err(|_| "Desktop close state is unavailable")?;
        if decision == "hold" {
            gate.hold(&session_id, &request_id, delivery_id)
        } else {
            gate.resolve(&session_id, &request_id, decision == "proceed")
        }
    };
    let intent = CloseIntent {
        session_id,
        request_id,
        delivery_id,
    };
    match resolution {
        Resolution::Cancelled => {
            closing.transition.store(IDLE, Ordering::Release);
            emit_close_resolved(&window, &intent, "cancelled");
        }
        Resolution::Continuing => continue_close(
            app,
            window,
            sidecar.inner().clone(),
            closing.inner().clone(),
            origin.0.clone(),
            Some(intent),
        ),
        Resolution::Holding | Resolution::Stale => {}
    }
    Ok(resolution)
}

fn continue_close(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    state: Arc<CloseState>,
    origin: String,
    intent: Option<CloseIntent>,
) {
    tauri::async_runtime::spawn(async move {
        let active = {
            let session = app.state::<crate::DesktopDashboardSession>();
            active_browser_count(&origin, session.0.as_str()).await
        };
        if matches!(active, Ok(0)) {
            finish_after_cleanup(app, window, sidecar, CleanupAction::Exit);
        } else {
            ask_to_close(app, window, sidecar, state, active, intent);
        }
    });
}

const RECOVERY_EXIT: &str = "仍然退出";
fn explicit_recovery_exit(result: &MessageDialogResult) -> bool {
    matches!(result, MessageDialogResult::Custom(value) if value == RECOVERY_EXIT)
}
fn recover_unavailable_frontend(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    state: Arc<CloseState>,
    origin: String,
) {
    // The first/default choice is safe. Escape/Cancel/dialog failure never means exit.
    app.dialog()
        .message("无法确认界面状态。退出可能丢失尚未保存的输入，正在提交的更改也可能无法确认。选择“仍然退出”后，应用仍会执行现有的浏览器会话保存和关闭流程。")
        .title("界面暂时无法确认关闭")
        .parent(&window)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom("继续使用".into(), RECOVERY_EXIT.into(), "取消".into()))
        .show_with_result(move |result| {
            if explicit_recovery_exit(&result) { continue_close(app, window, sidecar, state, origin, None); }
            else { state.transition.store(IDLE, Ordering::Release); }
        });
}

fn deliver_close_intent(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    state: Arc<CloseState>,
    origin: String,
    intent: CloseIntent,
) {
    if window
        .emit_to(window.label(), INTENT_EVENT, intent.clone())
        .is_err()
    {
        let cancelled = state
            .frontend
            .lock()
            .map(|mut gate| gate.cancel_awaiting(&intent))
            .unwrap_or(false);
        if cancelled {
            emit_close_resolved(&window, &intent, "unavailable");
            recover_unavailable_frontend(app, window, sidecar, state, origin);
        }
        return;
    }
    tauri::async_runtime::spawn(async move {
        // This detects missing delivery ACK only. A live user reviewing a draft
        // is never timed out, and no timer approves shutdown.
        tokio::time::sleep(Duration::from_secs(8)).await;
        let cancelled = state
            .frontend
            .lock()
            .map(|mut gate| gate.cancel_awaiting(&intent))
            .unwrap_or(false);
        if cancelled {
            emit_close_resolved(&window, &intent, "unavailable");
            recover_unavailable_frontend(app, window, sidecar, state, origin);
        }
    });
}

pub fn install_close_handler(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    origin: String,
) {
    let state = app.state::<Arc<CloseState>>().inner().clone();
    window.clone().on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if state.begin().is_err() {
                if state.updating() {
                    app.dialog()
                        .message("正在下载或安装签名更新，请保持应用开启。更新完成或失败后即可关闭或重启应用。")
                        .parent(&window)
                        .title("更新正在进行")
                        .kind(MessageDialogKind::Info)
                        .buttons(MessageDialogButtons::Ok)
                        .show(|_| {});
                } else {
                    let retry = state.frontend.lock().ok().and_then(|mut gate| gate.retry_delivery());
                    if let Some(intent) = retry { deliver_close_intent(app.clone(), window.clone(), sidecar.clone(), state.clone(), origin.clone(), intent); }
                }
                return;
            }
            let intent = state.frontend.lock().ok().and_then(|mut gate| gate.begin(hex::encode(rand::random::<[u8; 32]>())));
            if let Some(intent) = intent { deliver_close_intent(app.clone(), window.clone(), sidecar.clone(), state.clone(), origin.clone(), intent); }
            else { recover_unavailable_frontend(app.clone(), window.clone(), sidecar.clone(), state.clone(), origin.clone()); }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{explicit_recovery_exit, CloseState, Roster, RosterProfile, IDLE, RECOVERY_EXIT};
    use std::sync::atomic::Ordering;
    use tauri_plugin_dialog::MessageDialogResult;

    #[test]
    fn close_and_restart_share_one_exclusive_transition() {
        let state = CloseState::default();
        assert!(state.begin().is_ok());
        assert!(state.begin().is_err());
        state.transition.store(IDLE, Ordering::Release);
        assert!(state.begin().is_ok());
    }
    #[test]
    fn recovery_requires_the_exact_destructive_button_and_escape_cancel_are_safe() {
        for result in [
            MessageDialogResult::Yes,
            MessageDialogResult::No,
            MessageDialogResult::Ok,
            MessageDialogResult::Cancel,
            MessageDialogResult::Custom("继续使用".into()),
            MessageDialogResult::Custom("取消".into()),
            MessageDialogResult::Custom("".into()),
        ] {
            assert!(!explicit_recovery_exit(&result));
        }
        assert!(explicit_recovery_exit(&MessageDialogResult::Custom(
            RECOVERY_EXIT.into()
        )));
    }

    #[test]
    fn signed_update_blocks_close_restart_and_another_update_until_guard_drops() {
        let state = CloseState::default();
        let update = state.begin_update().unwrap();
        assert!(state.updating());
        assert!(state
            .begin()
            .unwrap_err()
            .contains("signed update is in progress"));
        assert!(state.begin_update().is_err());
        drop(update);
        assert!(!state.updating());
        assert!(state.begin().is_ok());
    }

    #[test]
    fn signed_update_cannot_start_during_close_and_failure_releases_the_transition() {
        let state = CloseState::default();
        state.begin().unwrap();
        assert!(state.begin_update().is_err());
        state.transition.store(IDLE, Ordering::Release);
        let fail_download = || -> Result<(), &str> {
            let _update = state.begin_update().unwrap();
            Err("download or signature failed")
        };
        assert!(fail_download().is_err());
        assert!(state.begin_update().is_ok());
        assert!(state.begin().is_ok());
    }

    #[test]
    fn counts_only_active_roster_entries() {
        let roster = Roster {
            profiles: vec![
                RosterProfile { running: true },
                RosterProfile { running: false },
                RosterProfile { running: true },
            ],
        };
        assert_eq!(
            roster
                .profiles
                .iter()
                .filter(|profile| profile.running)
                .count(),
            2
        );
    }
}
