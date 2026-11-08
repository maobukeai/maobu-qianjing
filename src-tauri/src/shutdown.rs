use crate::sidecar::SidecarSupervisor;
use crate::{credentials::CredentialOrigin, workspaces::WorkspaceRuntime};
use reqwest::{redirect::Policy, Client};
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Default)]
pub(crate) struct CloseState {
    in_progress: AtomicBool,
}

impl CloseState {
    fn begin(&self) -> Result<(), String> {
        self.in_progress
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "desktop shutdown or restart is already in progress".to_owned())
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

async fn active_browser_count(origin: &str) -> Result<usize, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!("{origin}/ui/api/profiles"))
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
    workspace.validate_restart(&expected_workspace_id, &target_workspace_id)?;
    closing.begin()?;
    if let Err(error) = workspace.validate_restart(&expected_workspace_id, &target_workspace_id) {
        closing.in_progress.store(false, Ordering::Release);
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
        .title("关闭猫步·千境？")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNo)
        .show(move |confirmed| {
            if confirmed {
                finish_after_cleanup(app, window, sidecar, CleanupAction::Exit);
            } else {
                state.in_progress.store(false, Ordering::Release);
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
                return;
            }
            let app = app.clone();
            let window = window.clone();
            let sidecar = sidecar.clone();
            let state = state.clone();
            let origin = origin.clone();
            tauri::async_runtime::spawn(async move {
                let active = active_browser_count(&origin).await;
                if matches!(active, Ok(0)) {
                    finish_after_cleanup(app, window, sidecar, CleanupAction::Exit);
                } else {
                    ask_to_close(app, window, sidecar, state, active);
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{CloseState, Roster, RosterProfile};
    use std::sync::atomic::Ordering;

    #[test]
    fn close_and_restart_share_one_exclusive_transition() {
        let state = CloseState::default();
        assert!(state.begin().is_ok());
        assert!(state.begin().is_err());
        state.in_progress.store(false, Ordering::Release);
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
