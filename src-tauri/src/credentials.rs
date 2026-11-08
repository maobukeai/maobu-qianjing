// Origin checks for the local script bridge. No Cloud credential access.
use tauri::WebviewWindow;

pub struct CredentialOrigin(pub String);

pub(crate) fn authorize(window: &WebviewWindow, state: &CredentialOrigin) -> Result<(), String> {
    if window.label() != "main" {
        return Err("script bridge is available only to the main window".to_owned());
    }
    let origin = window
        .url()
        .map_err(|_| "script bridge could not verify the window origin".to_owned())?
        .origin()
        .ascii_serialization();
    if origin != state.0 {
        return Err("script bridge rejected the window origin".to_owned());
    }
    Ok(())
}
