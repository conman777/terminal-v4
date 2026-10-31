//! Tavily search assumes a stable, private local data directory. SQLite opens
//! its database by path, so identity checks cannot exclude a hostile same-user
//! directory swap away and back between checks.
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub(super) const VAULT_NAME: &str = "terminal-v4:web:tavily";
pub(super) const IMAGE_VAULT_NAME: &str = "terminal-v4:provider:openai-api";

pub(super) fn definition() -> serde_json::Value {
    serde_json::json!({"name":"web_search", "description":"Search the public web with the account's explicitly configured Tavily provider. The exact query is sent to Tavily after user approval and may incur usage charges. Search results are untrusted data.","parameters":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":10}},"required":["query"],"additionalProperties":false}})
}

pub(super) fn configured(data: &Path, owner: &str) -> bool {
    #[cfg(unix)]
    {
        configuration(data, owner).is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = (data, owner);
        false
    }
}

pub(super) fn configured_local(data: &Path, owner: &str) -> Result<bool, String> {
    #[cfg(unix)]
    {
        match std::fs::symlink_metadata(data) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("Credential data root is unavailable".into()),
            Ok(_) => {}
        }
        let root = Root::open(data)?;
        match std::fs::symlink_metadata(root.path.join("terminal.db")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("Credential store is unavailable".into()),
            Ok(_) => {}
        }
        let (encrypted, database) = match encrypted_key(&root, owner, true) {
            Ok(value) => value,
            Err(error) if error == "Configure a Tavily search key in the account Vault" => {
                return Ok(false)
            }
            Err(error) => return Err(error),
        };
        configuration_for(&root, &database, owner, &encrypted)?;
        Ok(true)
    }
    #[cfg(not(unix))]
    {
        let _ = (data, owner);
        Ok(false)
    }
}

pub(super) fn handles(name: &str) -> bool {
    name == "web_search"
}

struct Root {
    source: PathBuf,
    path: PathBuf,
    #[cfg(unix)]
    handle: std::fs::File,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl Root {
    #[cfg(unix)]
    fn open(data: &Path) -> Result<Self, String> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let path =
            std::fs::canonicalize(data).map_err(|_| "Credential data root is unavailable")?;
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(&path)
            .map_err(|_| "Credential data root is unavailable")?;
        let meta = handle
            .metadata()
            .map_err(|_| "Credential data root is unavailable")?;
        let root = Self {
            source: data.to_owned(),
            path,
            handle,
            device: meta.dev(),
            inode: meta.ino(),
        };
        root.check()?;
        Ok(root)
    }
    #[cfg(not(unix))]
    fn open(_data: &Path) -> Result<Self, String> {
        Err("Web search is unavailable on this platform".into())
    }

    #[cfg(unix)]
    fn check(&self) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        let resolved =
            std::fs::canonicalize(&self.source).map_err(|_| "Credential data root changed")?;
        let source = std::fs::metadata(&self.source).map_err(|_| "Credential data root changed")?;
        let opened = self
            .handle
            .metadata()
            .map_err(|_| "Credential data root changed")?;
        if resolved != self.path
            || !source.is_dir()
            || !opened.is_dir()
            || source.dev() != self.device
            || source.ino() != self.inode
            || opened.dev() != self.device
            || opened.ino() != self.inode
        {
            return Err("Credential data root changed; review the action again".into());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    fn check(&self) -> Result<(), String> {
        Err("Web search is unavailable on this platform".into())
    }

    fn fingerprint(&self) -> serde_json::Value {
        #[cfg(unix)]
        {
            serde_json::json!({"path":self.path.as_os_str().as_encoded_bytes(),"device":self.device,"inode":self.inode})
        }
        #[cfg(not(unix))]
        {
            serde_json::Value::Null
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct DatabaseIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

fn database_identity(metadata: &std::fs::Metadata) -> DatabaseIdentity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        DatabaseIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        DatabaseIdentity {}
    }
}

fn ensure_immutable_read_is_safe(root: &Root) -> Result<(), String> {
    use std::io::Read;
    root.check()?;
    for name in ["terminal.db-wal", "terminal.db-journal"] {
        match std::fs::symlink_metadata(root.path.join(name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Credential store journal status is unavailable".into()),
            Ok(_) => return Err(
                "Credential store requires live journal access; local tool metadata is unavailable"
                    .into(),
            ),
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let mut file = options
        .open(root.path.join("terminal.db"))
        .map_err(|_| "Credential store is unavailable")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Credential store is unavailable")?;
    if !metadata.is_file() {
        return Err("Credential store is unavailable".into());
    }
    let mut header = [0u8; 20];
    file.read_exact(&mut header)
        .map_err(|_| "Credential store header is unavailable")?;
    if &header[..16] != b"SQLite format 3\0" || header[18] != 1 || header[19] != 1 {
        return Err(
            "Credential store requires live journal access; local tool metadata is unavailable"
                .into(),
        );
    }
    root.check()
}

fn encrypted_key(
    root: &Root,
    owner: &str,
    immutable: bool,
) -> Result<(String, DatabaseIdentity), String> {
    encrypted_key_named(root, owner, immutable, VAULT_NAME)
}

fn encrypted_key_named(
    root: &Root,
    owner: &str,
    immutable: bool,
    key_name: &str,
) -> Result<(String, DatabaseIdentity), String> {
    let missing = if key_name == VAULT_NAME {
        "Configure a Tavily search key in the account Vault"
    } else {
        "Configure an OpenAI API key in the account Vault"
    };
    let duplicate = if key_name == VAULT_NAME {
        "Keep exactly one Tavily search key in the account Vault"
    } else {
        "Keep exactly one OpenAI API key in the account Vault"
    };
    root.check()?;
    let path = root.path.join("terminal.db");
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| missing)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Credential store is unavailable".into());
    }
    let mut flags =
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let filename = if immutable {
        ensure_immutable_read_is_safe(root)?;
        let mut uri =
            url::Url::from_file_path(&path).map_err(|_| "Credential store path is unavailable")?;
        uri.set_query(Some("immutable=1"));
        flags |= rusqlite::OpenFlags::SQLITE_OPEN_URI;
        uri.to_string()
    } else {
        path.to_str()
            .ok_or("Credential store path is unavailable")?
            .to_owned()
    };
    let db = rusqlite::Connection::open_with_flags(&filename, flags)
        .map_err(|_| "Credential store is unavailable")?;
    db.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "Credential store is unavailable")?;
    let mut query = db
        .prepare("SELECT key_value FROM api_key_vault WHERE user_id=?1 AND key_name=?2 LIMIT 2")
        .map_err(|_| "Credential store is unavailable")?;
    let values = query
        .query_map(rusqlite::params![owner, key_name], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|_| "Credential store is unavailable")?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Credential store is unavailable")?;
    let after = std::fs::symlink_metadata(&path).map_err(|_| "Credential store changed")?;
    let unchanged = !immutable
        || (after.len() == metadata.len()
            && after.modified().map_err(|_| "Credential store changed")?
                == metadata
                    .modified()
                    .map_err(|_| "Credential store changed")?);
    if !after.is_file()
        || after.file_type().is_symlink()
        || database_identity(&after) != database_identity(&metadata)
        || !unchanged
    {
        return Err("Credential store changed; review the action again".into());
    }
    if immutable {
        ensure_immutable_read_is_safe(root)?;
    }
    root.check()?;
    match values.as_slice() {
        [value] if value.len() <= 65_536 => Ok((value.clone(), database_identity(&metadata))),
        [] => Err(missing.into()),
        _ => Err(duplicate.into()),
    }
}

pub(super) fn configuration(data: &Path, owner: &str) -> Result<serde_json::Value, String> {
    let root = Root::open(data)?;
    let (encrypted, database) = encrypted_key(&root, owner, false)?;
    configuration_for(&root, &database, owner, &encrypted)
}

#[cfg(unix)]
fn vault_identity(root: &Root) -> Result<serde_json::Value, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    root.check()?;
    let configured = match std::env::var("VAULT_ENCRYPTION_KEY") {
        Ok(key) if key == "dev-vault-key-change-in-production" => None,
        Ok(key) if key.trim().is_empty() => {
            return Err("Vault encryption configuration is invalid".into())
        }
        Ok(key) => Some(hex::encode(Sha256::digest(key.as_bytes()))),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => return Err("Vault encryption configuration is invalid".into()),
    };
    let path = root.path.join("vault-encryption.key");
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    let installed = match options.open(&path) {
        Ok(file) => {
            let opened = file
                .metadata()
                .map_err(|_| "Vault installation key is unavailable")?;
            let current =
                std::fs::symlink_metadata(&path).map_err(|_| "Vault installation key changed")?;
            if !opened.is_file()
                || !current.is_file()
                || current.file_type().is_symlink()
                || opened.len() != 64
                || opened.permissions().mode() & 0o077 != 0
                || current.permissions().mode() & 0o077 != 0
                || opened.dev() != current.dev()
                || opened.ino() != current.ino()
            {
                return Err("Vault installation key is invalid or changed".into());
            }
            Some(serde_json::json!({"device":opened.dev(),"inode":opened.ino()}))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("Vault installation key is unavailable".into()),
    };
    if installed.is_none() && configured.is_none() {
        return Err("Vault installation key is unavailable".into());
    }
    root.check()?;
    Ok(serde_json::json!({"installed":installed,"configuredKeyDigest":configured}))
}

#[cfg(not(unix))]
fn vault_identity(_root: &Root) -> Result<serde_json::Value, String> {
    Err("Web search is unavailable on this platform".into())
}

fn configuration_for(
    root: &Root,
    database: &DatabaseIdentity,
    owner: &str,
    encrypted: &str,
) -> Result<serde_json::Value, String> {
    #[cfg(unix)]
    let db = serde_json::json!({"device":database.device,"inode":database.inode});
    #[cfg(not(unix))]
    let db = serde_json::Value::Null;
    Ok(
        serde_json::json!({"provider":"Tavily", "endpoint":"https://api.tavily.com/search", "owner":owner,
        "dataRoot":root.fingerprint(), "database":db, "vaultKey":vault_identity(root)?, "credentialDigest":hex::encode(Sha256::digest(encrypted.as_bytes()))}),
    )
}

#[cfg(unix)]
fn image_configuration_for(
    root: &Root,
    database: &DatabaseIdentity,
    owner: &str,
    encrypted: &str,
) -> Result<serde_json::Value, String> {
    let mut result = configuration_for(root, database, owner, encrypted)?;
    result["provider"] = serde_json::json!("OpenAI Images");
    result["endpoint"] = serde_json::json!("https://api.openai.com/v1/images/generations");
    result["credentialName"] = serde_json::json!(IMAGE_VAULT_NAME);
    Ok(result)
}

#[cfg(unix)]
pub(super) fn image_credential_configuration(
    data: &Path,
    owner: &str,
) -> Result<serde_json::Value, String> {
    let root = Root::open(data)?;
    let (encrypted, database) = encrypted_key_named(&root, owner, false, IMAGE_VAULT_NAME)?;
    image_configuration_for(&root, &database, owner, &encrypted)
}

#[cfg(unix)]
pub(super) struct ImageCredential {
    pub(super) secret: String,
    root: Root,
}

#[cfg(unix)]
impl ImageCredential {
    pub(super) fn check_root(&self) -> Result<(), String> {
        self.root.check()
    }
}

#[cfg(unix)]
pub(super) fn reviewed_image_credential(
    data: &Path,
    owner: &str,
    reviewed: &serde_json::Value,
) -> Result<ImageCredential, String> {
    let root = Root::open(data)?;
    let (encrypted, database) = encrypted_key_named(&root, owner, false, IMAGE_VAULT_NAME)?;
    if image_configuration_for(&root, &database, owner, &encrypted)? != *reviewed {
        return Err(
            "Image provider configuration changed; review and approve the action again".into(),
        );
    }
    let secret = crate::vault::VaultCipher::load_existing(&root.path)
        .and_then(|cipher| cipher.decrypt(&encrypted))
        .map_err(|_| "Cannot decrypt the account's OpenAI API key")?;
    if !(8..=4096).contains(&secret.len())
        || !secret.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err("Invalid OpenAI API key in the account Vault".into());
    }
    let (current, current_database) = encrypted_key_named(&root, owner, false, IMAGE_VAULT_NAME)?;
    if current != encrypted
        || current_database != database
        || image_configuration_for(&root, &current_database, owner, &current)? != *reviewed
    {
        return Err(
            "Image provider configuration changed; review and approve the action again".into(),
        );
    }
    Ok(ImageCredential { secret, root })
}

fn reviewed_secret(
    data: &Path,
    owner: &str,
    reviewed: &serde_json::Value,
) -> Result<(String, Root), String> {
    let root = Root::open(data)?;
    let (encrypted, database) = encrypted_key(&root, owner, false)?;
    if configuration_for(&root, &database, owner, &encrypted)? != *reviewed {
        return Err(
            "Search provider configuration changed; review and approve the action again".into(),
        );
    }
    let secret = crate::vault::VaultCipher::load_existing(&root.path)
        .and_then(|cipher| cipher.decrypt(&encrypted))
        .map_err(|_| "Cannot decrypt the account's Tavily search key")?;
    if !(8..=4096).contains(&secret.len()) || !secret.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("Invalid Tavily search key in the account Vault".into());
    }
    let (current, current_database) = encrypted_key(&root, owner, false)?;
    if current != encrypted
        || current_database != database
        || configuration_for(&root, &current_database, owner, &current)? != *reviewed
    {
        return Err(
            "Search provider configuration changed; review and approve the action again".into(),
        );
    }
    Ok((secret, root))
}

pub(super) fn validate(input: &serde_json::Value) -> Result<(String, u8), String> {
    let args = input
        .as_object()
        .ok_or("Search arguments must be an object")?;
    if args.keys().any(|key| key != "query" && key != "limit") {
        return Err("Unexpected search argument".into());
    }
    let raw = input["query"].as_str().ok_or("Search query is required")?;
    let query = raw.trim();
    if query.is_empty() || raw.len() > 1024 || raw.chars().any(char::is_control) {
        return Err("Search query must contain 1-1024 printable bytes".into());
    }
    let limit = match args.get("limit") {
        None => 5,
        Some(value) => value
            .as_u64()
            .filter(|value| (1..=10).contains(value))
            .ok_or("Search limit must be 1-10")? as u8,
    };
    Ok((raw.to_owned(), limit))
}

fn public_addresses(
    addresses: Vec<std::net::SocketAddr>,
) -> Result<Vec<std::net::SocketAddr>, String> {
    public_addresses_for_port(addresses, 443)
}

pub(super) fn public_addresses_for_port(
    addresses: Vec<std::net::SocketAddr>,
    port: u16,
) -> Result<Vec<std::net::SocketAddr>, String> {
    if addresses.len() > 64 {
        return Err("Search provider returned too many network addresses".into());
    }
    let mut allowed = Vec::new();
    for address in addresses {
        if address.port() != port {
            return Err("Invalid search provider port".into());
        }
        let std::net::IpAddr::V4(ip) = address.ip() else {
            continue;
        };
        let [a, b, c, _] = ip.octets();
        let reserved = a == 0
            || a == 10
            || a == 127
            || a >= 224
            || (a == 100 && (64..=127).contains(&b))
            || (a == 169 && b == 254)
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 192 && b == 0 && (c == 0 || c == 2))
            || (a == 192 && b == 88 && c == 99)
            || (a == 198 && (b == 18 || b == 19))
            || (a == 198 && b == 51 && c == 100)
            || (a == 203 && b == 0 && c == 113);
        if reserved {
            return Err("Search provider resolved to a non-public address".into());
        }
        if !allowed.contains(&address) {
            allowed.push(address);
        }
    }
    if allowed.is_empty() || allowed.len() > 16 {
        return Err("No usable public search address".into());
    }
    Ok(allowed)
}

