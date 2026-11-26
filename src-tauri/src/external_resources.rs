use crate::credentials::CredentialOrigin;
use tauri::{AppHandle, Url, WebviewWindow};
use tauri_plugin_shell::ShellExt;

const UNSUPPORTED: &str = "This link is not supported by the desktop app.";
const DOCUMENTS: &[(&str, &str)] = &[
    ("docs.ollama.com", "/faq"),
    ("wiki.metacubex.one", "/en/config/inbound/port/"),
    (
        "docs.brightdata.com",
        "/left-over/proxy-networks-introduction",
    ),
    (
        "developers.oxylabs.io",
        "/help-center/products-and-features/supported-protocols",
    ),
    ("help.decodo.com", "/docs/residential-proxy-session-types"),
    ("github.com", "/maobukeai/maobu-qianjing"),
];

fn destination(input: &str) -> Result<Url, &'static str> {
    if input.len() > 2048 || input.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(UNSUPPORTED);
    }
    let url = Url::parse(input).map_err(|_| UNSUPPORTED)?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(UNSUPPORTED);
    }
    let host = url.host_str().ok_or(UNSUPPORTED)?;
    if DOCUMENTS
        .iter()
        .any(|(domain, path)| host == *domain && url.path() == *path)
    {
        return Ok(url);
    }
    if host == "github.com" {
        let parts: Vec<_> = url.path_segments().ok_or(UNSUPPORTED)?.collect();
        let valid_component = |value: &str| {
            !value.is_empty()
                && value != "."
                && value != ".."
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        };
        if parts.len() >= 5
            && valid_component(parts[0])
            && valid_component(parts[1])
            && parts[2] == "releases"
            && parts[3] == "tag"
            && parts[4..].iter().all(|part| !part.is_empty())
        {
            return Ok(url);
        }
    }
    Err(UNSUPPORTED)
}

#[tauri::command]
#[allow(deprecated)] // Reuse the bundled Rust opener without exposing generic JS shell permissions.
pub fn open_external_resource(
    app: AppHandle,
    window: WebviewWindow,
    origin: tauri::State<'_, CredentialOrigin>,
    url: String,
) -> Result<(), String> {
    crate::credentials::authorize(&window, &origin)?;
    crate::acceptance::ensure_action_allowed(&app)?;
    let url = destination(&url).map_err(str::to_owned)?;
    // Open the parsed canonical URL, never a raw command or arbitrary filesystem path.
    app.shell()
        .open(url.as_str(), None)
        .map_err(|_| "The external link could not be opened.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_product_documents_and_github_release_pages() {
        for (host, path) in DOCUMENTS {
            assert!(destination(&format!("https://{host}{path}")).is_ok());
        }
        assert!(destination("https://github.com/owner/repo/releases/tag/v1.2.3").is_ok());
        assert!(destination("https://github.com/owner/repo/releases/tag/beta/v1.2.3").is_ok());
        assert_eq!(
            destination("https://DOCS.OLLAMA.COM:443/faq")
                .unwrap()
                .as_str(),
            "https://docs.ollama.com/faq"
        );
    }

    #[test]
    fn every_bundled_document_link_has_a_native_destination() {
        for source in [
            include_str!("../../web/proxy-resources.tsx"),
            include_str!("../../web/local-assistant.tsx"),
            include_str!("../../web/about-popover.tsx"),
        ] {
            for fragment in source.split("\"https://").skip(1) {
                let address = format!("https://{}", fragment.split('"').next().unwrap());
                assert!(
                    destination(&address).is_ok(),
                    "Bundled documentation link lacks a native destination"
                );
            }
        }
    }

    #[test]
    fn rejects_unrelated_destinations_and_embedded_secrets_without_echoing_input() {
        for url in [
            "http://docs.ollama.com/faq",
            "https://docs.ollama.com:444/faq",
            "https://docs.ollama.com.evil.test/faq",
            "https://docs.ollama.com/download",
            "https://user:private-password@docs.ollama.com/faq",
            "https://docs.ollama.com/faq?token=private-token",
            "https://docs.ollama.com/faq#private-token",
            "https://github.com/owner/repo/issues/1",
            "https://github.com/owner/repo/releases/tag/",
            "https://github.com.evil.test/owner/repo/releases/tag/v1",
            "file:///C:/private.txt",
            "javascript:alert(1)",
            "https://127.0.0.1/faq",
            "https://docs.ollama.com/faq\n",
        ] {
            assert_eq!(destination(url).unwrap_err(), UNSUPPORTED);
        }
    }
}
