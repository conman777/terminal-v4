use regex_lite::{Captures, Regex};
use std::sync::LazyLock;
use url::Url;

static HTML_URLS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(\s(?:src|href|action|poster)\s*=\s*)(["'])([^"']+)(["'])"#).unwrap()
});
static HTML_UNQUOTED_URLS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(\s(?:src|href|action|poster)\s*=\s*)([^\s"'=<>`]+)"#).unwrap()
});
static HTML_SRCSETS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(\ssrcset\s*=\s*)(["'])([^"']+)(["'])"#).unwrap());
static INLINE_STYLES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(\sstyle\s*=\s*)(["])([^"]+)(["])"#).unwrap());
static INLINE_STYLES_SINGLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(\sstyle\s*=\s*)(['])([^']+)(['])"#).unwrap());
static CSS_URLS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(url\(\s*)(["']?)([^)"']+)(["']?\s*\))"#).unwrap());
static CSS_IMPORTS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(@import\s+)(["'])([^"']+)(["'])"#).unwrap());
static JS_IMPORTS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(\b(?:import|export)\s+[^'";]*?\sfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)(["'])"#).unwrap()
});
static STYLE_BLOCKS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)(<style[^>]*>)(.*?)(</style>)"#).unwrap());
static MODULE_BLOCKS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)(<script(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>)(.*?)(</script\s*>)"#).unwrap()
});

pub fn rewrite_static_content(
    content_type: &str,
    bytes: Vec<u8>,
    root: &str,
    file: &str,
    token: Option<(&str, &str)>,
) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return bytes;
    };
    let mut base = Url::parse("http://static-preview.invalid/").unwrap();
    base.path_segments_mut()
        .unwrap()
        .clear()
        .extend(file.split('/'));
    let (base, source) = if content_type.starts_with("text/html") {
        static_document_base(text, &base)
    } else {
        (base, text.to_owned())
    };
    let rewrite = |raw: &str, html: bool, module: bool| -> Option<String> {
        let decoded = html.then(|| raw.replace("&amp;", "&"));
        let raw = decoded.as_deref().unwrap_or(raw);
        if raw.starts_with('#')
            || raw.starts_with("/api/preview?")
            || (module && !raw.starts_with('.') && !raw.starts_with('/'))
        {
            return None;
        }
        let url = base.join(raw).ok()?;
        if url.host_str() != Some("static-preview.invalid")
            || !matches!(url.scheme(), "http" | "https")
        {
            return None;
        }
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        let encoded_file = format!(
            "file={}",
            url.path()
                .trim_start_matches('/')
                .replace('+', "%2B")
                .replace('&', "%26")
        );
        let (_, file) = url::form_urlencoded::parse(encoded_file.as_bytes()).next()?;
        query.append_pair("path", root).append_pair("file", &file);
        if let Some((name, value)) = token {
            query.append_pair(name, value);
        }
        let mut target = format!("/api/preview?{}", query.finish());
        if let Some(fragment) = url.fragment() {
            target.push('#');
            target.push_str(fragment);
        }
        Some(if html {
            target.replace('&', "&amp;")
        } else {
            target
        })
    };
    let rewritten = rewrite_urls(content_type, &source, rewrite);
    if super::script_inject::is_html_content_type(content_type) {
        inject_static_inspector(&rewritten).into_bytes()
    } else {
        rewritten.into_bytes()
    }
}

fn html_attribute<'a>(attributes: &'a str, wanted: &str) -> Option<&'a str> {
    html_attribute_with_range(attributes, wanted).map(|(value, _)| value)
}