pub(super) fn client_policy(
    builder: reqwest::ClientBuilder,
    host: &str,
    addresses: &[std::net::SocketAddr],
) -> reqwest::ClientBuilder {
    builder
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(20))
        .resolve_to_addrs(host, addresses)
}

pub(super) fn sanitized_url(value: &str) -> Option<String> {
    if value.len() > 2048 || value.chars().any(char::is_control) {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    if url.query_pairs().any(|(key, _)| {
        matches!(
            key.to_ascii_lowercase().as_str(),
            "access_token"
                | "api_key"
                | "apikey"
                | "auth_token"
                | "authorization"
                | "client_secret"
                | "credential"
                | "credentials"
                | "jwt"
                | "password"
                | "passwd"
                | "secret"
                | "session_id"
                | "signature"
                | "token"
                | "x-amz-signature"
                | "x-amz-security-token"
        )
    }) {
        return None;
    }
    Some(url.to_string())
}

fn credential_variants(secret: &str) -> Vec<String> {
    use base64::Engine;
    vec![
        secret.to_owned(),
        url::form_urlencoded::byte_serialize(secret.as_bytes()).collect(),
        base64::engine::general_purpose::STANDARD.encode(secret),
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(secret),
        base64::engine::general_purpose::URL_SAFE.encode(secret),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret),
        hex::encode(secret),
        hex::encode_upper(secret),
    ]
}

