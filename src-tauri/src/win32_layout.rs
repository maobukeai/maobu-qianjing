//! Win32 multi-monitor window layout engine and window actions.
//!
//! Computes flicker-free, DWM-shadow-compensated geometry for verified managed browser windows
//! and commits placements atomically via `BeginDeferWindowPos` / `DeferWindowPos` / `EndDeferWindowPos`.

#[cfg(windows)]
use crate::win32_window_registry::resolve_verified_windows;
use crate::{credentials::CredentialOrigin, win32_window_registry::RectPx};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};

pub(crate) const MIN_TILE_WIDTH: i32 = 360;
pub(crate) const MIN_TILE_HEIGHT: i32 = 280;
pub(crate) const MAX_GRID_DIMENSION: u32 = 12;
pub(crate) const MAX_GAP_PX: i32 = 32;
pub(crate) const MAX_PADDING_PX: i32 = 64;
const DEFAULT_GAP_PX: i32 = 6;
const DEFAULT_PADDING_PX: i32 = 8;
const DEFAULT_CASCADE_OFFSET_PX: i32 = 32;
const MAX_SHADOW_INSET_PX: i32 = 32;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: String,
    pub name: String,
    pub is_primary: bool,
    pub bounds: RectPx,
    pub work_area: RectPx,
    pub dpi: u32,
    pub scale_percent: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArrangeMode {
    Grid,
    CustomGrid,
    Cascade,
    MasterDetail,
    Gather,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GatherStyle {
    Minimize,
    Restore,
    StackCenter,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangeRequest {
    pub mode: ArrangeMode,
    #[serde(default)]
    pub profile_ids: Vec<String>,
    #[serde(default, alias = "monitorTarget", alias = "monitorId")]
    pub monitor: Option<String>,
    #[serde(default)]
    pub cols: Option<u32>,
    #[serde(default)]
    pub rows: Option<u32>,
    #[serde(default)]
    pub gap_px: Option<i32>,
    #[serde(default)]
    pub padding_px: Option<i32>,
    #[serde(default)]
    pub cascade_offset_px: Option<i32>,
    #[serde(default)]
    pub master_profile_id: Option<String>,
    #[serde(default)]
    pub master_ratio: Option<f64>,
    #[serde(default, alias = "gatherMode", alias = "gatherStyle")]
    pub gather_action: Option<GatherStyle>,
    #[serde(default)]
    pub restore_minimized: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangedWindowEntry {
    pub profile_id: String,
    pub hwnd_hex: String,
    pub monitor_id: String,
    pub rect: RectPx,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrangeResult {
    pub ok: bool,
    pub mode: ArrangeMode,
    pub arranged: Vec<ArrangedWindowEntry>,
    pub skipped: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowActionKind {
    Focus,
    Minimize,
    Restore,
    Topmost,
    Untopmost,
    CloseNotice,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowActionRequest {
    pub action: WindowActionKind,
    #[serde(default)]
    pub profile_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowActionFailure {
    pub profile_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowActionResult {
    pub ok: bool,
    pub action: WindowActionKind,
    pub affected: Vec<String>,
    pub missing: Vec<String>,
    pub failed: Vec<WindowActionFailure>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ShadowInsets {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

pub(crate) fn compute_shadow_insets(
    window_rect: RectPx,
    extended_frame_bounds: RectPx,
) -> ShadowInsets {
    if !window_rect.is_non_empty() || !extended_frame_bounds.is_non_empty() {
        return ShadowInsets::default();
    }
    ShadowInsets {
        left: extended_frame_bounds
            .left
            .saturating_sub(window_rect.left)
            .clamp(0, MAX_SHADOW_INSET_PX),
        top: extended_frame_bounds
            .top
            .saturating_sub(window_rect.top)
            .clamp(0, MAX_SHADOW_INSET_PX),
        right: window_rect
            .right
            .saturating_sub(extended_frame_bounds.right)
            .clamp(0, MAX_SHADOW_INSET_PX),
        bottom: window_rect
            .bottom
            .saturating_sub(extended_frame_bounds.bottom)
            .clamp(0, MAX_SHADOW_INSET_PX),
    }
}

pub(crate) fn compensate_rect_for_shadow(desired_visible: RectPx, insets: ShadowInsets) -> RectPx {
    RectPx::new(
        desired_visible.left.saturating_sub(insets.left),
        desired_visible.top.saturating_sub(insets.top),
        desired_visible.right.saturating_add(insets.right),
        desired_visible.bottom.saturating_add(insets.bottom),
    )
}

fn inner_work_area(work: RectPx, padding_px: i32) -> RectPx {
    let pad_x = padding_px.min((work.width() / 4).max(0));
    let pad_y = padding_px.min((work.height() / 4).max(0));
    RectPx::new(
        work.left + pad_x,
        work.top + pad_y,
        (work.right - pad_x).max(work.left + 1),
        (work.bottom - pad_y).max(work.top + 1),
    )
}

pub(crate) fn compute_auto_grid_dimensions(count: usize, work_w: i32, work_h: i32) -> (u32, u32) {
    if count <= 1 {
        return (1, 1);
    }
    let aspect = (work_w.max(1) as f64) / (work_h.max(1) as f64);
    let raw_cols = ((count as f64) * aspect / 1.35).sqrt().ceil() as u32;
    let cols = raw_cols.clamp(1, count as u32);
    let rows = (count as u32).div_ceil(cols).max(1);
    (cols, rows)
}

pub(crate) fn compute_grid_rects(
    work: RectPx,
    count: usize,
    cols: u32,
    rows: u32,
    gap_px: i32,
    padding_px: i32,
) -> Vec<RectPx> {
    if count == 0 {
        return Vec::new();
    }
    let inner = inner_work_area(work, padding_px);
    let cols = cols.max(1);
    let rows = rows.max(1);
    let inner_w = inner.width().max(1);
    let inner_h = inner.height().max(1);
    let min_w = MIN_TILE_WIDTH.min(inner_w);
    let min_h = MIN_TILE_HEIGHT.min(inner_h);

    let total_gap_x = gap_px.saturating_mul((cols as i32).saturating_sub(1));
    let total_gap_y = gap_px.saturating_mul((rows as i32).saturating_sub(1));
    let raw_cell_w = (inner_w - total_gap_x) / (cols as i32);
    let raw_cell_h = (inner_h - total_gap_y) / (rows as i32);

    let tile_w = raw_cell_w.max(min_w).min(inner_w);
    let tile_h = raw_cell_h.max(min_h).min(inner_h);

    let per_page = (cols as usize).saturating_mul(rows as usize).max(1);
    let mut result = Vec::with_capacity(count);

    for index in 0..count {
        let page = (index / per_page) as i32;
        let slot = index % per_page;
        let col = (slot as u32) % cols;
        let row = (slot as u32) / cols;

        let base_x = if raw_cell_w >= min_w || cols == 1 {
            inner.left + (col as i32) * (tile_w + gap_px)
        } else {
            // Overlap gracefully across available span without spilling outside work area.
            let span_x = (inner_w - tile_w).max(0);
            inner.left + (span_x * (col as i32)) / ((cols - 1) as i32)
        };
        let base_y = if raw_cell_h >= min_h || rows == 1 {
            inner.top + (row as i32) * (tile_h + gap_px)
        } else {
            let span_y = (inner_h - tile_h).max(0);
            inner.top + (span_y * (row as i32)) / ((rows - 1) as i32)
        };

        let page_offset = (page % 6) * 24;
        let max_left = (inner.right - tile_w).max(inner.left);
        let max_top = (inner.bottom - tile_h).max(inner.top);
        let x = (base_x + page_offset).clamp(inner.left, max_left);
        let y = (base_y + page_offset).clamp(inner.top, max_top);
        result.push(RectPx::new(x, y, x + tile_w, y + tile_h));
    }

    result
}

pub(crate) fn compute_cascade_rects(
    work: RectPx,
    count: usize,
    offset_px: i32,
    padding_px: i32,
) -> Vec<RectPx> {
    if count == 0 {
        return Vec::new();
    }
    let inner = inner_work_area(work, padding_px);
    let inner_w = inner.width().max(1);
    let inner_h = inner.height().max(1);
    let win_w = ((inner_w as f64) * 0.65)
        .round()
        .clamp(MIN_TILE_WIDTH.min(inner_w) as f64, inner_w as f64) as i32;
    let win_h = ((inner_h as f64) * 0.80)
        .round()
        .clamp(MIN_TILE_HEIGHT.min(inner_h) as f64, inner_h as f64) as i32;
    let step = offset_px.clamp(16, 96);
    let max_dx = (inner_w - win_w).max(0);
    let max_dy = (inner_h - win_h).max(0);
    let max_steps = (max_dx / step).min(max_dy / step).max(0) as usize + 1;

    let mut rects = Vec::with_capacity(count);
    for index in 0..count {
        let step_idx = (index % max_steps) as i32;
        let x = (inner.left + step_idx * step).min(inner.right - win_w);
        let y = (inner.top + step_idx * step).min(inner.bottom - win_h);
        rects.push(RectPx::new(x, y, x + win_w, y + win_h));
    }
    rects
}

pub(crate) fn compute_stack_center_rects(
    work: RectPx,
    count: usize,
    padding_px: i32,
) -> Vec<RectPx> {
    if count == 0 {
        return Vec::new();
    }
    let inner = inner_work_area(work, padding_px);
    let inner_w = inner.width().max(1);
    let inner_h = inner.height().max(1);
    let win_w = ((inner_w as f64) * 0.70)
        .round()
        .clamp(480i32.min(inner_w) as f64, inner_w as f64) as i32;
    let win_h = ((inner_h as f64) * 0.78)
        .round()
        .clamp(360i32.min(inner_h) as f64, inner_h as f64) as i32;
    let x = inner.left + (inner_w - win_w) / 2;
    let y = inner.top + (inner_h - win_h) / 2;
    vec![RectPx::new(x, y, x + win_w, y + win_h); count]
}

/// Hamilton largest-remainder apportionment proportional to each monitor's usable work area.
pub(crate) fn allocate_windows_across_monitors(
    count: usize,
    monitors: &[MonitorInfo],
) -> Vec<usize> {
    if monitors.is_empty() {
        return Vec::new();
    }
    if count == 0 {
        return vec![0; monitors.len()];
    }
    let weights: Vec<u128> = monitors
        .iter()
        .map(|monitor| monitor.work_area.area().max(1) as u128)
        .collect();
    let total_weight: u128 = weights.iter().sum::<u128>().max(1);

    let mut counts = vec![0usize; monitors.len()];
    let mut remainders: Vec<(usize, u128)> = Vec::with_capacity(monitors.len());
    let mut assigned = 0usize;

    for (idx, &weight) in weights.iter().enumerate() {
        let numerator = (count as u128).saturating_mul(weight);
        let floor_val = (numerator / total_weight) as usize;
        let rem = numerator % total_weight;
        counts[idx] = floor_val;
        assigned += floor_val;
        remainders.push((idx, rem));
    }

    remainders.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let leftover = count.saturating_sub(assigned);
    for &(idx, _) in remainders.iter().take(leftover) {
        counts[idx] += 1;
    }
    counts
}

pub(crate) fn select_single_monitor<'a>(
    monitors: &'a [MonitorInfo],
    selector: &str,
    active_monitor_id: Option<&str>,
) -> Result<&'a MonitorInfo, String> {
    if monitors.is_empty() {
        return Err("no display monitors were detected".to_owned());
    }
    match selector {
        "" | "primary" => Ok(monitors
            .iter()
            .find(|monitor| monitor.is_primary)
            .unwrap_or(&monitors[0])),
        "active" => {
            if let Some(active_id) = active_monitor_id.filter(|value| !value.is_empty()) {
                if let Some(found) = monitors.iter().find(|monitor| monitor.id == active_id) {
                    return Ok(found);
                }
            }
            Ok(monitors
                .iter()
                .find(|monitor| monitor.is_primary)
                .unwrap_or(&monitors[0]))
        }
        specific => monitors
            .iter()
            .find(|monitor| monitor.id == specific)
            .ok_or_else(|| format!("requested monitor is unavailable: {specific}")),
    }
}

pub(crate) fn validate_arrange_request(req: &ArrangeRequest) -> Result<(i32, i32, i32), String> {
    let gap_px = req.gap_px.unwrap_or(DEFAULT_GAP_PX);
    if !(0..=MAX_GAP_PX).contains(&gap_px) {
        return Err(format!("gapPx must be between 0 and {MAX_GAP_PX}"));
    }
    let padding_px = req.padding_px.unwrap_or(DEFAULT_PADDING_PX);
    if !(0..=MAX_PADDING_PX).contains(&padding_px) {
        return Err(format!("paddingPx must be between 0 and {MAX_PADDING_PX}"));
    }
    let cascade_offset = req.cascade_offset_px.unwrap_or(DEFAULT_CASCADE_OFFSET_PX);
    if !(16..=96).contains(&cascade_offset) {
        return Err("cascadeOffsetPx must be between 16 and 96".to_owned());
    }
    if req.mode == ArrangeMode::CustomGrid {
        let cols = req
            .cols
            .ok_or_else(|| "custom_grid requires cols (1..12)".to_owned())?;
        let rows = req
            .rows
            .ok_or_else(|| "custom_grid requires rows (1..12)".to_owned())?;
        if !(1..=MAX_GRID_DIMENSION).contains(&cols) || !(1..=MAX_GRID_DIMENSION).contains(&rows) {
            return Err(format!(
                "custom_grid cols and rows must be between 1 and {MAX_GRID_DIMENSION}"
            ));
        }
    }
    if let Some(ratio) = req.master_ratio {
        if !ratio.is_finite() || !(0.30..=0.75).contains(&ratio) {
            return Err("masterRatio must be between 0.30 and 0.75".to_owned());
        }
    }
    Ok((gap_px, padding_px, cascade_offset))
}

/// Computes target `(monitor_id, desired_visible_rect)` for each window in `ordered_profile_ids`.
pub(crate) fn plan_window_placements(
    req: &ArrangeRequest,
    monitors: &[MonitorInfo],
    ordered_profile_ids: &[String],
    active_monitor_id: Option<&str>,
) -> Result<Vec<(String, RectPx)>, String> {
    let (gap_px, padding_px, cascade_offset) = validate_arrange_request(req)?;
    let count = ordered_profile_ids.len();
    if count == 0 {
        return Ok(Vec::new());
    }
    let selector = req.monitor.as_deref().unwrap_or("primary").trim();

    if req.mode == ArrangeMode::MasterDetail {
        let master_idx = req
            .master_profile_id
            .as_deref()
            .and_then(|id| ordered_profile_ids.iter().position(|item| item == id))
            .unwrap_or(0);
        let slave_indices: Vec<usize> = (0..count).filter(|&idx| idx != master_idx).collect();
        let mut placements = vec![(String::new(), RectPx::default()); count];

        if selector == "all" && monitors.len() >= 2 {
            let primary_idx = monitors
                .iter()
                .position(|monitor| monitor.is_primary)
                .unwrap_or(0);
            let master_mon = &monitors[primary_idx];
            placements[master_idx] = (
                master_mon.id.clone(),
                inner_work_area(master_mon.work_area, padding_px),
            );
            let secondary: Vec<MonitorInfo> = monitors
                .iter()
                .enumerate()
                .filter(|&(idx, _)| idx != primary_idx)
                .map(|(_, mon)| mon.clone())
                .collect();
            let shares = allocate_windows_across_monitors(slave_indices.len(), &secondary);
            let mut cursor = 0usize;
            for (mon, share) in secondary.iter().zip(shares) {
                if share == 0 {
                    continue;
                }
                let inner = inner_work_area(mon.work_area, padding_px);
                let (cols, rows) =
                    compute_auto_grid_dimensions(share, inner.width(), inner.height());
                let rects =
                    compute_grid_rects(mon.work_area, share, cols, rows, gap_px, padding_px);
                for rect in rects {
                    let target_idx = slave_indices[cursor];
                    placements[target_idx] = (mon.id.clone(), rect);
                    cursor += 1;
                }
            }
            return Ok(placements);
        }

        let monitor = select_single_monitor(
            monitors,
            if selector == "all" {
                "primary"
            } else {
                selector
            },
            active_monitor_id,
        )?;
        let inner = inner_work_area(monitor.work_area, padding_px);
        if slave_indices.is_empty() {
            placements[master_idx] = (monitor.id.clone(), inner);
            return Ok(placements);
        }

        let ratio = req.master_ratio.unwrap_or(0.50).clamp(0.35, 0.75);
        let available_w = (inner.width() - gap_px).max(2);
        let mut master_w = ((available_w as f64) * ratio).round() as i32;
        let min_slave_w = MIN_TILE_WIDTH.min(available_w / 2);
        let min_master_w = MIN_TILE_WIDTH.min(available_w / 2);
        master_w = master_w.clamp(min_master_w, (available_w - min_slave_w).max(min_master_w));

        let master_rect = RectPx::new(inner.left, inner.top, inner.left + master_w, inner.bottom);
        placements[master_idx] = (monitor.id.clone(), master_rect);

        let detail_area = RectPx::new(
            (master_rect.right + gap_px).min(inner.right - 1),
            inner.top,
            inner.right,
            inner.bottom,
        );
        let (cols, rows) = compute_auto_grid_dimensions(
            slave_indices.len(),
            detail_area.width(),
            detail_area.height(),
        );
        let rects = compute_grid_rects(detail_area, slave_indices.len(), cols, rows, gap_px, 0);
        for (slave_idx, rect) in slave_indices.into_iter().zip(rects) {
            placements[slave_idx] = (monitor.id.clone(), rect);
        }
        return Ok(placements);
    }

    if selector == "all" && monitors.len() > 1 {
        let shares = allocate_windows_across_monitors(count, monitors);
        let mut placements = Vec::with_capacity(count);
        for (monitor, share) in monitors.iter().zip(shares) {
            if share == 0 {
                continue;
            }
            let rects = match req.mode {
                ArrangeMode::Grid => {
                    let inner = inner_work_area(monitor.work_area, padding_px);
                    let (cols, rows) =
                        compute_auto_grid_dimensions(share, inner.width(), inner.height());
                    compute_grid_rects(monitor.work_area, share, cols, rows, gap_px, padding_px)
                }
                ArrangeMode::CustomGrid => compute_grid_rects(
                    monitor.work_area,
                    share,
                    req.cols.unwrap_or(1),
                    req.rows.unwrap_or(1),
                    gap_px,
                    padding_px,
                ),
                ArrangeMode::Cascade => {
                    compute_cascade_rects(monitor.work_area, share, cascade_offset, padding_px)
                }
                ArrangeMode::Gather => {
                    compute_stack_center_rects(monitor.work_area, share, padding_px)
                }
                ArrangeMode::MasterDetail => unreachable!(),
            };
            for rect in rects {
                placements.push((monitor.id.clone(), rect));
            }
        }
        return Ok(placements);
    }

    let monitor = select_single_monitor(
        monitors,
        if selector == "all" {
            "primary"
        } else {
            selector
        },
        active_monitor_id,
    )?;
    let rects = match req.mode {
        ArrangeMode::Grid => {
            let inner = inner_work_area(monitor.work_area, padding_px);
            let (cols, rows) = compute_auto_grid_dimensions(count, inner.width(), inner.height());
            compute_grid_rects(monitor.work_area, count, cols, rows, gap_px, padding_px)
        }
        ArrangeMode::CustomGrid => compute_grid_rects(
            monitor.work_area,
            count,
            req.cols.unwrap_or(1),
            req.rows.unwrap_or(1),
            gap_px,
            padding_px,
        ),
        ArrangeMode::Cascade => {
            compute_cascade_rects(monitor.work_area, count, cascade_offset, padding_px)
        }
        ArrangeMode::Gather => compute_stack_center_rects(monitor.work_area, count, padding_px),
        ArrangeMode::MasterDetail => unreachable!(),
    };
    Ok(rects
        .into_iter()
        .map(|rect| (monitor.id.clone(), rect))
        .collect())
}

#[cfg(windows)]
mod win32 {
    use super::{
        compensate_rect_for_shadow, compute_shadow_insets, plan_window_placements, ArrangeMode,
        ArrangeRequest, ArrangeResult, ArrangedWindowEntry, GatherStyle, MonitorInfo, ShadowInsets,
        WindowActionFailure, WindowActionKind, WindowActionRequest, WindowActionResult,
    };
    use crate::win32_window_registry::{verify_live_window, RectPx, VerifiedManagedWindow};
    use std::{
        collections::{HashMap, HashSet},
        ffi::c_void,
        mem::size_of,
    };
    use windows::{
        core::BOOL,
        Win32::{
            Foundation::{HWND, LPARAM, RECT, WPARAM},
            Graphics::{
                Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
                Gdi::{
                    EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR,
                    MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
                },
            },
            UI::{
                HiDpi::GetDpiForSystem,
                WindowsAndMessaging::{
                    BeginDeferWindowPos, BringWindowToTop, DeferWindowPos, EndDeferWindowPos,
                    GetForegroundWindow, GetWindowLongW, GetWindowRect, IsIconic, IsZoomed,
                    PostMessageW, SetForegroundWindow, SetWindowPos, ShowWindow, GWL_EXSTYLE,
                    HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
                    SWP_NOZORDER, SW_MINIMIZE, SW_RESTORE, WM_CLOSE, WS_EX_TOPMOST,
                },
            },
        },
    };

    const MONITORINFOF_PRIMARY: u32 = 1;

    fn query_monitor_dpi() -> u32 {
        let sys_dpi = unsafe { GetDpiForSystem() };
        if sys_dpi > 0 {
            sys_dpi
        } else {
            96
        }
    }

    fn rect_to_px(rect: RECT) -> RectPx {
        RectPx::new(rect.left, rect.top, rect.right, rect.bottom)
    }

    unsafe extern "system" fn enum_monitors_proc(
        hmon: HMONITOR,
        _hdc: HDC,
        _clip: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<MonitorInfo>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(hmon, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
            return BOOL(1);
        }
        let end = info
            .szDevice
            .iter()
            .position(|&ch| ch == 0)
            .unwrap_or(info.szDevice.len());
        let device = String::from_utf16_lossy(&info.szDevice[..end]);
        let id = if device.is_empty() {
            format!("monitor-{}", out.len() + 1)
        } else {
            device
        };
        let is_primary = (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0;
        let short_name = id.strip_prefix(r"\\.\").unwrap_or(&id);
        let name = if is_primary {
            format!("{short_name} (Primary)")
        } else {
            short_name.to_owned()
        };
        let dpi = query_monitor_dpi();
        let scale_percent = ((dpi as f64 / 96.0) * 100.0).round() as u32;
        out.push(MonitorInfo {
            id,
            name,
            is_primary,
            bounds: rect_to_px(info.monitorInfo.rcMonitor),
            work_area: rect_to_px(info.monitorInfo.rcWork),
            dpi,
            scale_percent: scale_percent.max(100),
        });
        BOOL(1)
    }

    pub(crate) fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
        let mut monitors: Vec<MonitorInfo> = Vec::new();
        let ok = unsafe {
            EnumDisplayMonitors(
                None,
                None,
                Some(enum_monitors_proc),
                LPARAM(&mut monitors as *mut Vec<MonitorInfo> as isize),
            )
            .as_bool()
        };
        if !ok && monitors.is_empty() {
            return Err("EnumDisplayMonitors failed".to_owned());
        }
        monitors.sort_by(|a, b| {
            b.is_primary
                .cmp(&a.is_primary)
                .then_with(|| a.bounds.left.cmp(&b.bounds.left))
                .then_with(|| a.bounds.top.cmp(&b.bounds.top))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(monitors)
    }

    fn active_monitor_id(fallback_hwnd: Option<isize>) -> Option<String> {
        let fg = unsafe { GetForegroundWindow() };
        let target = if !fg.0.is_null() {
            fg
        } else if let Some(raw) = fallback_hwnd.filter(|&v| v != 0) {
            HWND(raw as *mut c_void)
        } else {
            return None;
        };
        let hmon = unsafe { MonitorFromWindow(target, MONITOR_DEFAULTTONEAREST) };
        if hmon.is_invalid() {
            return None;
        }
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if !unsafe {
            GetMonitorInfoW(hmon, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool()
        } {
            return None;
        }
        let end = info
            .szDevice
            .iter()
            .position(|&ch| ch == 0)
            .unwrap_or(info.szDevice.len());
        let id = String::from_utf16_lossy(&info.szDevice[..end]);
        (!id.is_empty()).then_some(id)
    }

    fn query_shadow_insets(hwnd: HWND) -> ShadowInsets {
        let mut window_rect = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut window_rect) }.is_err() {
            return ShadowInsets::default();
        }
        let mut ext_rect = RECT::default();
        let ok = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut ext_rect as *mut RECT as *mut c_void,
                size_of::<RECT>() as u32,
            )
            .is_ok()
        };
        if !ok {
            return ShadowInsets::default();
        }
        compute_shadow_insets(rect_to_px(window_rect), rect_to_px(ext_rect))
    }

    fn select_targets(
        managed: &[VerifiedManagedWindow],
        requested_ids: &[String],
    ) -> (Vec<VerifiedManagedWindow>, Vec<String>) {
        if requested_ids.is_empty() {
            return (managed.to_vec(), Vec::new());
        }
        let by_id: HashMap<&str, &VerifiedManagedWindow> = managed
            .iter()
            .map(|window| (window.profile_id.as_str(), window))
            .collect();
        let mut seen = HashSet::new();
        let mut selected = Vec::new();
        let mut skipped = Vec::new();
        for raw_id in requested_ids {
            let id = raw_id.trim();
            if id.is_empty() || !seen.insert(id.to_owned()) {
                continue;
            }
            if let Some(window) = by_id.get(id) {
                selected.push((*window).clone());
            } else {
                skipped.push(id.to_owned());
            }
        }
        (selected, skipped)
    }

    pub(crate) fn arrange_windows(
        req: &ArrangeRequest,
        managed: &[VerifiedManagedWindow],
    ) -> Result<ArrangeResult, String> {
        let (targets, mut skipped) = select_targets(managed, &req.profile_ids);
        if targets.is_empty() {
            return Ok(ArrangeResult {
                ok: true,
                mode: req.mode,
                arranged: Vec::new(),
                skipped,
            });
        }

        if req.mode == ArrangeMode::Gather {
            let style = req.gather_action.unwrap_or(GatherStyle::StackCenter);
            if matches!(style, GatherStyle::Minimize | GatherStyle::Restore) {
                let mut arranged = Vec::new();
                for target in &targets {
                    if !verify_live_window(
                        target.hwnd_raw,
                        &target.allowed_pids,
                        target.expected_class,
                    ) {
                        skipped.push(target.profile_id.clone());
                        continue;
                    }
                    let hwnd = HWND(target.hwnd_raw as *mut c_void);
                    unsafe {
                        let _ = ShowWindow(
                            hwnd,
                            if style == GatherStyle::Minimize {
                                SW_MINIMIZE
                            } else {
                                SW_RESTORE
                            },
                        );
                    }
                    arranged.push(ArrangedWindowEntry {
                        profile_id: target.profile_id.clone(),
                        hwnd_hex: target.info.hwnd_hex.clone(),
                        monitor_id: target.info.monitor_id.clone(),
                        rect: target.info.rect,
                    });
                }
                return Ok(ArrangeResult {
                    ok: true,
                    mode: req.mode,
                    arranged,
                    skipped,
                });
            }
        }

        let monitors = list_monitors()?;
        let ordered_ids: Vec<String> = targets.iter().map(|t| t.profile_id.clone()).collect();
        let active_mon = active_monitor_id(targets.first().map(|t| t.hwnd_raw));
        let placements =
            plan_window_placements(req, &monitors, &ordered_ids, active_mon.as_deref())?;
        let restore_minimized = req.restore_minimized.unwrap_or(true);

        // Prepare live windows: restore minimized/maximized before atomic DeferWindowPos commit.
        let mut commit_items: Vec<(&VerifiedManagedWindow, String, RectPx, RectPx)> = Vec::new();
        for (target, (monitor_id, desired_rect)) in targets.iter().zip(placements) {
            if !verify_live_window(target.hwnd_raw, &target.allowed_pids, target.expected_class) {
                skipped.push(target.profile_id.clone());
                continue;
            }
            let hwnd = HWND(target.hwnd_raw as *mut c_void);
            let is_min = unsafe { IsIconic(hwnd).as_bool() };
            if is_min && !restore_minimized {
                skipped.push(target.profile_id.clone());
                continue;
            }
            if is_min || unsafe { IsZoomed(hwnd).as_bool() } {
                unsafe {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                }
            }
            let insets = query_shadow_insets(hwnd);
            let compensated = compensate_rect_for_shadow(desired_rect, insets);
            commit_items.push((target, monitor_id, desired_rect, compensated));
        }

        if commit_items.is_empty() {
            return Ok(ArrangeResult {
                ok: true,
                mode: req.mode,
                arranged: Vec::new(),
                skipped,
            });
        }

        // Single-frame atomic commit via BeginDeferWindowPos / DeferWindowPos / EndDeferWindowPos.
        let flags = SWP_NOZORDER | SWP_NOACTIVATE;
        let mut fallback_items = Vec::new();
        let mut arranged = Vec::with_capacity(commit_items.len());
        match unsafe { BeginDeferWindowPos(commit_items.len() as i32) } {
            Ok(mut hdwp) => {
                let mut defer_failed = false;
                for &(target, ref monitor_id, desired_rect, comp) in &commit_items {
                    let hwnd = HWND(target.hwnd_raw as *mut c_void);
                    match unsafe {
                        DeferWindowPos(
                            hdwp,
                            hwnd,
                            None,
                            comp.left,
                            comp.top,
                            comp.width().max(1),
                            comp.height().max(1),
                            flags,
                        )
                    } {
                        Ok(next_hdwp) => {
                            hdwp = next_hdwp;
                            arranged.push(ArrangedWindowEntry {
                                profile_id: target.profile_id.clone(),
                                hwnd_hex: target.info.hwnd_hex.clone(),
                                monitor_id: monitor_id.clone(),
                                rect: desired_rect,
                            });
                        }
                        Err(_) => {
                            defer_failed = true;
                            break;
                        }
                    }
                }
                if defer_failed || unsafe { EndDeferWindowPos(hdwp) }.is_err() {
                    arranged.clear();
                    fallback_items = commit_items;
                }
            }
            Err(_) => {
                fallback_items = commit_items;
            }
        }

        for (target, monitor_id, desired_rect, comp) in fallback_items {
            let hwnd = HWND(target.hwnd_raw as *mut c_void);
            let res = unsafe {
                SetWindowPos(
                    hwnd,
                    None,
                    comp.left,
                    comp.top,
                    comp.width().max(1),
                    comp.height().max(1),
                    flags,
                )
            };
            if res.is_ok() {
                arranged.push(ArrangedWindowEntry {
                    profile_id: target.profile_id.clone(),
                    hwnd_hex: target.info.hwnd_hex.clone(),
                    monitor_id,
                    rect: desired_rect,
                });
            } else {
                skipped.push(target.profile_id.clone());
            }
        }

        Ok(ArrangeResult {
            ok: true,
            mode: req.mode,
            arranged,
            skipped,
        })
    }

    fn bring_window_to_front(hwnd: HWND) -> Result<(), String> {
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let _ = BringWindowToTop(hwnd);
            let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            if !SetForegroundWindow(hwnd).as_bool() {
                // Reliable fallback for Firefox/background restrictions without leaving window topmost.
                let was_topmost = (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0) != 0;
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE,
                );
                if !was_topmost {
                    let _ = SetWindowPos(
                        hwnd,
                        Some(HWND_NOTOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE,
                    );
                }
                let _ = SetForegroundWindow(hwnd);
            }
        }
        Ok(())
    }

    pub(crate) fn perform_window_action(
        req: &WindowActionRequest,
        managed: &[VerifiedManagedWindow],
    ) -> Result<WindowActionResult, String> {
        let (targets, missing) = select_targets(managed, &req.profile_ids);
        let mut affected = Vec::new();
        let mut failed = Vec::new();

        for target in &targets {
            if !verify_live_window(target.hwnd_raw, &target.allowed_pids, target.expected_class) {
                failed.push(WindowActionFailure {
                    profile_id: target.profile_id.clone(),
                    reason: "window handle is no longer valid or verified".to_owned(),
                });
                continue;
            }
            let hwnd = HWND(target.hwnd_raw as *mut c_void);
            let outcome: Result<(), String> = match req.action {
                WindowActionKind::Focus => bring_window_to_front(hwnd),
                WindowActionKind::Minimize => {
                    unsafe {
                        let _ = ShowWindow(hwnd, SW_MINIMIZE);
                    }
                    Ok(())
                }
                WindowActionKind::Restore => {
                    unsafe {
                        let _ = ShowWindow(hwnd, SW_RESTORE);
                    }
                    Ok(())
                }
                WindowActionKind::Topmost => unsafe {
                    SetWindowPos(
                        hwnd,
                        Some(HWND_TOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    )
                    .map_err(|error| format!("failed to set topmost: {error}"))
                },
                WindowActionKind::Untopmost => unsafe {
                    SetWindowPos(
                        hwnd,
                        Some(HWND_NOTOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    )
                    .map_err(|error| format!("failed to clear topmost: {error}"))
                },
                WindowActionKind::CloseNotice => unsafe {
                    PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0))
                        .map_err(|error| format!("failed to post graceful WM_CLOSE: {error}"))
                },
            };
            match outcome {
                Ok(()) => affected.push(target.profile_id.clone()),
                Err(reason) => failed.push(WindowActionFailure {
                    profile_id: target.profile_id.clone(),
                    reason,
                }),
            }
        }

        Ok(WindowActionResult {
            ok: failed.is_empty(),
            action: req.action,
            affected,
            missing,
            failed,
        })
    }
}

#[tauri::command]
pub fn window_list_monitors(
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
) -> Result<Vec<MonitorInfo>, String> {
    crate::credentials::authorize(&window, &origin)?;
    #[cfg(windows)]
    {
        win32::list_monitors()
    }
    #[cfg(not(windows))]
    {
        Err(crate::win32_window_registry::UNSUPPORTED_PLATFORM_ERROR.to_owned())
    }
}

#[tauri::command]
pub async fn window_arrange(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    dashboard_session: tauri::State<'_, crate::DesktopDashboardSession>,
    req: ArrangeRequest,
) -> Result<ArrangeResult, String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    validate_arrange_request(&req)?;
    #[cfg(not(windows))]
    {
        let _ = (dashboard_session, req);
        Err(crate::win32_window_registry::UNSUPPORTED_PLATFORM_ERROR.to_owned())
    }
    #[cfg(windows)]
    {
        let origin_url = origin.0.clone();
        let session = dashboard_session.0.as_str().to_owned();
        let managed = resolve_verified_windows(&origin_url, &session).await?;
        tauri::async_runtime::spawn_blocking(move || win32::arrange_windows(&req, &managed))
            .await
            .map_err(|error| format!("window layout worker failed: {error}"))?
    }
}

#[tauri::command]
pub async fn window_action(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    dashboard_session: tauri::State<'_, crate::DesktopDashboardSession>,
    req: WindowActionRequest,
) -> Result<WindowActionResult, String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    #[cfg(not(windows))]
    {
        let _ = (dashboard_session, req);
        Err(crate::win32_window_registry::UNSUPPORTED_PLATFORM_ERROR.to_owned())
    }
    #[cfg(windows)]
    {
        let origin_url = origin.0.clone();
        let session = dashboard_session.0.as_str().to_owned();
        let managed = resolve_verified_windows(&origin_url, &session).await?;
        tauri::async_runtime::spawn_blocking(move || win32::perform_window_action(&req, &managed))
            .await
            .map_err(|error| format!("window action worker failed: {error}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(id: &str, primary: bool, x: i32, y: i32, w: i32, h: i32) -> MonitorInfo {
        MonitorInfo {
            id: id.to_owned(),
            name: id.to_owned(),
            is_primary: primary,
            bounds: RectPx::new(x, y, x + w, y + h + 40),
            work_area: RectPx::new(x, y, x + w, y + h),
            dpi: 96,
            scale_percent: 100,
        }
    }

    #[test]
    fn computes_auto_grid_and_enforces_minimum_tile_size() {
        let (cols, rows) = compute_auto_grid_dimensions(6, 1920, 1040);
        assert_eq!((cols, rows), (3, 2));

        let work = RectPx::new(0, 0, 1920, 1040);
        let rects = compute_grid_rects(work, 6, cols, rows, 8, 10);
        assert_eq!(rects.len(), 6);
        for rect in &rects {
            assert!(rect.width() >= MIN_TILE_WIDTH);
            assert!(rect.height() >= MIN_TILE_HEIGHT);
            assert!(rect.left >= work.left && rect.right <= work.right);
            assert!(rect.top >= work.top && rect.bottom <= work.bottom);
        }

        // Crowded 20-window grid still protects >= 360x280 without leaving work area
        let (dense_c, dense_r) = compute_auto_grid_dimensions(20, 1280, 720);
        let dense = compute_grid_rects(RectPx::new(0, 0, 1280, 720), 20, dense_c, dense_r, 6, 8);
        assert_eq!(dense.len(), 20);
        for rect in &dense {
            assert!(rect.width() >= MIN_TILE_WIDTH);
            assert!(rect.height() >= MIN_TILE_HEIGHT);
            assert!(rect.left >= 0 && rect.right <= 1280);
            assert!(rect.top >= 0 && rect.bottom <= 720);
        }
    }

    #[test]
    fn validates_and_lays_out_custom_grid_with_overflow_wrapping() {
        let bad = ArrangeRequest {
            mode: ArrangeMode::CustomGrid,
            profile_ids: vec![],
            monitor: None,
            cols: Some(13),
            rows: Some(2),
            gap_px: None,
            padding_px: None,
            cascade_offset_px: None,
            master_profile_id: None,
            master_ratio: None,
            gather_action: None,
            restore_minimized: None,
        };
        assert!(validate_arrange_request(&bad).is_err());

        let work = RectPx::new(0, 0, 1920, 1040);
        let rects = compute_grid_rects(work, 6, 2, 2, 8, 8);
        assert_eq!(rects.len(), 6);
        // 5th window wraps to page 2 shifted by +24px inside bounds
        assert_eq!(rects[4].left, rects[0].left + 24);
        assert_eq!(rects[4].top, rects[0].top + 24);
    }

    #[test]
    fn computes_cascade_with_boundary_wraparound() {
        let work = RectPx::new(0, 0, 1600, 900);
        let rects = compute_cascade_rects(work, 12, 32, 8);
        assert_eq!(rects.len(), 12);
        assert_eq!(rects[1].left - rects[0].left, 32);
        assert_eq!(rects[1].top - rects[0].top, 32);
        for rect in &rects {
            assert!(rect.left >= 8 && rect.right <= 1592);
            assert!(rect.top >= 8 && rect.bottom <= 892);
        }
    }

    #[test]
    fn allocates_windows_proportionally_across_multiple_monitors() {
        let monitors = vec![
            monitor("M1", true, 0, 0, 2560, 1400),     // ~3.58M px
            monitor("M2", false, 2560, 0, 1920, 1040), // ~2.00M px
        ];
        let shares = allocate_windows_across_monitors(8, &monitors);
        assert_eq!(shares.iter().sum::<usize>(), 8);
        assert!(shares[0] > shares[1]);
        assert_eq!(shares, vec![5, 3]);
    }

    #[test]
    fn plans_master_detail_for_single_and_multi_monitor() {
        let single = vec![monitor("M1", true, 0, 0, 1920, 1040)];
        let ids = vec!["p1".into(), "p2".into(), "p3".into(), "p4".into()];
        let req = ArrangeRequest {
            mode: ArrangeMode::MasterDetail,
            profile_ids: ids.clone(),
            monitor: Some("primary".into()),
            cols: None,
            rows: None,
            gap_px: Some(8),
            padding_px: Some(8),
            cascade_offset_px: None,
            master_profile_id: Some("p2".into()),
            master_ratio: Some(0.5),
            gather_action: None,
            restore_minimized: None,
        };
        let placements = plan_window_placements(&req, &single, &ids, None).unwrap();
        assert_eq!(placements.len(), 4);
        // p2 is master on the left half; slaves on the right half
        let master_rect = placements[1].1;
        assert_eq!(master_rect.left, 8);
        for idx in [0usize, 2, 3] {
            assert!(placements[idx].1.left >= master_rect.right + 8);
        }

        // Dual-monitor "all": master fills M1, slaves tile on M2
        let dual = vec![
            monitor("M1", true, 0, 0, 1920, 1040),
            monitor("M2", false, 1920, 0, 1920, 1040),
        ];
        let mut dual_req = req;
        dual_req.monitor = Some("all".into());
        let dual_plan = plan_window_placements(&dual_req, &dual, &ids, None).unwrap();
        assert_eq!(dual_plan[1].0, "M1");
        for idx in [0usize, 2, 3] {
            assert_eq!(dual_plan[idx].0, "M2");
            assert!(dual_plan[idx].1.left >= 1920);
        }
    }

    #[test]
    fn compensates_invisible_dwm_shadow_frame_cleanly() {
        let win_rect = RectPx::new(93, 100, 907, 707);
        let ext_rect = RectPx::new(100, 100, 900, 700);
        let insets = compute_shadow_insets(win_rect, ext_rect);
        assert_eq!(
            insets,
            ShadowInsets {
                left: 7,
                top: 0,
                right: 7,
                bottom: 7
            }
        );
        let desired = RectPx::new(0, 0, 960, 520);
        let compensated = compensate_rect_for_shadow(desired, insets);
        assert_eq!(compensated, RectPx::new(-7, 0, 967, 527));

        // Abnormal huge delta is safely clamped to MAX_SHADOW_INSET_PX
        let clamped = compute_shadow_insets(
            RectPx::new(-500, -500, 2000, 2000),
            RectPx::new(0, 0, 1000, 1000),
        );
        assert_eq!(clamped.left, MAX_SHADOW_INSET_PX);
        assert_eq!(clamped.right, MAX_SHADOW_INSET_PX);
    }

    #[test]
    fn selects_monitors_stacks_center_and_deserializes_ipc_requests() {
        let monitors = vec![
            monitor("M1", true, 0, 0, 1920, 1040),
            monitor("M2", false, 1920, 0, 2560, 1400),
        ];
        assert_eq!(
            select_single_monitor(&monitors, "primary", None)
                .unwrap()
                .id,
            "M1"
        );
        assert_eq!(
            select_single_monitor(&monitors, "active", Some("M2"))
                .unwrap()
                .id,
            "M2"
        );
        assert_eq!(
            select_single_monitor(&monitors, "M2", None).unwrap().id,
            "M2"
        );
        assert!(select_single_monitor(&monitors, "M99", None).is_err());

        let stacked = compute_stack_center_rects(RectPx::new(0, 0, 1920, 1040), 3, 10);
        assert_eq!(stacked.len(), 3);
        assert_eq!(stacked[0], stacked[1]);
        assert!(stacked[0].left > 10 && stacked[0].right < 1910);

        let parsed_arrange: ArrangeRequest = serde_json::from_value(serde_json::json!({
            "mode": "gather",
            "profileIds": ["p1", "p2"],
            "monitorTarget": "primary",
            "gatherMode": "stack_center",
            "gapPx": 8,
            "paddingPx": 12
        }))
        .unwrap();
        assert_eq!(parsed_arrange.mode, ArrangeMode::Gather);
        assert_eq!(parsed_arrange.gather_action, Some(GatherStyle::StackCenter));
        assert_eq!(parsed_arrange.monitor.as_deref(), Some("primary"));

        let parsed_action: WindowActionRequest = serde_json::from_value(serde_json::json!({
            "action": "topmost",
            "profileIds": ["p1"]
        }))
        .unwrap();
        assert_eq!(parsed_action.action, WindowActionKind::Topmost);
        assert_eq!(parsed_action.profile_ids, vec!["p1"]);
    }

    #[cfg(windows)]
    #[test]
    fn enumerates_at_least_one_live_windows_monitor() {
        let monitors = win32::list_monitors().unwrap();
        assert!(!monitors.is_empty());
        assert!(monitors.iter().any(|m| m.is_primary));
        for mon in monitors {
            assert!(!mon.id.is_empty());
            assert!(mon.work_area.is_non_empty());
            assert!(mon.dpi >= 96);
        }
    }
}