fn html_attribute_with_range<'a>(
    attributes: &'a str,
    wanted: &str,
) -> Option<(&'a str, std::ops::Range<usize>)> {
    let bytes = attributes.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        while at < bytes.len() && (bytes[at].is_ascii_whitespace() || bytes[at] == b'/') {
            at += 1;
        }
        let start = at;
        while at < bytes.len()
            && !bytes[at].is_ascii_whitespace()
            && !matches!(bytes[at], b'=' | b'/' | b'>')
        {
            at += 1;
        }
        if at == start {
            at += 1;
            continue;
        }
        let name = &attributes[start..at];
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        let mut value = "";
        if bytes.get(at) == Some(&b'=') {
            at += 1;
            while at < bytes.len() && bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            let quote = bytes.get(at).copied().filter(|b| matches!(b, b'\'' | b'"'));
            if quote.is_some() {
                at += 1;
            }
            let start = at;
            while at < bytes.len()
                && !quote.map_or_else(|| bytes[at].is_ascii_whitespace(), |q| bytes[at] == q)
            {
                at += 1;
            }
            value = &attributes[start..at];
            if quote.is_some() && at < bytes.len() {
                at += 1;
            }
        }
        if name.eq_ignore_ascii_case(wanted) {
            return Some((value, start..at));
        }
    }
    None
}

// Scan tag boundaries with quoted attribute values, comments and raw text kept intact.
fn static_document_base(text: &str, document: &Url) -> (Url, String) {
    let mut base = None;
    let mut source = String::new();
    let mut cursor = 0;
    let mut copy_from = 0;
    let mut templates = 0usize;
    while let Some(relative) = text[cursor..].find('<') {
        let start = cursor + relative;
        if text[start..].starts_with("<!--") {
            cursor = text[start + 4..]
                .find("-->")
                .map(|end| start + 4 + end + 3)
                .unwrap_or(text.len());
            continue;
        }
        let bytes = text.as_bytes();
        let mut at = start + 1;
        let closing = bytes.get(at) == Some(&b'/');
        if closing {
            at += 1;
        }
        let name_start = at;
        while bytes
            .get(at)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b':' | b'_'))
        {
            at += 1;
        }
        let name = &text[name_start..at];
        if name.is_empty() {
            cursor = at;
            continue;
        }
        let mut quote = None;
        let mut end = at;
        while end < bytes.len() {
            match (quote, bytes[end]) {
                (Some(delimiter), byte) if delimiter == byte => quote = None,
                (None, byte @ (b'\'' | b'"')) => quote = Some(byte),
                (None, b'>') => break,
                _ => {}
            }
            end += 1;
        }
        if end == bytes.len() {
            break;
        }
        cursor = end + 1;
        if name.eq_ignore_ascii_case("template") {
            templates = if closing {
                templates.saturating_sub(1)
            } else {
                templates + 1
            };
        }
        if !closing && templates == 0 && name.eq_ignore_ascii_case("base") {
            let first_href = html_attribute(&text[at..end], "href");
            if base.is_none() {
                if let Some(href) = first_href {
                    if href.len() > 8192 {
                        return (document.clone(), text.to_owned());
                    }
                    base = Some(
                        document
                            .join(&href.replace("&amp;", "&"))
                            .unwrap_or_else(|_| document.clone()),
                    );
                }
            }
            let mut attributes_start = at;
            while let Some((_, range)) =
                html_attribute_with_range(&text[attributes_start..end], "href")
            {
                source.push_str(&text[copy_from..attributes_start + range.start]);
                copy_from = attributes_start + range.end;
                attributes_start = copy_from;
            }
        } else if !closing
            && ["script", "style", "textarea", "title"]
                .iter()
                .any(|raw| name.eq_ignore_ascii_case(raw))
        {
            // The raw-text section ends at the matching closing tag, regardless of quotes inside it.
            let close = format!("</{name}");
            if let Some(next) = text.as_bytes()[cursor..]
                .windows(close.len())
                .enumerate()
                .find_map(|(index, window)| {
                    let boundary = bytes.get(cursor + index + close.len()).is_some_and(|byte| {
                        byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/')
                    });
                    (boundary && window.eq_ignore_ascii_case(close.as_bytes())).then_some(index)
                })
            {
                cursor += next;
            } else {
                cursor = text.len();
            }
        }
    }
    source.push_str(&text[copy_from..]);
    let base = base.unwrap_or_else(|| document.clone());
    if base.host_str() == document.host_str() && matches!(base.scheme(), "http" | "https") {
        (base, source)
    } else {
        (base, text.to_owned())
    }
}

