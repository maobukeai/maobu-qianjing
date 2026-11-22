use crate::credentials::{self, CredentialOrigin};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDiagnosticProbe {
    pub platform: String,
    pub arch: String,
    pub os_name: String,
    pub os_version: Option<String>,
    pub os_build: Option<u32>,
    pub webview2_version: Option<String>,
    pub webview2_channel: Option<String>,
    pub webview2_available: bool,
}

pub(crate) fn is_valid_webview2_version(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "0.0.0.0" || trimmed.len() > 64 {
        return false;
    }
    trimmed
        .bytes()
        .all(|b| b.is_ascii_digit() || b == b'.')
        && trimmed.split('.').all(|segment| !segment.is_empty())
}

pub(crate) fn format_windows_os_name(product_name: Option<&str>, build: Option<u32>) -> String {
    match build {
        Some(b) if b >= 22000 => "Windows 11".to_owned(),
        Some(b) if b >= 10240 => "Windows 10".to_owned(),
        _ => product_name
            .map(str::trim)
            .filter(|name| !name.is_empty() && name.len() <= 96)
            .map(str::to_owned)
            .unwrap_or_else(|| "Windows".to_owned()),
    }
}

pub(crate) fn format_windows_os_version(
    display_version: Option<&str>,
    build: Option<u32>,
    ubr: Option<u32>,
) -> Option<String> {
    let release = display_version
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 32);
    let build_label = match (build, ubr) {
        (Some(b), Some(u)) => Some(format!("Build {b}.{u}")),
        (Some(b), None) => Some(format!("Build {b}")),
        (None, _) => None,
    };
    match (release, build_label) {
        (Some(rel), Some(bld)) => Some(format!("{rel} ({bld})")),
        (Some(rel), None) => Some(rel.to_owned()),
        (None, Some(bld)) => Some(bld),
        (None, None) => None,
    }
}

