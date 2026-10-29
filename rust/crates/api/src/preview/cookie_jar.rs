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
    #[serde(skip)]
    expires_at: Option<i64>,
    #[serde(skip)]
    origin_host: String,
}

impl StoredCookie {
    fn is_expired(&self) -> bool {
        self.expires_at
            .is_some_and(|expiry| expiry <= time::OffsetDateTime::now_utc().unix_timestamp())
    }
}

fn parse_cookie_date(value: &str) -> Option<i64> {
    let fields: Vec<_> = value
        .split(|ch: char| ch.is_ascii_whitespace() || ch == ',' || ch == '-')
        .filter(|part| !part.is_empty())
        .collect();
    let month = fields.iter().find_map(|field| {
        [
            "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
        ]
        .iter()
        .position(|month| month.eq_ignore_ascii_case(field))
    })? + 1;
    let numbers: Vec<_> = fields
        .iter()
        .filter(|field| field.len() <= 4 && field.bytes().all(|byte| byte.is_ascii_digit()))
        .collect();
    let (day, year) = match numbers.as_slice() {
        [day, year, ..] => (day.parse().ok()?, year.parse::<i32>().ok()?),
        _ => return None,
    };
    let year = match year {
        0..=69 => year + 2000,
        70..=99 => year + 1900,
        _ => year,
    };
    if year < 1601 {
        return None;
    }
    let clock: Vec<_> = fields
        .iter()
        .find(|part| part.contains(':'))?
        .split(':')
        .collect();
    if clock.len() != 3 {
        return None;
    }
    Some(
        time::Date::from_calendar_date(year, time::Month::try_from(month as u8).ok()?, day)
            .ok()?
            .with_hms(
                clock[0].parse().ok()?,
                clock[1].parse().ok()?,
                clock[2].parse().ok()?,
            )
            .ok()?
            .assume_utc()
            .unix_timestamp(),
    )
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

    pub async fn store_from_set_cookie(&self, user_id: &str, port: u16, header: &str) {
        self.store_from_set_cookie_for_request(user_id, port, "localhost", "/", header)
            .await;
    }

    pub async fn store_from_set_cookie_for_request(
        &self,
        user_id: &str,
        port: u16,
        host: &str,
        request_path: &str,
        header: &str,
    ) {
        let mut cookie = parse_set_cookie(header);
        if validate_cookie_entry(&cookie.name, &cookie.value).is_err() {
            return;
        }
        cookie.origin_host = host.to_ascii_lowercase();
        if let Some(domain) = &mut cookie.domain {
            *domain = domain.trim_start_matches('.').to_ascii_lowercase();
            if domain.is_empty() || !domain_matches(&cookie.origin_host, domain) {
                return;
            }
        }
        if !cookie
            .path
            .as_deref()
            .is_some_and(|path| path.starts_with('/'))
        {
            let path = request_path.split(['?', '#']).next().unwrap_or("/");
            let last_slash = path.rfind('/').unwrap_or(0);
            cookie.path = Some(if !path.starts_with('/') || last_slash == 0 {
                "/".into()
            } else {
                path[..last_slash].into()
            });
        }
        let mut jars = self.jars.lock().await;
        let jar = jars.entry(Self::jar_key(user_id, port)).or_default();
        let index = jar.iter().position(|current| {
            current.name == cookie.name
                && current.path == cookie.path
                && cookie_domain(current) == cookie_domain(&cookie)
        });
        if cookie.is_expired() {
            if let Some(index) = index {
                jar.remove(index);
            }
        } else if let Some(index) = index {
            jar[index] = cookie;
        } else {
            jar.push(cookie);
        }
    }

    pub async fn set_cookie(&self, user_id: &str, port: u16, name: &str, value: &str) {
        if validate_cookie_entry(name, value).is_ok() {
            self.store_from_set_cookie_for_request(
                user_id,
                port,
                "localhost",
                "/",
                &format!("{name}={value}; Path=/"),
            )
            .await;
        }
    }

    pub async fn remove_cookie(&self, user_id: &str, port: u16, name: &str) {
        let mut jars = self.jars.lock().await;
        if let Some(jar) = jars.get_mut(&Self::jar_key(user_id, port)) {
            jar.retain(|cookie| {
                !(cookie.name == name
                    && cookie_domain(cookie) == "localhost"
                    && cookie.path.as_deref() == Some("/"))
            });
        }
    }

    pub async fn get_cookie_header(&self, user_id: &str, port: u16) -> Option<String> {
        self.get_cookie_header_for_request(user_id, port, "localhost", "/")
            .await
    }

    pub async fn get_cookie_header_for_request(
        &self,
        user_id: &str,
        port: u16,
        host: &str,
        request_path: &str,
    ) -> Option<String> {
        let mut jars = self.jars.lock().await;
        let jar = jars.get_mut(&Self::jar_key(user_id, port))?;
        jar.retain(|cookie| !cookie.is_expired());
        let host = host.to_ascii_lowercase();
        let path = request_path
            .split(['?', '#'])
            .next()
            .filter(|path| path.starts_with('/'))
            .unwrap_or("/");
        let mut matching: Vec<_> = jar
            .iter()
            .filter(|cookie| {
                let host_matches = cookie
                    .domain
                    .as_deref()
                    .map_or(cookie.origin_host == host, |domain| {
                        domain_matches(&host, domain)
                    });
                let scope = cookie.path.as_deref().unwrap_or("/");
                host_matches
                    && (path == scope
                        || (path.starts_with(scope)
                            && (scope.ends_with('/')
                                || path.as_bytes().get(scope.len()) == Some(&b'/'))))
            })
            .collect();
        matching
            .sort_by_key(|cookie| std::cmp::Reverse(cookie.path.as_deref().unwrap_or("/").len()));
        (!matching.is_empty()).then(|| {
            matching
                .iter()
                .map(|cookie| format!("{}={}", cookie.name, cookie.value))
                .collect::<Vec<_>>()
                .join("; ")
        })
    }

    /// List all cookies for a port.
    pub async fn list_cookies(&self, user_id: &str, port: u16) -> Vec<StoredCookie> {
        let key = Self::jar_key(user_id, port);
        let mut jars = self.jars.lock().await;
        let jar = jars.entry(key).or_default();
        jar.retain(|cookie| !cookie.is_expired());
        jar.clone()
    }

    /// Clear all cookies for a port.
    pub async fn clear_cookies(&self, user_id: &str, port: u16) {
        let key = Self::jar_key(user_id, port);
        let mut jars = self.jars.lock().await;
        jars.remove(&key);
    }
}

