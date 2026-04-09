use regex_lite::{Captures, Regex};
use std::sync::LazyLock;
use url::Url;

use super::script_inject;

static DOUBLE_QUOTED_ATTR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(\s(?:src|href|action|poster)\s*=\s*")([^"]+)(")"#)
        .expect("attribute regex should compile")
});
static SINGLE_QUOTED_ATTR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(\s(?:src|href|action|poster)\s*=\s*')([^']+)(')"#)
        .expect("attribute regex should compile")
});
static STYLE_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)<style([^>]*)>(.*?)</style>"#).expect("style regex"));
static INLINE_MODULE_SCRIPT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<script([^>]*\btype\s*=\s*["']module["'][^>]*)>(.*?)</script>"#)
        .expect("inline module script regex")
});
static CSS_URL_DOUBLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(url\(\s*")(/[^")]+)("?\s*\))"#).expect("css double quote regex")
});
static CSS_URL_SINGLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(url\(\s*')(/[^')]+)('?\s*\))"#).expect("css single quote regex")
});
static CSS_URL_BARE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(url\(\s*)(/[^)"'\s]+)(\s*\))"#).expect("css bare regex"));
static CSS_IMPORT_DOUBLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(@import\s+")(/[^"]+)(")"#).expect("css import regex"));
static CSS_IMPORT_SINGLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(@import\s+')(/[^']+)(')"#).expect("css import regex"));
static JS_IMPORT_FROM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\b(import|export)\s+[^'"]*?\sfrom\s+(["'])([^"']+)(["'])"#)
        .expect("js import-from regex")
});
static JS_IMPORT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\bimport\s+(["'])([^"']+)(["'])"#).expect("js import regex"));
static JS_DYNAMIC_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bimport\s*\(\s*(["'])([^"']+)(["'])\s*\)"#).expect("js dynamic import regex")
});

pub fn rewrite_html_for_path_preview(html: &str, port: u16, api_origin: &str) -> String {
    let preview_base = preview_base(port);
    let rewritten = rewrite_html_attribute_urls(html, &preview_base, port);
    let rewritten = STYLE_BLOCK_RE
        .replace_all(&rewritten, |captures: &Captures| {
            let rewritten_css = rewrite_css_for_path_preview(&captures[2], port);
            format!("<style{}>{}</style>", &captures[1], rewritten_css)
        })
        .to_string();
    let rewritten = INLINE_MODULE_SCRIPT_RE
        .replace_all(&rewritten, |captures: &Captures| {
            let attrs = &captures[1];
            if attrs.to_ascii_lowercase().contains("src=") {
                return captures[0].to_string();
            }

            let rewritten_script = rewrite_script_for_path_preview(&captures[2], port);
            format!("<script{}>{}</script>", attrs, rewritten_script)
        })
        .to_string();
    script_inject::inject_debug_script_with_options(
        &rewritten,
        port,
        api_origin,
        Some(&preview_base),
    )
}

pub fn rewrite_css_for_path_preview(css: &str, port: u16) -> String {
    let preview_base = preview_base(port);
    let rewritten = rewrite_with_regex(css, &CSS_URL_DOUBLE_RE, &preview_base, port);
    let rewritten = rewrite_with_regex(&rewritten, &CSS_URL_SINGLE_RE, &preview_base, port);
    let rewritten = rewrite_with_regex(&rewritten, &CSS_URL_BARE_RE, &preview_base, port);
    let rewritten = rewrite_with_regex(&rewritten, &CSS_IMPORT_DOUBLE_RE, &preview_base, port);
    rewrite_with_regex(&rewritten, &CSS_IMPORT_SINGLE_RE, &preview_base, port)
}