fn percent_decode(value: &str) -> String {
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let source = value.as_bytes();
    let mut bytes = Vec::with_capacity(source.len());
    let mut i = 0;
    while i < source.len() {
        if source[i] == b'%' && i + 2 < source.len() {
            if let (Some(a), Some(b)) = (nibble(source[i + 1]), nibble(source[i + 2])) {
                bytes.push((a << 4) | b);
                i += 3;
                continue;
            }
        }
        bytes.push(source[i]);
        i += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn contains_credential(value: &str, variants: &[String]) -> bool {
    let decoded = percent_decode(value);
    let twice_decoded = percent_decode(&decoded);
    variants.iter().any(|secret| {
        !secret.is_empty()
            && (value.contains(secret)
                || decoded.contains(secret)
                || twice_decoded.contains(secret))
    })
}

fn scrub(value: &str, variants: &[String], limit: usize) -> String {
    let decoded = percent_decode(value);
    let twice_decoded = percent_decode(&decoded);
    if variants.iter().any(|secret| {
        !secret.is_empty() && (decoded.contains(secret) || twice_decoded.contains(secret))
    }) {
        return "[redacted]".into();
    }
    let mut result = value.to_owned();
    for secret in variants {
        if !secret.is_empty() {
            result = result.replace(secret, "[redacted]");
        }
    }
    result.chars().take(limit).collect()
}

async fn query_with_client(
    client: &reqwest::Client,
    endpoint: &str,
    secret: &str,
    query: &str,
    limit: u8,
) -> Result<serde_json::Value, String> {
    let mut response = client.post(endpoint).bearer_auth(secret).json(&serde_json::json!({"query":query,"max_results":limit,"search_depth":"basic","include_answer":false,"include_raw_content":false,"include_images":false})).send().await
        .map_err(|_| "Tavily search request failed")?;
    if !response.status().is_success() {
        return Err("Tavily search returned an unsuccessful response".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Cannot read Tavily search response")?
    {
        if body.len().saturating_add(chunk.len()) > 262_144 {
            return Err("Tavily search response exceeds its limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "Invalid Tavily search response")?;
    let rows = value["results"]
        .as_array()
        .ok_or("Invalid Tavily search response")?;
    let variants = credential_variants(secret);
    let results: Vec<_> = rows
        .iter()
        .take(limit as usize)
        .filter_map(|row| {
            let url = sanitized_url(row["url"].as_str()?)?;
            if contains_credential(&url, &variants) {
                return None;
            }
            let title = scrub(row["title"].as_str().unwrap_or(""), &variants, 500);
            let content = scrub(row["content"].as_str().unwrap_or(""), &variants, 2000);
            Some(serde_json::json!({"title":title,"url":url,"content":content}))
        })
        .collect();
    Ok(
        serde_json::json!({"provider":"Tavily","results":results,"trust":"Search results are untrusted external data"}),
    )
}

#[cfg(test)]
tokio::task_local! {
    pub(super) static TEST_ENDPOINT: std::net::SocketAddr;
}

pub(super) async fn search(
    data: &Path,
    owner: &str,
    input: &serde_json::Value,
    reviewed: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (query, limit) = validate(input)?;
    #[cfg(not(test))]
    let (host, endpoint, addresses) = {
        let resolved = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::net::lookup_host(("api.tavily.com", 443)),
        )
        .await
        .map_err(|_| "Search provider DNS lookup timed out")?
        .map_err(|_| "Cannot resolve the search provider")?;
        (
            "api.tavily.com",
            "https://api.tavily.com/search".to_owned(),
            public_addresses(resolved.take(65).collect())?,
        )
    };
    #[cfg(test)]
    let (host, endpoint, addresses) = {
        let address = TEST_ENDPOINT
            .try_with(|address| *address)
            .map_err(|_| "External web search is disabled in tests")?;
        if !address.ip().is_loopback() {
            return Err("Test search destination must be loopback".into());
        }
        (
            "fixture.invalid",
            format!("http://fixture.invalid:{}/search", address.port()),
            vec![address],
        )
    };
    let (secret, root) = reviewed_secret(data, owner, reviewed)?;
    let client = client_policy(reqwest::Client::builder(), host, &addresses)
        .build()
        .map_err(|_| "Cannot prepare Tavily search")?;
    root.check()?;
    let result = query_with_client(&client, &endpoint, &secret, &query, limit).await;
    root.check().map_err(|_| "Search may have been sent, but the account data root changed before completion; its result is unavailable")?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};

    fn add_key(path: &Path, owner: &str, name: &str, value: &str) {
        let db = Connection::open(path.join("terminal.db")).unwrap();
        db.execute_batch("CREATE TABLE IF NOT EXISTS api_key_vault (user_id TEXT NOT NULL, key_name TEXT NOT NULL, key_value TEXT NOT NULL)").unwrap();
        let encrypted = crate::vault::VaultCipher::load(path)
            .unwrap()
            .encrypt(value)
            .unwrap();
        db.execute(
            "INSERT INTO api_key_vault (user_id,key_name,key_value) VALUES (?1,?2,?3)",
            params![owner, name, encrypted],
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn image_credential_review_is_owner_scoped_and_changes_on_key_rotation() {
        let data = tempfile::tempdir().unwrap();
        add_key(
            data.path(),
            "owner",
            IMAGE_VAULT_NAME,
            "synthetic-image-token",
        );
        let first = image_credential_configuration(data.path(), "owner").unwrap();
        assert!(!first.to_string().contains("synthetic-image-token"));
        assert!(image_credential_configuration(data.path(), "other-owner").is_err());
        assert!(reviewed_image_credential(data.path(), "other-owner", &first).is_err());
        assert_eq!(
            reviewed_image_credential(data.path(), "owner", &first)
                .unwrap()
                .secret,
            "synthetic-image-token"
        );
        let db = Connection::open(data.path().join("terminal.db")).unwrap();
        let rotated = crate::vault::VaultCipher::load(data.path())
            .unwrap()
            .encrypt("synthetic-rotated-token")
            .unwrap();
        db.execute(
            "UPDATE api_key_vault SET key_value=?1 WHERE user_id=?2 AND key_name=?3",
            params![rotated, "owner", IMAGE_VAULT_NAME],
        )
        .unwrap();
        assert_ne!(
            first,
            image_credential_configuration(data.path(), "owner").unwrap()
        );
        assert!(reviewed_image_credential(data.path(), "owner", &first).is_err());
    }

    #[test]
    fn configured_provider_is_owner_scoped_and_duplicates_fail_closed() {
        let data = tempfile::tempdir().unwrap();
        assert!(configuration(data.path(), "owner").is_err());
        add_key(data.path(), "owner", VAULT_NAME, "synthetic-tavily-token");
        let configured = configuration(data.path(), "owner").unwrap();
        assert_eq!(configured["provider"], "Tavily");
        assert!(!configured.to_string().contains("synthetic-tavily-token"));
        assert!(configuration(data.path(), "other-owner").is_err());
        add_key(data.path(), "owner", VAULT_NAME, "synthetic-other-token");
        assert!(configuration(data.path(), "owner").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn reviewed_credential_rejects_rotation_removal_and_other_owner() {
        let data = tempfile::tempdir().unwrap();
        add_key(data.path(), "owner", VAULT_NAME, "synthetic-fixture-token");
        add_key(data.path(), "other", VAULT_NAME, "other-fixture-token");
        let review = configuration(data.path(), "owner").unwrap();
        assert_eq!(
            reviewed_secret(data.path(), "owner", &review).unwrap().0,
            "synthetic-fixture-token"
        );
        assert!(reviewed_secret(data.path(), "other", &review).is_err());
        let db = Connection::open(data.path().join("terminal.db")).unwrap();
        let encrypted = crate::vault::VaultCipher::load(data.path())
            .unwrap()
            .encrypt("rotated-fixture-token")
            .unwrap();
        db.execute(
            "UPDATE api_key_vault SET key_value=?1 WHERE user_id=?2 AND key_name=?3",
            params![encrypted, "owner", VAULT_NAME],
        )
        .unwrap();
        assert!(reviewed_secret(data.path(), "owner", &review).is_err());
        db.execute(
            "DELETE FROM api_key_vault WHERE user_id=?1 AND key_name=?2",
            params!["owner", VAULT_NAME],
        )
        .unwrap();
        assert!(reviewed_secret(data.path(), "owner", &review).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn provider_configuration_does_not_cross_data_roots() {
        let home = tempfile::tempdir().unwrap();
        let remote = tempfile::tempdir().unwrap();
        add_key(home.path(), "owner", VAULT_NAME, "synthetic-home-token");
        assert!(configured(home.path(), "owner"));
        assert!(!configured(remote.path(), "owner"));
        add_key(remote.path(), "owner", VAULT_NAME, "synthetic-remote-token");
        let home_review = configuration(home.path(), "owner").unwrap();
        assert!(reviewed_secret(remote.path(), "owner", &home_review).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn local_configuration_probe_rejects_wal_without_creating_shm() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        add_key(
            source.path(),
            "owner",
            VAULT_NAME,
            "synthetic-fixture-token",
        );
        let db = Connection::open(source.path().join("terminal.db")).unwrap();
        db.pragma_update(None, "journal_mode", "WAL").unwrap();
        db.execute("INSERT INTO api_key_vault (user_id,key_name,key_value) VALUES ('other','fixture','value')", []).unwrap();
        std::fs::copy(
            source.path().join("terminal.db"),
            target.path().join("terminal.db"),
        )
        .unwrap();
        std::fs::copy(
            source.path().join("terminal.db-wal"),
            target.path().join("terminal.db-wal"),
        )
        .unwrap();
        if source.path().join("vault-encryption.key").exists() {
            std::fs::copy(
                source.path().join("vault-encryption.key"),
                target.path().join("vault-encryption.key"),
            )
            .unwrap();
        }
        let shm = target.path().join("terminal.db-shm");
        assert!(!shm.exists());
        assert!(configured_local(target.path(), "owner").is_err());
        assert!(!shm.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cli_and_structured_context_reject_wal_without_creating_shm() {
        use crate::v4_agent as agent;
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        add_key(
            source.path(),
            "owner",
            VAULT_NAME,
            "synthetic-fixture-token",
        );
        let db = Connection::open(source.path().join("terminal.db")).unwrap();
        db.pragma_update(None, "journal_mode", "WAL").unwrap();
        db.execute("INSERT INTO api_key_vault (user_id,key_name,key_value) VALUES ('other','fixture','value')", []).unwrap();
        std::fs::copy(
            source.path().join("terminal.db"),
            target.path().join("terminal.db"),
        )
        .unwrap();
        std::fs::copy(
            source.path().join("terminal.db-wal"),
            target.path().join("terminal.db-wal"),
        )
        .unwrap();
        if source.path().join("vault-encryption.key").exists() {
            std::fs::copy(
                source.path().join("vault-encryption.key"),
                target.path().join("vault-encryption.key"),
            )
            .unwrap();
        }
        let id = uuid::Uuid::new_v4().to_string();
        agent::context::seed(
            target.path(),
            "owner",
            &root,
            &id,
            "deepseek",
            "deepseek-chat",
        );
        let session = agent::load(target.path(), "owner", &root, &id).unwrap();
        let provider = agent::Provider {
            profile: None,
            transport: "openai-chat".into(),
            url: "http://127.0.0.1/fixture".into(),
            secret: "synthetic-model-token".into(),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
        };
        let shm = target.path().join("terminal.db-shm");
        assert!(!shm.exists());
        assert!(agent::compaction::context_usage(
            &provider,
            target.path(),
            "owner",
            &session,
            None
        )
        .is_err());
        assert!(!shm.exists());
        assert!(agent::context::sample(
            target.path(),
            "owner",
            &root,
            &id,
            "deepseek",
            "deepseek-chat",
            agent::context::ContextOptions::default()
        )
        .is_err());
        assert!(!shm.exists());
    }

    #[cfg(unix)]
    #[test]
    fn local_configuration_probe_handles_absent_or_configured_keys_without_writes() {
        fn files(path: &Path) -> Vec<String> {
            let mut names: Vec<_> = std::fs::read_dir(path)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
        let data = tempfile::tempdir().unwrap();
        let empty = files(data.path());
        assert!(!configured_local(data.path(), "owner").unwrap());
        assert_eq!(files(data.path()), empty);
        add_key(data.path(), "other", VAULT_NAME, "synthetic-other-token");
        let before = files(data.path());
        assert!(!configured_local(data.path(), "owner").unwrap());
        assert_eq!(files(data.path()), before);
        add_key(data.path(), "owner", VAULT_NAME, "synthetic-owner-token");
        let before = files(data.path());
        assert!(configured_local(data.path(), "owner").unwrap());
        assert_eq!(files(data.path()), before);
    }

    #[cfg(unix)]
    #[test]
    fn review_rejects_root_retarget_even_with_copied_credentials() {
        use std::os::unix::fs::symlink;
        let parent = tempfile::tempdir().unwrap();
        let original = parent.path().join("original");
        let replacement = parent.path().join("replacement");
        let alias = parent.path().join("alias");
        std::fs::create_dir(&original).unwrap();
        std::fs::create_dir(&replacement).unwrap();
        add_key(&original, "owner", VAULT_NAME, "synthetic-fixture-token");
        std::fs::copy(
            original.join("terminal.db"),
            replacement.join("terminal.db"),
        )
        .unwrap();
        if original.join("vault-encryption.key").exists() {
            std::fs::copy(
                original.join("vault-encryption.key"),
                replacement.join("vault-encryption.key"),
            )
            .unwrap();
        }
        symlink(&original, &alias).unwrap();
        let review = configuration(&alias, "owner").unwrap();
        assert_eq!(review, configuration(&original, "owner").unwrap());
        let pinned = Root::open(&alias).unwrap();
        std::fs::remove_file(&alias).unwrap();
        symlink(&replacement, &alias).unwrap();
        assert!(pinned.check().is_err());
        assert!(reviewed_secret(&alias, "owner", &review).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn review_rejects_replaced_database_even_with_identical_contents() {
        let data = tempfile::tempdir().unwrap();
        add_key(data.path(), "owner", VAULT_NAME, "synthetic-fixture-token");
        let review = configuration(data.path(), "owner").unwrap();
        let path = data.path().join("terminal.db");
        let replacement = data.path().join("replacement.db");
        std::fs::copy(&path, &replacement).unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert!(reviewed_secret(data.path(), "owner", &review).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn provider_never_follows_a_symlinked_vault_database() {
        use std::os::unix::fs::symlink;
        let data = tempfile::tempdir().unwrap();
        add_key(data.path(), "owner", VAULT_NAME, "synthetic-fixture-token");
        let database = data.path().join("terminal.db");
        let target = data.path().join("other.db");
        std::fs::rename(&database, &target).unwrap();
        symlink(&target, &database).unwrap();
        assert!(configuration(data.path(), "owner").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn review_rejects_replaced_vault_key_even_with_identical_contents() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        add_key(data.path(), "owner", VAULT_NAME, "synthetic-fixture-token");
        let path = data.path().join("vault-encryption.key");
        if !path.exists() {
            std::fs::write(&path, "a".repeat(64)).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let review = configuration(data.path(), "owner").unwrap();
        let replacement = data.path().join("replacement.key");
        std::fs::copy(&path, &replacement).unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert!(reviewed_secret(data.path(), "owner", &review).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn provider_cycle_uses_exact_approval_and_loopback_search_fixture() {
        use crate::v4_agent::{
            self as agent,
            interaction::{ActionScope, ApprovalRequest, Cancellation, Interaction},
        };
        use axum::{routing::post, Json};
        use std::sync::{Arc, Mutex};
        use terminal_v4_core::StructuredSessionEvent;

        struct Gate {
            requests: Mutex<Vec<ApprovalRequest>>,
        }
        #[async_trait::async_trait]
        impl Interaction for Gate {
            async fn emit(&self, _: StructuredSessionEvent) -> Result<(), String> {
                Ok(())
            }
            async fn approve(&self, request: ApprovalRequest) -> Result<bool, String> {
                self.requests.lock().unwrap().push(request);
                Ok(true)
            }
        }
        let captured = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let requests = captured.clone();
        let app = axum::Router::new()
            .route("/v1/chat/completions", post(move |Json(body): Json<serde_json::Value>| {
                let requests = requests.clone();
                async move {
                    let mut requests = requests.lock().unwrap();
                    requests.push(body);
                    Json(if requests.len() == 1 {
                        serde_json::json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":"search","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"synthetic search\",\"limit\":2}"}}]}}]})
                    } else { serde_json::json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Done"}}]}) })
                }
            }))
            .route("/search", post(|headers: axum::http::HeaderMap, Json(body): Json<serde_json::Value>| async move {
                assert_eq!(headers["authorization"], "Bearer synthetic-fixture-token");
                assert_eq!(body["query"], "synthetic search");
                Json(serde_json::json!({"results":[{"title":"Fixture","url":"https://example.test/","content":"Synthetic result"}]}))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let data = tempfile::tempdir().unwrap();
        add_key(data.path(), "owner", VAULT_NAME, "synthetic-fixture-token");
        let workspace = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(workspace.path()).unwrap();
        let mut session = agent::new_session("openai-api", "gpt-4.1", &root);
        let scope = ActionScope {
            owner: "owner".into(),
            session_id: session.id.clone(),
            turn_id: uuid::Uuid::new_v4().to_string(),
        };
        let gate = Gate {
            requests: Mutex::new(vec![]),
        };
        let context = agent::TurnContext {
            scope,
            cancellation: Cancellation::default(),
            interaction: &gate,
            resources: Arc::new(Default::default()),
            attachments: &[],
            local_authority: None,
            tool_policy: agent::ToolPolicy::Standard,
        };
        let mut integrations = super::super::Integrations::default();
        let provider = agent::Provider {
            #[cfg(unix)]
            profile: None,
            transport: "openai-chat".into(),
            url: format!("http://{address}/v1/chat/completions"),
            secret: "synthetic-model-token".into(),
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
        };
        let answer = TEST_ENDPOINT
            .scope(
                address,
                agent::turn_with_interaction(
                    &provider,
                    data.path(),
                    "owner",
                    &mut session,
                    "Search the web",
                    None,
                    &context,
                    &mut integrations,
                ),
            )
            .await
            .unwrap();
        assert_eq!(answer, "Done");
        let approvals = gate.requests.lock().unwrap();
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].tool_name, "web_search");
        assert_eq!(
            approvals[0].tool_input,
            serde_json::json!({"query":"synthetic search","limit":2})
        );
        assert!(approvals[0]
            .description
            .contains("https://api.tavily.com/search"));
        assert!(!approvals[0].description.contains("synthetic-fixture-token"));
        let requests = captured.lock().unwrap();
        assert!(requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "web_search"));
        let model_history = requests[1].to_string();
        assert!(model_history.contains("Synthetic result"));
        assert!(!model_history.contains("synthetic-fixture-token"));
        assert!(!agent::ToolPolicy::ReadOnlyChild.allows("web_search"));
        server.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dispatch_requires_exact_review_and_never_uses_foreign_credentials() {
        use axum::{routing::post, Json};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        add_key(data.path(), "owner", VAULT_NAME, "synthetic-fixture-token");
        let input = serde_json::json!({"query":"synthetic search","limit":2});
        let review =
            super::super::approval_review(data.path(), "owner", "web_search", &input).unwrap();
        assert!(review.description.contains("synthetic search"));
        assert!(super::super::definitions(data.path(), "owner")
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "web_search"));
        assert!(!super::super::definitions(data.path(), "other")
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "web_search"));
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let app = axum::Router::new().route(
            "/search",
            post(move || {
                let seen = seen.clone();
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    Json(serde_json::json!({"results":[]}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut integrations = super::super::Integrations::default();
        TEST_ENDPOINT
            .scope(address, async {
                let denied = integrations
                    .dispatch_reviewed(
                        data.path(),
                        "owner",
                        workspace.path(),
                        "session",
                        "web_search",
                        &input,
                        false,
                        Some(&review),
                    )
                    .await;
                assert!(denied.err().unwrap().contains("approval"));
                let changed = serde_json::json!({"query":"changed query","limit":2});
                let stale = integrations
                    .dispatch_reviewed(
                        data.path(),
                        "owner",
                        workspace.path(),
                        "session",
                        "web_search",
                        &changed,
                        true,
                        Some(&review),
                    )
                    .await;
                assert!(stale.err().unwrap().contains("changed"));
                let foreign = integrations
                    .dispatch_reviewed(
                        data.path(),
                        "other",
                        workspace.path(),
                        "session",
                        "web_search",
                        &input,
                        true,
                        Some(&review),
                    )
                    .await;
                assert!(foreign.is_err());
                let db = Connection::open(data.path().join("terminal.db")).unwrap();
                let rotated = crate::vault::VaultCipher::load(data.path())
                    .unwrap()
                    .encrypt("rotated-fixture-token")
                    .unwrap();
                db.execute(
                    "UPDATE api_key_vault SET key_value=?1 WHERE user_id=?2 AND key_name=?3",
                    params![rotated, "owner", VAULT_NAME],
                )
                .unwrap();
                let stale = integrations
                    .dispatch_reviewed(
                        data.path(),
                        "owner",
                        workspace.path(),
                        "session",
                        "web_search",
                        &input,
                        true,
                        Some(&review),
                    )
                    .await;
                assert!(stale.err().unwrap().contains("changed"));
            })
            .await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        server.abort();
    }

    #[test]
    fn result_urls_reject_embedded_credentials_and_non_http_schemes() {
        for value in [
            "file:///tmp/private",
            "javascript:alert(1)",
            "https://name:pass@example.test/",
            "https://example.test/?%74oken=secret",
            "https://example.test/?API_KEY=value",
        ] {
            assert!(sanitized_url(value).is_none(), "{value}");
        }
        assert_eq!(
            sanitized_url("https://example.test/page?q=weather").unwrap(),
            "https://example.test/page?q=weather"
        );
    }

    #[test]
    fn search_results_redact_percent_encoded_and_double_encoded_keys() {
        let secret = "synthetic-fixture-token";
        let encoded: String = secret.bytes().map(|byte| format!("%{byte:02X}")).collect();
        let double_encoded = encoded.replace('%', "%25");
        let variants = credential_variants(secret);
        assert_eq!(
            scrub(&format!("fixture {encoded}"), &variants, 2000),
            "[redacted]"
        );
        assert_eq!(
            scrub(&format!("fixture {double_encoded}"), &variants, 2000),
            "[redacted]"
        );
        assert!(contains_credential(
            &format!("https://example.test/{encoded}"),
            &variants
        ));
        assert!(contains_credential(
            &format!("https://example.test/{double_encoded}"),
            &variants
        ));
    }

    #[test]
    fn search_input_is_bounded_and_rejects_unknown_fields() {
        assert_eq!(
            validate(&serde_json::json!({"query":" synthetic query ", "limit":3})).unwrap(),
            (" synthetic query ".into(), 3)
        );
        for input in [
            serde_json::json!({}),
            serde_json::json!({"query":" "}),
            serde_json::json!({"query":"x\ny"}),
            serde_json::json!({"query":"x", "limit":0}),
            serde_json::json!({"query":"x", "limit":11}),
            serde_json::json!({"query":"x", "secret":"value"}),
        ] {
            assert!(validate(&input).is_err(), "{input}");
        }
    }

    #[test]
    fn dns_pin_rejects_mixed_or_private_answers() {
        use std::net::SocketAddr;
        let addr = |ip: &str| -> SocketAddr { format!("{ip}:443").parse().unwrap() };
        assert_eq!(
            public_addresses(vec![addr("8.8.8.8"), addr("1.1.1.1")]).unwrap(),
            vec![addr("8.8.8.8"), addr("1.1.1.1")]
        );
        for ip in [
            "0.0.0.0",
            "10.0.0.2",
            "100.100.100.200",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(
                public_addresses(vec![addr("8.8.8.8"), addr(ip)]).is_err(),
                "{ip}"
            );
        }
        assert!(public_addresses(vec![]).is_err());
        assert!(public_addresses(vec!["[::1]:443".parse().unwrap()]).is_err());
        assert!(public_addresses(vec!["[::ffff:127.0.0.1]:443".parse().unwrap()]).is_err());
    }

    #[tokio::test]
    async fn pinned_search_avoids_proxy_and_redacts_credential_echo() {
        use axum::{extract::State, routing::post, Json};
        use base64::Engine;
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let app = axum::Router::new().route("/search", post(move |State(seen): State<Arc<AtomicUsize>>, headers: axum::http::HeaderMap, Json(body): Json<serde_json::Value>| async move {
            seen.fetch_add(1, Ordering::SeqCst);
            assert_eq!(headers["authorization"], "Bearer synthetic-fixture-token");
            assert_eq!(body["query"], "synthetic query");
            Json(serde_json::json!({"results":[{"title":"safe title", "url":"https://example.test/page", "content":format!("echo synthetic-fixture-token {}", base64::engine::general_purpose::STANDARD.encode("synthetic-fixture-token"))}]}))
        })).with_state(seen);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dead_proxy = reqwest::Proxy::all("http://127.0.0.1:9").unwrap();
        let client = client_policy(
            reqwest::Client::builder().proxy(dead_proxy),
            "fixture.invalid",
            &[address],
        )
        .build()
        .unwrap();
        let result = query_with_client(
            &client,
            &format!("http://fixture.invalid:{}/search", address.port()),
            "synthetic-fixture-token",
            "synthetic query",
            5,
        )
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(result["results"][0]["url"], "https://example.test/page");
        assert!(!result.to_string().contains("synthetic-fixture-token"));
        assert!(!result.to_string().contains(
            &base64::engine::general_purpose::STANDARD.encode("synthetic-fixture-token")
        ));
        server.abort();
    }

    #[tokio::test]
    async fn pinned_search_rejects_redirects_and_oversized_responses() {
        use axum::{
            extract::State,
            http::{header, StatusCode},
            routing::{get, post},
        };
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let followed = Arc::new(AtomicUsize::new(0));
        let app = axum::Router::new()
            .route(
                "/redirect",
                post(|| async { (StatusCode::FOUND, [(header::LOCATION, "/follow")], "") }),
            )
            .route("/large", post(|| async { axum::Json(serde_json::json!({"results":[{"title":"fixture","url":"https://example.test/","content":"x".repeat(262_145)}]})) }))
            .route(
                "/follow",
                get(|State(counter): State<Arc<AtomicUsize>>| async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    "redirect was followed"
                }),
            )
            .with_state(followed.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = client_policy(reqwest::Client::builder(), "fixture.invalid", &[address])
            .build()
            .unwrap();
        let root = format!("http://fixture.invalid:{}", address.port());
        assert!(query_with_client(
            &client,
            &format!("{root}/redirect"),
            "synthetic-fixture-token",
            "query",
            5
        )
        .await
        .is_err());
        assert_eq!(followed.load(Ordering::SeqCst), 0);
        assert!(query_with_client(
            &client,
            &format!("{root}/large"),
            "synthetic-fixture-token",
            "query",
            5
        )
        .await
        .is_err());
        server.abort();
    }
}
