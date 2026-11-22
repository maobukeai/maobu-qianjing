//! Verified browser process memory trimming (`K32EmptyWorkingSet`) and host memory inspection.
//!
//! Security boundary: never accepts arbitrary PIDs from the frontend. Only trims process trees
//! verified against the sidecar's authenticated `GET /ui/api/windows/registered-launches` list,
//! process image path, and creation-time anti-PID-reuse checks.

use crate::credentials::CredentialOrigin;
use serde::Serialize;
use std::collections::HashSet;
use tauri::{AppHandle, WebviewWindow};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimMemoryResult {
    pub profile_id: String,
    pub ok: bool,
    pub process_count: usize,
    pub trimmed_count: usize,
    pub before_rss_bytes: u64,
    pub after_rss_bytes: u64,
    pub freed_bytes: u64,
    pub error: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemoryStatus {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
    pub memory_load_percent: u32,
}

#[allow(dead_code)]
pub(crate) fn build_system_memory_status(
    total_bytes: u64,
    available_bytes: u64,
    reported_load_percent: Option<u32>,
) -> SystemMemoryStatus {
    let clamped_avail = available_bytes.min(total_bytes);
    let used_bytes = total_bytes.saturating_sub(clamped_avail);
    let memory_load_percent = reported_load_percent.unwrap_or_else(|| {
        if total_bytes == 0 {
            0
        } else {
            (((used_bytes as u128).saturating_mul(100)) / (total_bytes as u128)) as u32
        }
    });
    SystemMemoryStatus {
        total_bytes,
        available_bytes: clamped_avail,
        used_bytes,
        memory_load_percent: memory_load_percent.min(100),
    }
}

pub(crate) fn select_trim_target_ids(
    requested_ids: &[String],
    verified_ids: &[String],
) -> Vec<(String, bool)> {
    let available: HashSet<&str> = verified_ids.iter().map(String::as_str).collect();
    if requested_ids.is_empty() {
        return verified_ids.iter().cloned().map(|id| (id, true)).collect();
    }
    let mut seen = HashSet::new();
    let mut selected = Vec::new();
    for raw in requested_ids {
        let id = raw.trim();
        if id.is_empty() || !seen.insert(id.to_owned()) {
            continue;
        }
        selected.push((id.to_owned(), available.contains(id)));
    }
    selected
}

pub(crate) fn summarize_trim_result(
    profile_id: String,
    process_count: usize,
    trimmed_count: usize,
    before_rss_bytes: u64,
    after_rss_bytes: u64,
) -> TrimMemoryResult {
    let freed_bytes = before_rss_bytes.saturating_sub(after_rss_bytes);
    let ok = trimmed_count > 0;
    let error = if ok {
        None
    } else if process_count == 0 {
        Some("no verified live processes were found for this profile".to_owned())
    } else {
        Some("could not trim working set for any process in this profile tree".to_owned())
    };
    TrimMemoryResult {
        profile_id,
        ok,
        process_count,
        trimmed_count,
        before_rss_bytes,
        after_rss_bytes,
        freed_bytes,
        error,
    }
}

#[cfg(windows)]
mod win32 {
    use super::{
        build_system_memory_status, select_trim_target_ids, summarize_trim_result,
        SystemMemoryStatus, TrimMemoryResult,
    };
    use crate::win32_window_registry::{
        open_process, query_process_creation_time, VerifiedProcessTree,
    };
    use std::{collections::HashMap, mem::size_of};
    use windows::Win32::{
        Foundation::HANDLE,
        System::{
            ProcessStatus::{K32EmptyWorkingSet, K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
            Threading::{PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA},
        },
    };

    fn read_working_set_bytes(handle: HANDLE) -> Option<u64> {
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        let ok = unsafe { K32GetProcessMemoryInfo(handle, &mut counters, counters.cb).as_bool() };
        ok.then_some(counters.WorkingSetSize as u64)
    }

    pub(crate) fn trim_verified_process_trees(
        trees: &[VerifiedProcessTree],
        requested_ids: &[String],
    ) -> Vec<TrimMemoryResult> {
        let own_pid = std::process::id();
        let by_id: HashMap<&str, &VerifiedProcessTree> = trees
            .iter()
            .map(|tree| (tree.launch.profile_id.as_str(), tree))
            .collect();
        let verified_ids: Vec<String> = trees
            .iter()
            .map(|tree| tree.launch.profile_id.clone())
            .collect();
        let targets = select_trim_target_ids(requested_ids, &verified_ids);

        let mut results = Vec::with_capacity(targets.len());
        for (profile_id, found) in targets {
            let Some(&tree) = found.then(|| by_id.get(profile_id.as_str())).flatten() else {
                results.push(TrimMemoryResult {
                    profile_id,
                    ok: false,
                    process_count: 0,
                    trimmed_count: 0,
                    before_rss_bytes: 0,
                    after_rss_bytes: 0,
                    freed_bytes: 0,
                    error: Some("profile is not running or could not be verified".to_owned()),
                });
                continue;
            };

            let mut process_count = 0usize;
            let mut trimmed_count = 0usize;
            let mut before_total = 0u64;
            let mut after_total = 0u64;

            for &pid in &tree.allowed_pids {
                if pid == 0 || pid == own_pid {
                    continue;
                }
                let Some(handle) =
                    open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA)
                else {
                    continue;
                };
                // Re-verify creation time on the live handle to close PID-reuse TOCTOU windows.
                let Some(ct) = query_process_creation_time(handle.0) else {
                    continue;
                };
                if ct < tree.root_creation_time {
                    continue;
                }
                process_count += 1;
                let before = read_working_set_bytes(handle.0).unwrap_or(0);
                before_total = before_total.saturating_add(before);

                let emptied = unsafe { K32EmptyWorkingSet(handle.0).as_bool() };
                if emptied {
                    trimmed_count += 1;
                }
                let after = read_working_set_bytes(handle.0).unwrap_or(before);
                after_total = after_total.saturating_add(after);
            }

            results.push(summarize_trim_result(
                profile_id,
                process_count,
                trimmed_count,
                before_total,
                after_total,
            ));
        }

        results
    }

    #[allow(dead_code)]
    pub(crate) fn query_system_memory_status() -> Result<SystemMemoryStatus, String> {
        let mut status = MEMORYSTATUSEX {
            dwLength: size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        unsafe { GlobalMemoryStatusEx(&mut status) }
            .map_err(|error| format!("GlobalMemoryStatusEx failed: {error}"))?;
        Ok(build_system_memory_status(
            status.ullTotalPhys,
            status.ullAvailPhys,
            Some(status.dwMemoryLoad),
        ))
    }
}

#[allow(dead_code)]
pub(crate) fn query_system_memory() -> Result<SystemMemoryStatus, String> {
    #[cfg(windows)]
    {
        win32::query_system_memory_status()
    }
    #[cfg(not(windows))]
    {
        Err(crate::win32_window_registry::UNSUPPORTED_PLATFORM_ERROR.to_owned())
    }
}

#[tauri::command]
pub async fn system_trim_process_memory(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    dashboard_session: tauri::State<'_, crate::DesktopDashboardSession>,
    profile_ids: Vec<String>,
) -> Result<Vec<TrimMemoryResult>, String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    #[cfg(not(windows))]
    {
        let _ = (dashboard_session, profile_ids);
        Err(crate::win32_window_registry::UNSUPPORTED_PLATFORM_ERROR.to_owned())
    }
    #[cfg(windows)]
    {
        let origin_url = origin.0.clone();
        let session = dashboard_session.0.as_str().to_owned();
        let launches =
            crate::win32_window_registry::fetch_registered_launches(&origin_url, &session).await?;
        tauri::async_runtime::spawn_blocking(move || {
            let trees = crate::win32_window_registry::resolve_process_trees(&launches)?;
            Ok(win32::trim_verified_process_trees(&trees, &profile_ids))
        })
        .await
        .map_err(|error| format!("process memory trim worker failed: {error}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_requested_or_all_verified_trim_targets_in_order() {
        let verified = vec!["p1".into(), "p2".into()];
        // Empty request trims all verified running profiles
        assert_eq!(
            select_trim_target_ids(&[], &verified),
            vec![("p1".into(), true), ("p2".into(), true)]
        );
        // Explicit list deduplicates and marks missing profiles cleanly
        assert_eq!(
            select_trim_target_ids(&["p2".into(), "missing".into(), "p2".into()], &verified),
            vec![("p2".into(), true), ("missing".into(), false)]
        );
    }

    #[test]
    fn summarizes_trim_deltas_without_underflow_and_serializes_camel_case() {
        let ok = summarize_trim_result("p1".into(), 4, 4, 200_000_000, 120_000_000);
        assert!(ok.ok);
        assert_eq!(ok.freed_bytes, 80_000_000);
        assert!(ok.error.is_none());

        // RSS spike during trim never underflows freed_bytes
        let spike = summarize_trim_result("p2".into(), 2, 2, 100, 150);
        assert!(spike.ok);
        assert_eq!(spike.freed_bytes, 0);

        let zero_trimmed = summarize_trim_result("p3".into(), 2, 0, 100, 100);
        assert!(!zero_trimmed.ok);
        assert!(zero_trimmed.error.is_some());

        let json = serde_json::to_value(&ok).unwrap();
        assert_eq!(json["profileId"], "p1");
        assert_eq!(json["beforeRssBytes"], 200_000_000);
        assert_eq!(json["afterRssBytes"], 120_000_000);
        assert_eq!(json["freedBytes"], 80_000_000);
    }

    #[test]
    fn computes_host_memory_status_cleanly() {
        let status = build_system_memory_status(16_000, 4_000, None);
        assert_eq!(status.used_bytes, 12_000);
        assert_eq!(status.memory_load_percent, 75);

        let clamped = build_system_memory_status(8_000, 9_999, Some(150));
        assert_eq!(clamped.available_bytes, 8_000);
        assert_eq!(clamped.used_bytes, 0);
        assert_eq!(clamped.memory_load_percent, 100);
    }

    #[cfg(windows)]
    #[test]
    fn queries_live_windows_system_memory_status() {
        let status = query_system_memory().unwrap();
        assert!(status.total_bytes > 0);
        assert!(status.available_bytes <= status.total_bytes);
        assert!(status.memory_load_percent <= 100);
    }
}