pub fn rewrite_script_for_path_preview(script: &str, port: u16) -> String {
    let preview_base = preview_base(port);
    let rewritten =
        rewrite_script_with_regex(script, &JS_IMPORT_FROM_RE, &preview_base, port, 2, 3, 4);
    let rewritten =
        rewrite_script_with_regex(&rewritten, &JS_IMPORT_RE, &preview_base, port, 1, 2, 3);
    rewrite_script_with_regex(
        &rewritten,
        &JS_DYNAMIC_IMPORT_RE,
        &preview_base,
        port,
        1,
        2,
        3,
    )
}

fn rewrite_html_attribute_urls(html: &str, preview_base: &str, port: u16) -> String {
    let rewritten = rewrite_with_regex(html, &DOUBLE_QUOTED_ATTR_RE, preview_base, port);
    rewrite_with_regex(&rewritten, &SINGLE_QUOTED_ATTR_RE, preview_base, port)
}

fn rewrite_with_regex(input: &str, regex: &Regex, preview_base: &str, port: u16) -> String {
    regex
        .replace_all(input, |captures: &Captures| {
            if let Some(rewritten) = rewrite_url_value(&captures[2], preview_base, port) {
                format!("{}{}{}", &captures[1], rewritten, &captures[3])
            } else {
                captures[0].to_string()
            }
        })
        .to_string()
}

fn rewrite_script_with_regex(
    input: &str,
    regex: &Regex,
    preview_base: &str,
    port: u16,
    open_quote_index: usize,
    specifier_index: usize,
    close_quote_index: usize,
) -> String {
    regex
        .replace_all(input, |captures: &Captures| {
            let open_quote = captures
                .get(open_quote_index)
                .map(|value| value.as_str())
                .unwrap_or_default();
            let close_quote = captures
                .get(close_quote_index)
                .map(|value| value.as_str())
                .unwrap_or_default();
            if open_quote != close_quote {
                return captures[0].to_string();
            }

            let specifier = captures
                .get(specifier_index)
                .map(|value| value.as_str())
                .unwrap_or_default();
            let Some(rewritten) = rewrite_url_value(specifier, preview_base, port) else {
                return captures[0].to_string();
            };

            captures[0].replacen(specifier, &rewritten, 1)
        })
        .to_string()
}

fn rewrite_url_value(raw: &str, preview_base: &str, port: u16) -> Option<String> {
    if should_skip_rewrite(raw, preview_base) {
        return None;
    }

    if let Ok(url) = Url::parse(raw) {
        if is_local_upstream(&url, port) {
            return Some(prefix_preview_base(
                &path_with_query_and_fragment(&url),
                preview_base,
            ));
        }
        return None;
    }

    if raw.starts_with('/') {
        return Some(prefix_preview_base(raw, preview_base));
    }

    None
}

fn should_skip_rewrite(raw: &str, preview_base: &str) -> bool {
    raw.is_empty()
        || raw.starts_with('#')
        || raw.starts_with("//")
        || raw.starts_with(preview_base)
        || raw.starts_with("/api/preview")
        || raw.starts_with("/api/dev-proxy")
        || raw.starts_with("javascript:")
        || raw.starts_with("mailto:")
        || raw.starts_with("tel:")
        || raw.starts_with("data:")
        || raw.starts_with("blob:")
        || raw.starts_with("ws://")
        || raw.starts_with("wss://")
}

fn is_local_upstream(url: &Url, port: u16) -> bool {
    let host = url.host_str().unwrap_or_default();
    let is_local_host = matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "::1");
    is_local_host && url.port_or_known_default() == Some(port)
}

fn prefix_preview_base(path: &str, preview_base: &str) -> String {
    if path == "/" {
        return format!("{preview_base}/");
    }

    if let Some(stripped) = path.strip_prefix('/') {
        format!("{preview_base}/{stripped}")
    } else {
        format!("{preview_base}/{path}")
    }
}

fn path_with_query_and_fragment(url: &Url) -> String {
    let mut value = url.path().to_string();
    if value.is_empty() {
        value.push('/');
    }
    if let Some(query) = url.query() {
        value.push('?');
        value.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        value.push('#');
        value.push_str(fragment);
    }
    value
}