fn inject_static_inspector(html: &str) -> String {
    let payload = format!(
        "<script data-preview-inspector=\"true\">{}</script>",
        include_str!("inspector.js")
    );
    let index = html
        .to_ascii_lowercase()
        .find("</head>")
        .or_else(|| html.to_ascii_lowercase().find("</body>"))
        .unwrap_or(html.len());
    let mut result = html.to_owned();
    result.insert_str(index, &payload);
    result
}

pub(super) fn rewrite_urls(
    content_type: &str,
    text: &str,
    rewrite: impl Fn(&str, bool, bool) -> Option<String>,
) -> String {
    let replace = |input: &str, regex: &Regex, html: bool, module: bool| -> String {
        regex
            .replace_all(input, |captures: &Captures| {
                match rewrite(&captures[3], html, module) {
                    Some(url) => format!("{}{}{}{}", &captures[1], &captures[2], url, &captures[4]),
                    None => captures[0].to_string(),
                }
            })
            .into_owned()
    };
    let css = |input: &str| {
        replace(
            &replace(input, &CSS_URLS, false, false),
            &CSS_IMPORTS,
            false,
            false,
        )
    };
    let result = if content_type.starts_with("text/html") {
        let html = replace(text, &HTML_URLS, true, false);
        let html = HTML_UNQUOTED_URLS
            .replace_all(&html, |captures: &Captures| {
                rewrite(&captures[2], true, false)
                    .map(|url| format!("{}{}", &captures[1], url))
                    .unwrap_or_else(|| captures[0].to_string())
            })
            .into_owned();
        let html = HTML_SRCSETS
            .replace_all(&html, |captures: &Captures| {
                let input = &captures[3];
                let mut rest = input;
                let mut candidates = Vec::new();
                while !rest.is_empty() {
                    rest =
                        rest.trim_start_matches(|ch: char| ch.is_ascii_whitespace() || ch == ',');
                    if rest.is_empty() {
                        break;
                    }
                    let url_end = rest
                        .find(|ch: char| ch.is_ascii_whitespace())
                        .unwrap_or(rest.len());
                    let raw_url = &rest[..url_end];
                    rest = &rest[url_end..];
                    let trailing_comma = raw_url.ends_with(',');
                    let raw_url = raw_url.trim_end_matches(',');
                    let descriptor_end = if trailing_comma {
                        0
                    } else {
                        rest.find(',').unwrap_or(rest.len())
                    };
                    let descriptor = &rest[..descriptor_end];
                    rest = &rest[descriptor_end..];
                    candidates.push(format!(
                        "{}{}",
                        rewrite(raw_url, true, false).unwrap_or_else(|| raw_url.into()),
                        descriptor
                    ));
                }
                format!(
                    "{}{}{}{}",
                    &captures[1],
                    &captures[2],
                    candidates.join(", "),
                    &captures[4]
                )
            })
            .into_owned();
        let mut html = html;
        for pattern in [&*INLINE_STYLES, &*INLINE_STYLES_SINGLE] {
            html = pattern
                .replace_all(&html, |captures: &Captures| {
                    format!(
                        "{}{}{}{}",
                        &captures[1],
                        &captures[2],
                        css(&captures[3].replace("&amp;", "&")).replace('&', "&amp;"),
                        &captures[4]
                    )
                })
                .into_owned();
        }
        let html = STYLE_BLOCKS
            .replace_all(&html, |captures: &Captures| {
                format!("{}{}{}", &captures[1], css(&captures[2]), &captures[3])
            })
            .into_owned();
        MODULE_BLOCKS
            .replace_all(&html, |captures: &Captures| {
                if html_attribute(&captures[1][7..captures[1].len() - 1], "type")
                    .is_some_and(|kind| kind.eq_ignore_ascii_case("module"))
                {
                    format!(
                        "{}{}{}",
                        &captures[1],
                        replace(&captures[2], &JS_IMPORTS, false, true),
                        &captures[3]
                    )
                } else {
                    captures[0].to_owned()
                }
            })
            .into_owned()
    } else if content_type.starts_with("text/css") {
        css(text)
    } else if content_type.contains("javascript") {
        replace(text, &JS_IMPORTS, false, true)
    } else {
        return text.to_string();
    };
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_document_base_keeps_relative_assets_on_its_origin() {
        let html = "<base href='https://cdn.example.test/app/'><script src='main.js'></script>";
        let result = String::from_utf8(rewrite_static_content(
            "text/html",
            html.as_bytes().to_vec(),
            "/project",
            "index.html",
            Some(("token", "test-token")),
        ))
        .unwrap();
        assert!(result.contains(html));
        assert!(!result.contains("test-token"));
    }

    #[test]
    fn binary_content_is_preserved() {
        let bytes = vec![0, 255, 1];
        assert_eq!(
            rewrite_static_content("image/png", bytes.clone(), "/project", "logo.png", None),
            bytes
        );
    }
}