fn cookie_domain(cookie: &StoredCookie) -> &str {
    cookie.domain.as_deref().unwrap_or(&cookie.origin_host)
}

fn domain_matches(host: &str, domain: &str) -> bool {
    host == domain
        || (host.parse::<std::net::IpAddr>().is_err()
            && host
                .strip_suffix(domain)
                .is_some_and(|prefix| prefix.ends_with('.')))
}

pub fn validate_cookie_entry(name: &str, value: &str) -> Result<(), String> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
    {
        return Err("Invalid cookie name".into());
    }
    if value
        .chars()
        .any(|value| value.is_control() || value == ';')
    {
        return Err("Invalid cookie value".into());
    }
    Ok(())
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
    let mut expires_at = None;
    let mut max_age = None;

    for attr in parts {
        let attr = attr.trim();
        let lower = attr.to_lowercase();
        if let Some(d) = lower.strip_prefix("domain=") {
            domain = Some(d.trim().to_string());
        } else if lower.starts_with("path=") {
            path = Some(attr[5..].trim().to_string());
        } else if let Some(value) = lower.strip_prefix("max-age=") {
            max_age = value.trim().parse::<i64>().ok();
        } else if lower.starts_with("expires=") {
            expires_at = parse_cookie_date(attr[8..].trim());
        }
    }

    StoredCookie {
        name,
        value,
        domain,
        path,
        origin_host: "localhost".into(),
        expires_at: max_age
            .map(|age| {
                time::OffsetDateTime::now_utc()
                    .unix_timestamp()
                    .saturating_add(age.max(0))
            })
            .or(expires_at),
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

#[cfg(test)]
mod expiry_regressions {
    use super::*;
    #[test]
    fn accepts_legacy_http_dates_and_rejects_impossible_dates() {
        assert_eq!(parse_cookie_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(
            parse_cookie_date("Thursday, 01-Jan-70 00:00:00 GMT"),
            Some(0)
        );
        assert_eq!(parse_cookie_date("Thu Jan  1 00:00:00 1970"), Some(0));
        assert_eq!(parse_cookie_date("Thu, 32 Jan 1970 00:00:00 GMT"), None);
    }

    #[tokio::test]
    async fn elapsed_cookies_are_pruned_on_header_and_listing() {
        let store = CookieStore::new();
        store
            .store_from_set_cookie("a", 5173, "session=value; Max-Age=3600")
            .await;
        store.jars.lock().await.get_mut("a:5173").unwrap()[0].expires_at = Some(0);
        assert_eq!(store.get_cookie_header("a", 5173).await, None);
        assert!(store.list_cookies("a", 5173).await.is_empty());
    }

    #[tokio::test]
    async fn deletion_expiry_and_max_age_precedence() {
        let store = CookieStore::new();
        for header in [
            "session=old",
            "session=deleted; Max-Age=0; Expires=Thu, 01 Jan 2099 00:00:00 GMT",
        ] {
            store.store_from_set_cookie("a", 5173, header).await;
        }
        assert_eq!(store.get_cookie_header("a", 5173).await, None);
        store
            .store_from_set_cookie(
                "a",
                5173,
                "session=expired; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
            )
            .await;
        assert_eq!(store.get_cookie_header("a", 5173).await, None);
        store
            .store_from_set_cookie(
                "a",
                5173,
                "session=live; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
            )
            .await;
        assert_eq!(
            store.get_cookie_header("a", 5173).await.as_deref(),
            Some("session=live")
        );
        assert_eq!(store.get_cookie_header("b", 5173).await, None);
    }
}

#[cfg(test)]
mod scope_regressions {
    use super::*;
    #[tokio::test]
    async fn same_name_paths_coexist_and_delete_only_exact_identity() {
        let jar = CookieStore::new();
        for header in [
            "session=root; Path=/",
            "session=admin; Path=/admin",
            "admin=restricted; Path=/admin",
        ] {
            jar.store_from_set_cookie("own", 5173, header).await;
        }
        assert_eq!(jar.list_cookies("own", 5173).await.len(), 3);
        jar.store_from_set_cookie("own", 5173, "session=gone; Path=/admin; Max-Age=0")
            .await;
        let values: Vec<_> = jar
            .list_cookies("own", 5173)
            .await
            .into_iter()
            .map(|c| (c.name, c.value))
            .collect();
        assert_eq!(
            values,
            vec![
                ("session".into(), "root".into()),
                ("admin".into(), "restricted".into())
            ]
        );
    }
}

#[cfg(test)]
mod request_scope_tests {
    use super::*;
    #[tokio::test]
    async fn request_path_default_boundary_domain_and_owner_are_respected() {
        let jar = CookieStore::new();
        for header in [
            "session=root; Path=/",
            "session=admin; Path=/admin",
            "default=scope",
            "bad=ignored; Domain=other.test; Path=/",
            "domain=scope; Domain=.example.test; Path=/",
        ] {
            jar.store_from_set_cookie_for_request(
                "own",
                5173,
                "app.example.test",
                "/admin/login?x=1",
                header,
            )
            .await;
        }
        for (host, path, expected) in [
            (
                "app.example.test",
                "/public",
                Some("session=root; domain=scope"),
            ),
            (
                "app.example.test",
                "/administrator",
                Some("session=root; domain=scope"),
            ),
            (
                "app.example.test",
                "/admin?query",
                Some("session=admin; default=scope; session=root; domain=scope"),
            ),
            ("sub.example.test", "/admin/child", Some("domain=scope")),
            ("evil-example.test", "/admin", None),
        ] {
            assert_eq!(
                jar.get_cookie_header_for_request("own", 5173, host, path)
                    .await
                    .as_deref(),
                expected,
                "{host}{path}"
            );
        }
        assert_eq!(
            jar.get_cookie_header_for_request("other", 5173, "app.example.test", "/admin")
                .await,
            None
        );
        assert_eq!(
            jar.get_cookie_header_for_request("own", 5174, "app.example.test", "/admin")
                .await,
            None
        );
        jar.store_from_set_cookie_for_request(
            "own",
            5173,
            "app.example.test",
            "/admin/login",
            "session=gone; Path=/admin; Max-Age=0",
        )
        .await;
        assert_eq!(
            jar.get_cookie_header_for_request("own", 5173, "app.example.test", "/admin")
                .await
                .as_deref(),
            Some("default=scope; session=root; domain=scope")
        );
    }
}

#[cfg(test)]
mod identity_regressions {
    use super::*;
    #[tokio::test]
    async fn domain_identity_is_normalized_and_manual_edits_target_root_only() {
        let jar = CookieStore::new();
        for header in [
            "session=host; Path=/",
            "session=domain; Domain=.localhost; Path=/",
            "session=admin; Path=/admin",
        ] {
            jar.store_from_set_cookie("owner", 5173, header).await;
        }
        assert_eq!(jar.list_cookies("owner", 5173).await.len(), 2);
        jar.set_cookie("owner", 5173, "session", "edited").await;
        assert_eq!(
            jar.get_cookie_header_for_request("owner", 5173, "localhost", "/admin")
                .await
                .as_deref(),
            Some("session=admin; session=edited")
        );
        jar.remove_cookie("owner", 5173, "session").await;
        assert_eq!(
            jar.get_cookie_header_for_request("owner", 5173, "localhost", "/admin")
                .await
                .as_deref(),
            Some("session=admin")
        );
        assert_eq!(jar.get_cookie_header("owner", 5173).await, None);
    }
}
