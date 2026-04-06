use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Per-(user, port) cookie jar matching the Node implementation's 3 policies.
#[derive(Clone)]
pub struct CookieStore {
    jars: Arc<Mutex<HashMap<String, Vec<StoredCookie>>>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCookie {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub path: Option<String>,
}

impl CookieStore {
    pub fn new() -> Self {
        Self {
            jars: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn jar_key(user_id: &str, port: u16) -> String {
        format!("{user_id}:{port}")
    }

    /// Store cookies extracted from a Set-Cookie header.
    pub async fn store_from_set_cookie(&self, user_id: &str, port: u16, header: &str) {
        let cookie = parse_set_cookie(header);
        let key = Self::jar_key(user_id, port);
        let mut jars = self.jars.lock().await;
        let jar = jars.entry(key).or_default();

        // Replace existing cookie with same name
        jar.retain(|c| c.name != cookie.name);
        jar.push(cookie);
    }

    /// Get all cookies for a port as a Cookie header value.
    pub async fn get_cookie_header(&self, user_id: &str, port: u16) -> Option<String> {
        let key = Self::jar_key(user_id, port);
        let jars = self.jars.lock().await;
        let jar = jars.get(&key)?;
        if jar.is_empty() {
            return None;
        }
        let pairs: Vec<String> = jar.iter().map(|c| format!("{}={}", c.name, c.value)).collect();
        Some(pairs.join("; "))
    }

    /// List all cookies for a port.
    pub async fn list_cookies(&self, user_id: &str, port: u16) -> Vec<StoredCookie> {
        let key = Self::jar_key(user_id, port);
        let jars = self.jars.lock().await;
        jars.get(&key).cloned().unwrap_or_default()
    }

    /// Clear all cookies for a port.
    pub async fn clear_cookies(&self, user_id: &str, port: u16) {
        let key = Self::jar_key(user_id, port);
        let mut jars = self.jars.lock().await;
        jars.remove(&key);
    }
}

/// Parse a Set-Cookie header into a StoredCookie.
fn parse_set_cookie(header: &str) -> StoredCookie {
    let mut parts = header.split(';');
    let name_value = parts.next().unwrap_or("");
    let (name, value) = if let Some(eq) = name_value.find('=') {
        (
            name_value[..eq].trim().to_string(),
            name_value[eq + 1..].trim().to_string(),
        )
    } else {
        (name_value.trim().to_string(), String::new())
    };

    let mut domain = None;
    let mut path = None;

    for attr in parts {
        let attr = attr.trim();
        let lower = attr.to_lowercase();
        if let Some(d) = lower.strip_prefix("domain=") {
            domain = Some(d.trim().to_string());
        } else if let Some(p) = lower.strip_prefix("path=") {
            path = Some(p.trim().to_string());
        }
    }

    StoredCookie {
        name,
        value,
        domain,
        path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_cookie() {
        let cookie = parse_set_cookie("session=abc123; Path=/; HttpOnly");
        assert_eq!(cookie.name, "session");
        assert_eq!(cookie.value, "abc123");
        assert_eq!(cookie.path.as_deref(), Some("/"));
    }

    #[test]
    fn parse_cookie_with_domain() {
        let cookie = parse_set_cookie("token=xyz; Domain=.example.com; Path=/api");
        assert_eq!(cookie.name, "token");
        assert_eq!(cookie.value, "xyz");
        assert_eq!(cookie.domain.as_deref(), Some(".example.com"));
        assert_eq!(cookie.path.as_deref(), Some("/api"));
    }

    #[tokio::test]
    async fn cookie_store_round_trip() {
        let store = CookieStore::new();
        store
            .store_from_set_cookie("user1", 3000, "session=abc; Path=/")
            .await;
        store
            .store_from_set_cookie("user1", 3000, "theme=dark")
            .await;

        let header = store.get_cookie_header("user1", 3000).await.unwrap();
        assert!(header.contains("session=abc"));
        assert!(header.contains("theme=dark"));

        let cookies = store.list_cookies("user1", 3000).await;
        assert_eq!(cookies.len(), 2);

        store.clear_cookies("user1", 3000).await;
        assert!(store.get_cookie_header("user1", 3000).await.is_none());
    }

    #[tokio::test]
    async fn cookie_store_replaces_same_name() {
        let store = CookieStore::new();
        store
            .store_from_set_cookie("user1", 3000, "session=old")
            .await;
        store
            .store_from_set_cookie("user1", 3000, "session=new")
            .await;

        let cookies = store.list_cookies("user1", 3000).await;
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].value, "new");
    }
}