#[cfg(test)]
mod inspector_regressions {
    use super::*;
    #[test]
    fn static_html_includes_inspector_but_css_does_not() {
        let html = rewrite_static_content(
            "text/html",
            b"<html><head></head><body><button>Target</button></body></html>".to_vec(),
            "/fixture",
            "nested/page.html",
            None,
        );
        assert!(String::from_utf8(html)
            .unwrap()
            .contains("data-preview-inspector"));
        assert_eq!(
            rewrite_static_content(
                "text/css",
                b"body { color: red }".to_vec(),
                "/fixture",
                "main.css",
                None
            ),
            b"body { color: red }"
        );
    }
}

#[cfg(test)]
mod html_syntax_regressions {
    use super::*;
    #[test]
    fn quoted_and_unquoted_inline_modules_rewrite_relative_imports_only() {
        for attribute in [
            "type=module",
            "TYPE=module async",
            "data-extra=\"x\" type=module",
            "data-extra=\">\" type=module",
            "type='module'",
            "type=\"module\"",
        ] {
            let html = format!("<script {attribute}>import './marker.js'; import 'bare';</script>");
            let result = rewrite_urls("text/html", &html, |url, _, module| {
                (module && url.starts_with('.')).then(|| "/authenticated-marker.js".into())
            });
            assert!(
                result.contains("import '/authenticated-marker.js'; import 'bare';"),
                "{attribute}: {result}"
            );
        }
        for attribute in [
            "data-type=module",
            "type=modulex",
            "type=text/javascript",
            "type='text/plain' type=module",
        ] {
            let html = format!("<script {attribute}>import './marker.js';</script>");
            assert_eq!(
                rewrite_urls("text/html", &html, |_, _, _| Some("WRONG".into())),
                html
            );
        }
    }
    #[test]
    fn first_effective_quoted_or_unquoted_base_resolves_without_doubling() {
        for attribute in ["href=assets/", "href='assets/'", "href=\"assets/\""] {
            let html = format!("<!-- <base href=wrong/> --><script>const x='<base href=wrong/>';</script><template><base href=wrong/></template><base {attribute}><base href=wrong/><script src='marker.js'></script>");
            let result = String::from_utf8(rewrite_static_content(
                "text/html",
                html.into_bytes(),
                "/fixture",
                "nested/page.html",
                Some(("previewToken", "synthetic")),
            ))
            .unwrap();
            assert!(
                result.contains("file=nested%2Fassets%2Fmarker.js"),
                "{attribute}: {}",
                result.split("data-preview-inspector").next().unwrap()
            );
            assert!(!result.contains("file=nested%2Fassets%2Fassets%2F"));
        }
    }
}

#[cfg(test)]
mod base_target_regressions {
    use super::*;
    #[test]
    fn target_only_base_is_unchanged_and_href_base_keeps_other_attributes() {
        let document = Url::parse("http://static-preview.invalid/nested/page.html").unwrap();
        for html in [
            "<base target=_blank>",
            "<base target='named' data-test='keep > this'>",
            "<base target=first><base target=second>",
        ] {
            assert_eq!(
                static_document_base(html, &document),
                (document.clone(), html.into())
            );
        }
        let html="<base target='named' href=assets/ data-test='keep > this'><script src='main.js'></script>";
        let (base, source) = static_document_base(html, &document);
        assert_eq!(
            base.as_str(),
            "http://static-preview.invalid/nested/assets/"
        );
        assert_eq!(
            source,
            "<base target='named'  data-test='keep > this'><script src='main.js'></script>"
        );
    }
}