fn preview_base(port: u16) -> String {
    format!("/preview/{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_html_root_relative_assets_and_injects_debug_script() {
        let html = r#"
            <html>
              <head>
                <link rel="stylesheet" href="/styles.css">
              </head>
              <body>
                <script src="/main.js"></script>
                <a href="/dashboard">Go</a>
              </body>
            </html>
        "#;

        let rewritten = rewrite_html_for_path_preview(html, 5173, "http://localhost:3020");

        assert!(rewritten.contains(r#"href="/preview/5173/styles.css""#));
        assert!(rewritten.contains(r#"src="/preview/5173/main.js""#));
        assert!(rewritten.contains(r#"href="/preview/5173/dashboard""#));
        assert!(rewritten.contains(r#"<base href="/preview/5173/">"#));
        assert!(rewritten.contains("data-preview-debug"));
    }

    #[test]
    fn rewrites_css_url_and_import_paths() {
        let css = r#"
            @import "/fonts.css";
            body { background: url("/assets/bg.png"); }
            .hero { mask-image: url('/assets/mask.svg'); }
        "#;

        let rewritten = rewrite_css_for_path_preview(css, 5173);

        assert!(rewritten.contains(r#"@import "/preview/5173/fonts.css""#));
        assert!(rewritten.contains(r#"url("/preview/5173/assets/bg.png")"#));
        assert!(rewritten.contains(r#"url('/preview/5173/assets/mask.svg')"#));
    }

    #[test]
    fn rewrites_local_absolute_urls_but_leaves_external_urls_unchanged() {
        let html =
            r#"<img src="http://localhost:5173/logo.png"><img src="https://example.com/logo.png">"#;
        let rewritten = rewrite_html_for_path_preview(html, 5173, "http://localhost:3020");

        assert!(rewritten.contains(r#"src="/preview/5173/logo.png""#));
        assert!(rewritten.contains(r#"src="https://example.com/logo.png""#));
    }

    #[test]
    fn preserves_data_and_blob_urls() {
        let html = r#"<img src="data:image/png;base64,abc"><img src="blob:http://localhost/uuid">"#;
        let rewritten = rewrite_html_for_path_preview(html, 5173, "http://localhost:3020");

        assert!(rewritten.contains(r#"src="data:image/png;base64,abc""#));
        assert!(rewritten.contains(r#"src="blob:http://localhost/uuid""#));
    }

    #[test]
    fn rewrites_root_relative_paths() {
        let html = r#"<img src="/assets/logo.png">"#;
        let rewritten = rewrite_html_for_path_preview(html, 8080, "http://localhost:3020");

        assert!(rewritten.contains(r#"src="/preview/8080/assets/logo.png""#));
    }

    #[test]
    fn preserves_already_rewritten_paths() {
        let html = r#"<link href="/preview/5173/styles.css">"#;
        let rewritten = rewrite_html_for_path_preview(html, 5173, "http://localhost:3020");

        // Should not double-prefix
        assert!(!rewritten.contains("/preview/5173/preview/5173/"));
    }

    #[test]
    fn rewrites_inline_module_script_imports_for_vite_preamble() {
        let html = r#"
            <script type="module">
              import RefreshRuntime from "/@react-refresh";
              import "/src/main.jsx";
              import("/src/bootstrap.jsx");
            </script>
        "#;

        let rewritten = rewrite_html_for_path_preview(html, 5173, "http://localhost:3020");

        assert!(rewritten.contains(r#"from "/preview/5173/@react-refresh""#));
        assert!(rewritten.contains(r#"import "/preview/5173/src/main.jsx""#));
        assert!(rewritten.contains(r#"import("/preview/5173/src/bootstrap.jsx")"#));
    }

    #[test]
    fn preview_base_format() {
        assert_eq!(preview_base(3000), "/preview/3000");
        assert_eq!(preview_base(8080), "/preview/8080");
    }
}