#[cfg(windows)]
mod win32 {
    use super::{
        format_windows_os_name, format_windows_os_version, is_valid_webview2_version,
        SystemDiagnosticProbe,
    };
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::ERROR_SUCCESS,
            System::Registry::{
                RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
                HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, REG_DWORD, REG_SZ, REG_VALUE_TYPE,
            },
        },
    };

    const MAX_REG_SZ_BYTES: u32 = 512;

    fn read_reg_sz(root: HKEY, subkey: PCWSTR, value_name: PCWSTR) -> Option<String> {
        let mut key = HKEY::default();
        let opened = unsafe { RegOpenKeyExW(root, subkey, None, KEY_QUERY_VALUE, &mut key) };
        if opened != ERROR_SUCCESS {
            return None;
        }
        let mut kind = REG_VALUE_TYPE(0);
        let mut size = 0u32;
        let query_len = unsafe {
            RegQueryValueExW(key, value_name, None, Some(&mut kind), None, Some(&mut size))
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
                value_name,
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
        String::from_utf16(&units)
            .ok()
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
    }

    fn read_reg_dword(root: HKEY, subkey: PCWSTR, value_name: PCWSTR) -> Option<u32> {
        let mut key = HKEY::default();
        let opened = unsafe { RegOpenKeyExW(root, subkey, None, KEY_QUERY_VALUE, &mut key) };
        if opened != ERROR_SUCCESS {
            return None;
        }
        let mut kind = REG_VALUE_TYPE(0);
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let query = unsafe {
            RegQueryValueExW(
                key,
                value_name,
                None,
                Some(&mut kind),
                Some(&mut data as *mut u32 as *mut u8),
                Some(&mut size),
            )
        };
        unsafe {
            let _ = RegCloseKey(key);
        }
        if query == ERROR_SUCCESS && kind == REG_DWORD {
            Some(data)
        } else {
            None
        }
    }

    fn read_webview2_version() -> Option<(String, &'static str)> {
        let candidates: [(HKEY, PCWSTR, &'static str); 3] = [
            (
                HKEY_LOCAL_MACHINE,
                w!(r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
                "machine-wow64",
            ),
            (
                HKEY_LOCAL_MACHINE,
                w!(r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
                "machine",
            ),
            (
                HKEY_CURRENT_USER,
                w!(r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
                "user",
            ),
        ];
        for (root, subkey, channel) in candidates {
            if let Some(version) = read_reg_sz(root, subkey, w!("pv")) {
                if is_valid_webview2_version(&version) {
                    return Some((version, channel));
                }
            }
        }
        None
    }

    pub(crate) fn collect() -> SystemDiagnosticProbe {
        let nt_key = w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        let product_name = read_reg_sz(HKEY_LOCAL_MACHINE, nt_key, w!("ProductName"));
        let display_version = read_reg_sz(HKEY_LOCAL_MACHINE, nt_key, w!("DisplayVersion"))
            .or_else(|| read_reg_sz(HKEY_LOCAL_MACHINE, nt_key, w!("ReleaseId")));
        let os_build = read_reg_sz(HKEY_LOCAL_MACHINE, nt_key, w!("CurrentBuildNumber"))
            .and_then(|raw| raw.parse::<u32>().ok());
        let ubr = read_reg_dword(HKEY_LOCAL_MACHINE, nt_key, w!("UBR"));

        let os_name = format_windows_os_name(product_name.as_deref(), os_build);
        let os_version = format_windows_os_version(display_version.as_deref(), os_build, ubr);
        let webview2 = read_webview2_version();

        SystemDiagnosticProbe {
            platform: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            os_name,
            os_version,
            os_build,
            webview2_available: webview2.is_some(),
            webview2_version: webview2.as_ref().map(|(v, _)| v.clone()),
            webview2_channel: webview2.map(|(_, ch)| ch.to_owned()),
        }
    }
}

pub(crate) fn collect_system_diagnostic_probe() -> SystemDiagnosticProbe {
    #[cfg(windows)]
    {
        win32::collect()
    }
    #[cfg(not(windows))]
    {
        let os_name = match std::env::consts::OS {
            "macos" => "macOS",
            "linux" => "Linux",
            other => other,
        };
        SystemDiagnosticProbe {
            platform: std::env::consts::OS.to_owned(),
            arch: std::env::consts::ARCH.to_owned(),
            os_name: os_name.to_owned(),
            os_version: None,
            os_build: None,
            webview2_version: None,
            webview2_channel: None,
            webview2_available: false,
        }
    }
}

#[tauri::command]
pub fn system_diagnostic_probe(
    window: tauri::WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
) -> Result<SystemDiagnosticProbe, String> {
    credentials::authorize(&window, &origin)?;
    Ok(collect_system_diagnostic_probe())
}

#[cfg(test)]
mod tests {
    use super::{
        collect_system_diagnostic_probe, format_windows_os_name, format_windows_os_version,
        is_valid_webview2_version,
    };

    #[test]
    fn validates_webview2_pv_versions() {
        assert!(is_valid_webview2_version("130.0.2849.68"));
        assert!(is_valid_webview2_version("128.0.2739.79"));
        assert!(!is_valid_webview2_version(""));
        assert!(!is_valid_webview2_version("0.0.0.0"));
        assert!(!is_valid_webview2_version("130.0..1"));
        assert!(!is_valid_webview2_version("130.0.0.1-evil"));
    }

    #[test]
    fn formats_windows_os_name_and_version_cleanly() {
        assert_eq!(
            format_windows_os_name(Some("Windows 10 Pro"), Some(22631)),
            "Windows 11"
        );
        assert_eq!(
            format_windows_os_name(Some("Windows 10 Pro"), Some(19045)),
            "Windows 10"
        );
        assert_eq!(
            format_windows_os_name(Some("Windows Server"), Some(9600)),
            "Windows Server"
        );
        assert_eq!(
            format_windows_os_version(Some("23H2"), Some(22631), Some(4317)),
            Some("23H2 (Build 22631.4317)".to_owned())
        );
        assert_eq!(
            format_windows_os_version(None, Some(19045), None),
            Some("Build 19045".to_owned())
        );
    }

    #[test]
    fn probe_collects_host_metadata() {
        let probe = collect_system_diagnostic_probe();
        assert_eq!(probe.platform, std::env::consts::OS);
        assert_eq!(probe.arch, std::env::consts::ARCH);
        assert!(!probe.os_name.is_empty());
    }
}
