use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackdropKind {
    MicaAlt,
    Mica,
    None,
}

impl BackdropKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MicaAlt => "mica-alt",
            Self::Mica => "mica",
            Self::None => "none",
        }
    }

    pub fn init_script(self) -> String {
        format!("window.__MAOBU_BACKDROP__ = \"{}\";", self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WindowThemeChoice {
    Light,
    Dark,
    System,
}

pub(crate) fn env_disables_mica(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1"))
}

pub(crate) fn parse_build_number(raw: &str) -> Option<u32> {
    raw.trim().parse::<u32>().ok()
}

pub(crate) fn select_backdrop_kind(
    isolated_acceptance: bool,
    disabled_by_env: bool,
    dwm_enabled: bool,
    windows_build: Option<u32>,
) -> BackdropKind {
    if isolated_acceptance || disabled_by_env || !dwm_enabled {
        return BackdropKind::None;
    }
    match windows_build {
        Some(build) if build >= 22621 => BackdropKind::MicaAlt,
        Some(build) if build >= 22000 => BackdropKind::Mica,
        _ => BackdropKind::None,
    }
}

pub(crate) fn parse_window_theme(raw: &str) -> Result<WindowThemeChoice, String> {
    match raw {
        "light" => Ok(WindowThemeChoice::Light),
        "dark" => Ok(WindowThemeChoice::Dark),
        "system" => Ok(WindowThemeChoice::System),
        _ => Err("window theme must be one of light, dark, or system".to_owned()),
    }
}

#[cfg(windows)]
mod win32 {
    use super::{parse_build_number, BackdropKind};
    use std::ffi::c_void;
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::{ERROR_SUCCESS, HWND},
            Graphics::Dwm::{
                DwmExtendFrameIntoClientArea, DwmIsCompositionEnabled, DwmSetWindowAttribute,
                DWMSBT_MAINWINDOW, DWMSBT_TABBEDWINDOW, DWMWA_SYSTEMBACKDROP_TYPE,
                DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
                DWMWINDOWATTRIBUTE,
            },
            System::Registry::{
                RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
                HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, REG_DWORD, REG_SZ, REG_VALUE_TYPE,
            },
            UI::Controls::MARGINS,
        },
    };

    /// Undocumented Win11 21H2 (22000..22523) Mica attribute.
    const DWMWA_MICA_EFFECT: DWMWINDOWATTRIBUTE = DWMWINDOWATTRIBUTE(1029);

    pub(crate) fn read_windows_build_number() -> Option<u32> {
        let mut key = HKEY::default();
        let opened = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"),
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
            RegQueryValueExW(
                key,
                w!("CurrentBuildNumber"),
                None,
                Some(&mut kind),
                None,
                Some(&mut size),
            )
        };
        if query_len != ERROR_SUCCESS || kind != REG_SZ || size == 0 || size > 256 {
            unsafe {
                let _ = RegCloseKey(key);
            }
            return None;
        }
        let mut bytes = vec![0u8; size as usize];
        let query = unsafe {
            RegQueryValueExW(
                key,
                w!("CurrentBuildNumber"),
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
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .take_while(|&unit| unit != 0)
            .collect();
        let text = String::from_utf16(&units).ok()?;
        parse_build_number(&text)
    }

    pub(crate) fn is_dwm_composition_enabled() -> bool {
        unsafe { DwmIsCompositionEnabled() }
            .map(|enabled| enabled.as_bool())
            .unwrap_or(false)
    }

    pub(crate) fn read_system_dark_mode() -> bool {
        let mut key = HKEY::default();
        let opened = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
                None,
                KEY_QUERY_VALUE,
                &mut key,
            )
        };
        if opened != ERROR_SUCCESS {
            return false;
        }
        let mut kind = REG_VALUE_TYPE(0);
        let mut data = 1u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let query = unsafe {
            RegQueryValueExW(
                key,
                PCWSTR(w!("AppsUseLightTheme").as_ptr()),
                None,
                Some(&mut kind),
                Some(&mut data as *mut u32 as *mut u8),
                Some(&mut size),
            )
        };
        unsafe {
            let _ = RegCloseKey(key);
        }
        query == ERROR_SUCCESS && kind == REG_DWORD && data == 0
    }

    fn window_hwnd(window: &tauri::WebviewWindow) -> Result<HWND, String> {
        window
            .hwnd()
            .map(|raw| HWND(raw.0))
            .map_err(|error| format!("could not obtain HWND: {error}"))
    }

    pub(crate) fn apply_immersive_dark_mode(
        window: &tauri::WebviewWindow,
        dark: bool,
    ) -> Result<(), String> {
        let hwnd = window_hwnd(window)?;
        let value: u32 = u32::from(dark);
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                &value as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            )
        }
        .map_err(|error| format!("DWMWA_USE_IMMERSIVE_DARK_MODE failed: {error}"))
    }

    pub(crate) fn apply_backdrop_inner(
        window: &tauri::WebviewWindow,
        kind: BackdropKind,
        dark: bool,
    ) -> Result<(), String> {
        let hwnd = window_hwnd(window)?;
        let margins = MARGINS {
            cxLeftWidth: -1,
            cxRightWidth: -1,
            cyTopHeight: -1,
            cyBottomHeight: -1,
        };
        unsafe { DwmExtendFrameIntoClientArea(hwnd, &margins) }
            .map_err(|error| format!("DwmExtendFrameIntoClientArea failed: {error}"))?;

        let corner = DWMWCP_ROUND;
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &corner as *const _ as *const c_void,
                std::mem::size_of_val(&corner) as u32,
            )
        }
        .map_err(|error| format!("DWMWA_WINDOW_CORNER_PREFERENCE failed: {error}"))?;

        let dark_flag: u32 = u32::from(dark);
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                &dark_flag as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            )
        }
        .map_err(|error| format!("DWMWA_USE_IMMERSIVE_DARK_MODE failed: {error}"))?;

        let build = read_windows_build_number().unwrap_or(0);
        match kind {
            BackdropKind::MicaAlt => {
                let backdrop = DWMSBT_TABBEDWINDOW;
                unsafe {
                    DwmSetWindowAttribute(
                        hwnd,
                        DWMWA_SYSTEMBACKDROP_TYPE,
                        &backdrop as *const _ as *const c_void,
                        std::mem::size_of_val(&backdrop) as u32,
                    )
                }
                .map_err(|error| format!("DWMWA_SYSTEMBACKDROP_TYPE (MicaAlt) failed: {error}"))?;
            }
            BackdropKind::Mica if build >= 22523 => {
                let backdrop = DWMSBT_MAINWINDOW;
                unsafe {
                    DwmSetWindowAttribute(
                        hwnd,
                        DWMWA_SYSTEMBACKDROP_TYPE,
                        &backdrop as *const _ as *const c_void,
                        std::mem::size_of_val(&backdrop) as u32,
                    )
                }
                .map_err(|error| format!("DWMWA_SYSTEMBACKDROP_TYPE (Mica) failed: {error}"))?;
            }
            BackdropKind::Mica => {
                let enable: u32 = 1;
                unsafe {
                    DwmSetWindowAttribute(
                        hwnd,
                        DWMWA_MICA_EFFECT,
                        &enable as *const u32 as *const c_void,
                        std::mem::size_of::<u32>() as u32,
                    )
                }
                .map_err(|error| format!("DWMWA_MICA_EFFECT failed: {error}"))?;
            }
            BackdropKind::None => {}
        }
        Ok(())
    }
}

