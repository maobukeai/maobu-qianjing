use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

pub const RUNTIME_PROTOCOL: &str = "aliasmode-runtime-v1";
const RUNTIME_FILE: &str = "agent-runtime.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub protocol: String,
    pub app_version: String,
    pub generation: String,
    pub nonce: String,
    pub port: u16,
    pub desktop_pid: u32,
    pub desktop_started_at: String,
    pub sidecar_pid: u32,
    pub readiness: String,
    pub created_at: u64,
}

pub struct RuntimeDescriptorState {
    path: PathBuf,
    base: RuntimeDescriptor,
    active: AtomicBool,
    write_lock: Mutex<()>,
}

impl RuntimeDescriptorState {
    pub fn new(
        data_dir: &Path,
        generation: String,
        nonce: String,
        port: u16,
        sidecar_pid: u32,
    ) -> Result<Self, String> {
        if !valid_nonce(&generation) || !valid_nonce(&nonce) {
            return Err("runtime descriptor nonce is invalid".to_owned());
        }
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "system clock is before the Unix epoch".to_owned())?
            .as_secs();
        Ok(Self {
            path: data_dir.join(RUNTIME_FILE),
            base: RuntimeDescriptor {
                protocol: RUNTIME_PROTOCOL.to_owned(),
                app_version: env!("CARGO_PKG_VERSION").to_owned(),
                generation,
                nonce,
                port,
                desktop_pid: std::process::id(),
                desktop_started_at: current_process_start_identity()?,
                sidecar_pid,
                readiness: String::new(),
                created_at,
            },
            active: AtomicBool::new(false),
            write_lock: Mutex::new(()),
        })
    }

    pub fn activate(&self) {
        self.active.store(true, Ordering::Release);
    }

    pub fn publish(&self, readiness: &str) -> Result<(), String> {
        if !self.active.load(Ordering::Acquire) {
            return Err("runtime descriptor is not active".to_owned());
        }
        if readiness != "local" {
            return Err("runtime readiness state is invalid".to_owned());
        }
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "runtime descriptor lock failed".to_owned())?;
        let mut descriptor = self.base.clone();
        descriptor.readiness = readiness.to_owned();
        write_atomic(
            &self.path,
            &serde_json::to_vec(&descriptor).map_err(|error| error.to_string())?,
        )
    }

    pub fn remove_owned(&self) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "runtime descriptor lock failed".to_owned())?;
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        let descriptor: RuntimeDescriptor = serde_json::from_slice(&bytes)
            .map_err(|_| "runtime descriptor is malformed".to_owned())?;
        if descriptor.generation == self.base.generation {
            fs::remove_file(&self.path).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

fn valid_nonce(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[tauri::command]
pub fn script_capability(
    window: tauri::WebviewWindow,
    origin: tauri::State<'_, crate::credentials::CredentialOrigin>,
    state: tauri::State<'_, RuntimeDescriptorState>,
) -> Result<String, String> {
    crate::credentials::authorize(&window, &origin)?;
    Ok(state.base.nonce.clone())
}

#[tauri::command]
pub fn agent_runtime_ready(
    window: tauri::WebviewWindow,
    origin: tauri::State<'_, crate::credentials::CredentialOrigin>,
    state: tauri::State<'_, RuntimeDescriptorState>,
    readiness: String,
) -> Result<(), String> {
    crate::credentials::authorize(&window, &origin)?;
    state.publish(&readiness)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        hex::encode(rand::random::<[u8; 4]>())
    ));
    let mut file = create_owner_only_file(&temporary)?;
    let write_result = (|| -> Result<(), String> {
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = write_result {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    drop(file);
    replace_file(&temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

#[cfg(unix)]
fn create_owner_only_file(path: &Path) -> Result<fs::File, String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    let file = options.open(path).map_err(|error| error.to_string())?;
    if let Err(error) = file.set_permissions(fs::Permissions::from_mode(0o600)) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(file)
}

#[cfg(windows)]
fn current_user_sid_bytes() -> Result<Vec<u8>, String> {
    use windows::Win32::{
        Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, HANDLE},
        Security::{
            GetLengthSid, GetTokenInformation, IsValidSid, TokenUser, TOKEN_QUERY, TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    struct HandleGuard(HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    let mut raw_token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) }
        .map_err(|error| error.to_string())?;
    let token = HandleGuard(raw_token);

    let mut needed = 0_u32;
    if let Err(error) = unsafe { GetTokenInformation(token.0, TokenUser, None, 0, &mut needed) } {
        if error.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult() || needed == 0 {
            return Err(error.to_string());
        }
    }
    let mut buffer = vec![0_u64; (needed as usize).div_ceil(size_of::<u64>())];
    unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )
    }
    .map_err(|error| error.to_string())?;

    let token_user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    let sid = token_user.User.Sid;
    if !unsafe { IsValidSid(sid) }.as_bool() {
        return Err("current process user SID is invalid".to_owned());
    }
    let sid_len = unsafe { GetLengthSid(sid) } as usize;
    if sid_len == 0 {
        return Err("current process user SID has zero length".to_owned());
    }
    let mut bytes = vec![0_u8; sid_len];
    unsafe {
        std::ptr::copy_nonoverlapping(sid.0.cast::<u8>(), bytes.as_mut_ptr(), sid_len);
    }
    Ok(bytes)
}

#[cfg(windows)]
fn create_owner_only_file(path: &Path) -> Result<fs::File, String> {
    use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
    use windows::{
        core::PCWSTR,
        Win32::{
            Security::{
                AddAccessAllowedAce, InitializeAcl, InitializeSecurityDescriptor,
                SetSecurityDescriptorControl, SetSecurityDescriptorDacl, ACCESS_ALLOWED_ACE, ACL,
                ACL_REVISION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
                SE_DACL_PROTECTED,
            },
            Storage::FileSystem::{
                CreateFileW, CREATE_NEW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL,
                FILE_GENERIC_WRITE, FILE_SHARE_NONE,
            },
        },
    };

    let mut sid_bytes = current_user_sid_bytes()?;
    let sid = PSID(sid_bytes.as_mut_ptr().cast());
    let acl_bytes =
        size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + sid_bytes.len();
    let acl_words = acl_bytes.div_ceil(size_of::<u32>());
    let mut acl_buffer = vec![0_u32; acl_words];
    let acl_ptr = acl_buffer.as_mut_ptr() as *mut ACL;
    unsafe { InitializeAcl(acl_ptr, (acl_words * size_of::<u32>()) as u32, ACL_REVISION) }
        .map_err(|error| error.to_string())?;
    unsafe { AddAccessAllowedAce(acl_ptr, ACL_REVISION, FILE_ALL_ACCESS.0, sid) }
        .map_err(|error| error.to_string())?;

    let mut sd = SECURITY_DESCRIPTOR::default();
    let psd = PSECURITY_DESCRIPTOR((&mut sd as *mut SECURITY_DESCRIPTOR).cast());
    unsafe { InitializeSecurityDescriptor(psd, 1) }.map_err(|error| error.to_string())?;
    unsafe { SetSecurityDescriptorDacl(psd, true, Some(acl_ptr), false) }
        .map_err(|error| error.to_string())?;
    unsafe { SetSecurityDescriptorControl(psd, SE_DACL_PROTECTED, SE_DACL_PROTECTED) }
        .map_err(|error| error.to_string())?;

    let sa = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: psd.0,
        bInheritHandle: false.into(),
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_GENERIC_WRITE.0,
            FILE_SHARE_NONE,
            Some(&sa),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .map_err(|error| error.to_string())?;
    Ok(unsafe { fs::File::from_raw_handle(handle.0) })
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
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
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn current_process_start_identity() -> Result<String, String> {
    use windows::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    }
    .map_err(|error| error.to_string())?;
    Ok(((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)).to_string())
}

// Keep in step with processStartIdentity in agent/runtime-client.mjs.
#[cfg(target_os = "macos")]
fn current_process_start_identity() -> Result<String, String> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-o", "lstart=", "-p", &std::process::id().to_string()])
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .output()
        .map_err(|error| error.to_string())?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !output.status.success() || value.is_empty() {
        return Err("process start identity is unavailable".to_owned());
    }
    Ok(value)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn current_process_start_identity() -> Result<String, String> {
    let stat = fs::read_to_string("/proc/self/stat").map_err(|error| error.to_string())?;
    let end = stat
        .rfind(')')
        .ok_or_else(|| "process stat is malformed".to_owned())?;
    stat[end + 2..]
        .split_whitespace()
        .nth(19)
        .filter(|value| value.bytes().all(|byte| byte.is_ascii_digit()))
        .map(str::to_owned)
        .ok_or_else(|| "process start identity is unavailable".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{RuntimeDescriptor, RuntimeDescriptorState, RUNTIME_PROTOCOL};

    #[test]
    fn descriptor_publish_is_replaceable_and_generation_scoped() {
        let dir = tempfile::tempdir().unwrap();
        let first =
            RuntimeDescriptorState::new(dir.path(), "a".repeat(64), "c".repeat(64), 50400, 222)
                .unwrap();
        assert!(first.publish("local").is_err());
        first.activate();
        first.publish("local").unwrap();
        let path = dir.path().join("agent-runtime.json");
        let local: RuntimeDescriptor =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(local.protocol, RUNTIME_PROTOCOL);
        assert_eq!(local.readiness, "local");
        assert_eq!(local.sidecar_pid, 222);

        assert!(first.publish("cloud_authenticated").is_err());
        assert!(first.publish("sign_in_required").is_err());
        first.publish("local").unwrap();
        let updated: RuntimeDescriptor =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(updated.readiness, "local");

        let replacement =
            RuntimeDescriptorState::new(dir.path(), "b".repeat(64), "d".repeat(64), 50401, 333)
                .unwrap();
        replacement.activate();
        replacement.publish("local").unwrap();
        first.remove_owned().unwrap();
        assert!(path.is_file());
        replacement.remove_owned().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn rejects_an_unknown_readiness_state() {
        let dir = tempfile::tempdir().unwrap();
        let state =
            RuntimeDescriptorState::new(dir.path(), "c".repeat(64), "e".repeat(64), 50400, 222)
                .unwrap();
        state.activate();
        assert!(state.publish("starting").is_err());
        assert!(!dir.path().join("agent-runtime.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_is_created_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let state =
            RuntimeDescriptorState::new(dir.path(), "a".repeat(64), "b".repeat(64), 50400, 222)
                .unwrap();
        state.activate();
        state.publish("local").unwrap();
        let mode = std::fs::metadata(dir.path().join("agent-runtime.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(windows)]
    #[test]
    fn descriptor_is_created_with_protected_user_only_dacl() {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::{BOOL, PCWSTR},
            Win32::Security::{
                AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetFileSecurityW,
                GetSecurityDescriptorControl, GetSecurityDescriptorDacl, ACCESS_ALLOWED_ACE,
                ACE_HEADER, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
                PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
            },
        };

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-runtime.json");
        // Seed an inherited-ACL file first to verify atomic replacement preserves strict DACL.
        std::fs::write(&path, b"{}").unwrap();

        let state =
            RuntimeDescriptorState::new(dir.path(), "a".repeat(64), "b".repeat(64), 50400, 222)
                .unwrap();
        state.activate();
        state.publish("local").unwrap();

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut needed = 0_u32;
        let _ = unsafe {
            GetFileSecurityW(
                PCWSTR(wide.as_ptr()),
                DACL_SECURITY_INFORMATION.0,
                None,
                0,
                &mut needed,
            )
        };
        assert!(needed > 0);
        let mut sd_buf = vec![0_u64; (needed as usize).div_ceil(size_of::<u64>())];
        let psd = PSECURITY_DESCRIPTOR(sd_buf.as_mut_ptr().cast());
        let ok = unsafe {
            GetFileSecurityW(
                PCWSTR(wide.as_ptr()),
                DACL_SECURITY_INFORMATION.0,
                Some(psd),
                needed,
                &mut needed,
            )
        };
        assert!(ok.as_bool());

        let mut control = 0_u16;
        let mut revision = 0_u32;
        unsafe { GetSecurityDescriptorControl(psd, &mut control, &mut revision) }.unwrap();
        assert_ne!(control & SE_DACL_PROTECTED.0, 0);

        let mut dacl_present = BOOL::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut dacl_defaulted = BOOL::default();
        unsafe {
            GetSecurityDescriptorDacl(psd, &mut dacl_present, &mut dacl, &mut dacl_defaulted)
        }
        .unwrap();
        assert!(dacl_present.as_bool());
        assert!(!dacl.is_null());

        let mut size_info = ACL_SIZE_INFORMATION::default();
        unsafe {
            GetAclInformation(
                dacl,
                (&mut size_info as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        }
        .unwrap();
        assert_eq!(size_info.AceCount, 1);

        let mut raw_ace: *mut core::ffi::c_void = std::ptr::null_mut();
        unsafe { GetAce(dacl, 0, &mut raw_ace) }.unwrap();
        let header = unsafe { &*(raw_ace as *const ACE_HEADER) };
        assert_eq!(header.AceType, 0); // ACCESS_ALLOWED_ACE_TYPE
        let ace = unsafe { &*(raw_ace as *const ACCESS_ALLOWED_ACE) };
        let ace_sid = PSID((&ace.SidStart as *const u32 as *mut core::ffi::c_void).cast());

        let mut expected_sid = super::current_user_sid_bytes().unwrap();
        let expected_psid = PSID(expected_sid.as_mut_ptr().cast());
        assert!(unsafe { EqualSid(ace_sid, expected_psid) }.is_ok());
    }
}
