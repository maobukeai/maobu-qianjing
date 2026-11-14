//! Offline verification only: this binary never downloads, parses, or executes an installer.
//! It uses the exact Minisign verification library used by the official Tauri updater.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{fs, io::Read, path::Path};

fn decode(value: &str) -> Result<String, String> {
    if value.len() > 16 * 1024 {
        return Err("Encoded signing data is too large".to_owned());
    }
    String::from_utf8(
        STANDARD
            .decode(value.trim())
            .map_err(|_| "Invalid encoded signing data".to_owned())?,
    )
    .map_err(|_| "Invalid signing text".to_owned())
}
fn signature_data(
    public_key: &str,
    signature: &str,
    expected_file: &str,
) -> Result<(PublicKey, Signature), String> {
    let key =
        PublicKey::decode(&decode(public_key)?).map_err(|_| "Invalid public key".to_owned())?;
    let signature = Signature::decode(&decode(signature)?)
        .map_err(|_| "Invalid artifact signature".to_owned())?;
    let expected = format!("file:{expected_file}");
    let files: Vec<_> = signature
        .trusted_comment()
        .split('\t')
        .filter(|field| field.starts_with("file:"))
        .collect();
    if files != [expected.as_str()] {
        return Err("Signature does not bind the expected release filename and version".to_owned());
    }
    Ok((key, signature))
}
fn verify_file(
    public_key: &str,
    signature: &str,
    path: &Path,
    expected_file: &str,
) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "Release artifact is unavailable".to_owned())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > 512 * 1024 * 1024
    {
        return Err("Release artifact must be a regular file up to 512 MiB".to_owned());
    }
    let (key, signature) = signature_data(public_key, signature, expected_file)?;
    let mut verifier = key
        .verify_stream(&signature)
        .map_err(|_| "Unsupported artifact signature".to_owned())?;
    let mut file =
        fs::File::open(path).map_err(|_| "Release artifact could not be opened".to_owned())?;
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let bytes = file
            .read(&mut buffer)
            .map_err(|_| "Release artifact could not be read".to_owned())?;
        if bytes == 0 {
            break;
        }
        total += bytes as u64;
        if total > 512 * 1024 * 1024 {
            return Err("Release artifact grew beyond the size limit".to_owned());
        }
        verifier.update(&buffer[..bytes]);
    }
    if total != metadata.len() {
        return Err("Release artifact changed during verification".to_owned());
    }
    verifier.finalize().map_err(|_| {
        "Release signature verification failed. The artifact or public key does not match."
            .to_owned()
    })
}
fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("Usage: maobu-release-verify <installer-path> <version>; MAOBU_UPDATE_PUBLIC_KEY must contain the publisher public key".to_owned());
    }
    let path = Path::new(&args[0]);
    let version = &args[1];
    if version.is_empty()
        || version.len() > 100
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
    {
        return Err("Invalid release version".to_owned());
    }
    let name = format!("MaobuBrowser_{version}_x64-setup.exe");
    if path.file_name().and_then(|value| value.to_str()) != Some(name.as_str()) {
        return Err("Release installer filename does not match its version".to_owned());
    }
    let public_key = std::env::var("MAOBU_UPDATE_PUBLIC_KEY")
        .map_err(|_| "MAOBU_UPDATE_PUBLIC_KEY is required".to_owned())?;
    let signature_path = path.with_file_name(format!("{name}.sig"));
    let metadata = fs::symlink_metadata(&signature_path)
        .map_err(|_| "Detached artifact signature is unavailable".to_owned())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16 * 1024 {
        return Err("Detached artifact signature is invalid".to_owned());
    }
    let signature = fs::read_to_string(signature_path)
        .map_err(|_| "Detached artifact signature could not be read".to_owned())?;
    verify_file(&public_key, &signature, path, &name)
}
fn main() {
    match run() {
        Ok(()) => println!("Official updater-compatible signature and release filename verified."),
        Err(error) => {
            eprintln!("Release verification failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Public verification fixture from minisign-verify 0.2.5 (MIT), no private key.
    const PUBLIC: &str = "untrusted comment: public verification fixture\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";
    #[test]
    fn authentic_payload_verifies_and_tampering_is_rejected() {
        let (key, signature) = signature_data(
            &STANDARD.encode(PUBLIC),
            &STANDARD.encode(SIGNATURE),
            "test",
        )
        .unwrap();
        let mut verifier = key.verify_stream(&signature).unwrap();
        verifier.update(b"test");
        assert!(verifier.finalize().is_ok());
        let mut changed = key.verify_stream(&signature).unwrap();
        changed.update(b"tampered installer bytes");
        assert!(changed.finalize().is_err());
    }
    #[test]
    fn trusted_filename_and_global_signature_cannot_be_rewritten() {
        assert!(signature_data(
            &STANDARD.encode(PUBLIC),
            &STANDARD.encode(SIGNATURE),
            "MaobuBrowser_9.9.9_x64-setup.exe"
        )
        .is_err());
        let changed = SIGNATURE.replace("file:test", "file:MaobuBrowser_9.9.9_x64-setup.exe");
        let (key, signature) = signature_data(
            &STANDARD.encode(PUBLIC),
            &STANDARD.encode(changed),
            "MaobuBrowser_9.9.9_x64-setup.exe",
        )
        .unwrap();
        let mut verifier = key.verify_stream(&signature).unwrap();
        verifier.update(b"test");
        assert!(verifier.finalize().is_err());
    }
    #[test]
    fn an_unrelated_publisher_key_does_not_verify_the_asset() {
        let mut bytes = STANDARD
            .decode("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3")
            .unwrap();
        bytes[12] ^= 1;
        let other = format!(
            "untrusted comment: unrelated public fixture\n{}\n",
            STANDARD.encode(bytes)
        );
        let (key, signature) =
            signature_data(&STANDARD.encode(other), &STANDARD.encode(SIGNATURE), "test").unwrap();
        let mut verifier = key.verify_stream(&signature).unwrap();
        verifier.update(b"test");
        assert!(verifier.finalize().is_err());
    }
}