pub fn probe_windows_backdrop(isolated_acceptance: bool) -> BackdropKind {
    #[cfg(windows)]
    {
        let disabled = env_disables_mica(std::env::var("MAOBU_DISABLE_MICA").ok().as_deref());
        if isolated_acceptance || disabled {
            return BackdropKind::None;
        }
        let dwm_enabled = win32::is_dwm_composition_enabled();
        let build = win32::read_windows_build_number();
        select_backdrop_kind(isolated_acceptance, disabled, dwm_enabled, build)
    }
    #[cfg(not(windows))]
    {
        let _ = isolated_acceptance;
        BackdropKind::None
    }
}

pub fn initial_dark_mode() -> bool {
    #[cfg(windows)]
    {
        win32::read_system_dark_mode()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn apply_backdrop(window: &tauri::WebviewWindow, kind: BackdropKind, dark: bool) -> bool {
    if kind == BackdropKind::None {
        return false;
    }
    #[cfg(windows)]
    {
        match win32::apply_backdrop_inner(window, kind, dark) {
            Ok(()) => true,
            Err(error) => {
                eprintln!(
                    "window_backdrop: falling back to solid background after {} setup failed: {error}",
                    kind.as_str()
                );
                let fallback = if dark {
                    tauri::window::Color(15, 16, 20, 255)
                } else {
                    tauri::window::Color(248, 249, 251, 255)
                };
                let _ = window.set_background_color(Some(fallback));
                let _ = window.eval("window.__MAOBU_BACKDROP__ = \"none\";");
                false
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, dark);
        false
    }
}

#[tauri::command]
pub fn set_window_theme(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    let choice = parse_window_theme(&theme)?;
    let tauri_theme = match choice {
        WindowThemeChoice::Light => Some(tauri::Theme::Light),
        WindowThemeChoice::Dark => Some(tauri::Theme::Dark),
        WindowThemeChoice::System => None,
    };
    window
        .set_theme(tauri_theme)
        .map_err(|error| format!("failed to update window theme: {error}"))?;
    #[cfg(windows)]
    {
        let dark = match choice {
            WindowThemeChoice::Light => false,
            WindowThemeChoice::Dark => true,
            WindowThemeChoice::System => initial_dark_mode(),
        };
        if let Err(error) = win32::apply_immersive_dark_mode(&window, dark) {
            eprintln!("window_backdrop: could not sync DWM dark mode: {error}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        env_disables_mica, parse_build_number, parse_window_theme, select_backdrop_kind,
        BackdropKind, WindowThemeChoice,
    };

    #[test]
    fn selects_backdrop_by_os_build_dwm_and_flags() {
        assert_eq!(
            select_backdrop_kind(true, false, true, Some(22631)),
            BackdropKind::None
        );
        assert_eq!(
            select_backdrop_kind(false, true, true, Some(22631)),
            BackdropKind::None
        );
        assert_eq!(
            select_backdrop_kind(false, false, false, Some(22631)),
            BackdropKind::None
        );
        assert_eq!(
            select_backdrop_kind(false, false, true, None),
            BackdropKind::None
        );
        assert_eq!(
            select_backdrop_kind(false, false, true, Some(19045)),
            BackdropKind::None
        );
        assert_eq!(
            select_backdrop_kind(false, false, true, Some(21999)),
            BackdropKind::None
        );
        assert_eq!(
            select_backdrop_kind(false, false, true, Some(22000)),
            BackdropKind::Mica
        );
        assert_eq!(
            select_backdrop_kind(false, false, true, Some(22523)),
            BackdropKind::Mica
        );
        assert_eq!(
            select_backdrop_kind(false, false, true, Some(22620)),
            BackdropKind::Mica
        );
        assert_eq!(
            select_backdrop_kind(false, false, true, Some(22621)),
            BackdropKind::MicaAlt
        );
        assert_eq!(
            select_backdrop_kind(false, false, true, Some(26100)),
            BackdropKind::MicaAlt
        );
    }

    #[test]
    fn recognizes_only_explicit_disable_env_flag() {
        assert!(env_disables_mica(Some("1")));
        assert!(env_disables_mica(Some(" 1 ")));
        assert!(!env_disables_mica(Some("0")));
        assert!(!env_disables_mica(Some("")));
        assert!(!env_disables_mica(Some("false")));
        assert!(!env_disables_mica(None));
    }

    #[test]
    fn parses_windows_build_number_safely() {
        assert_eq!(parse_build_number("22631"), Some(22631));
        assert_eq!(parse_build_number(" 26100 \r\n"), Some(26100));
        assert_eq!(parse_build_number(""), None);
        assert_eq!(parse_build_number("abc"), None);
    }

    #[test]
    fn formats_backdrop_name_and_init_script() {
        assert_eq!(BackdropKind::MicaAlt.as_str(), "mica-alt");
        assert_eq!(BackdropKind::Mica.as_str(), "mica");
        assert_eq!(BackdropKind::None.as_str(), "none");
        assert_eq!(
            serde_json::to_string(&BackdropKind::MicaAlt).unwrap(),
            "\"mica-alt\""
        );
        assert_eq!(
            BackdropKind::MicaAlt.init_script(),
            "window.__MAOBU_BACKDROP__ = \"mica-alt\";"
        );
        assert_eq!(
            BackdropKind::None.init_script(),
            "window.__MAOBU_BACKDROP__ = \"none\";"
        );
    }

    #[test]
    fn validates_window_theme_whitelist() {
        assert_eq!(parse_window_theme("light"), Ok(WindowThemeChoice::Light));
        assert_eq!(parse_window_theme("dark"), Ok(WindowThemeChoice::Dark));
        assert_eq!(parse_window_theme("system"), Ok(WindowThemeChoice::System));
        for rejected in ["", "auto", "DARK", "Light", "custom", "dark\n"] {
            assert!(parse_window_theme(rejected).is_err());
        }
    }
}
