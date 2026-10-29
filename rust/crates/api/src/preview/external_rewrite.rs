use regex_lite::{Captures, Regex};
use std::sync::LazyLock;

pub(super) const MAX_OUTPUT: usize = 10 * 1024 * 1024;
const MAX_WORK: usize = 128 * 1024 * 1024;
const MAX_REFERENCES: usize = 8192;

static ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(\s(?:src|href|action|poster)\s*=\s*)(["'])([^"']+)(["'])"#).unwrap()
});
static UNQUOTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(\s(?:src|href|action|poster)\s*=\s*)([^\s"'=<>`]+)"#).unwrap()
});
static SRCSET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(\ssrcset\s*=\s*)(["'])([^"']+)(["'])"#).unwrap());
static STYLE_ATTR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(\sstyle\s*=\s*)(["])([^"]*)(["])"#).unwrap());
static STYLE_ATTR_SINGLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(\sstyle\s*=\s*)(['])([^']*)(['])"#).unwrap());
static CSS_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(url\(\s*)(["']?)([^)"']+)(["']?\s*\))"#).unwrap());
static CSS_IMPORT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(@import\s+)(["'])([^"']+)(["'])"#).unwrap());
static JS_IMPORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(\b(?:import|export)\s+[^'";]*?\sfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)(["'])"#).unwrap()
});
static STYLE_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)(<style\b[^>]*>)(.*?)(</style>)"#).unwrap());
static MODULE_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)(<script\b[^>]*\btype\s*=\s*(?:["']module["']|module)(?:\s[^>]*)?>)(.*?)(</script>)"#).unwrap()
});

pub(super) fn append(output: &mut String, value: &str) -> Result<(), String> {
    let required = output.len().saturating_add(value.len());
    if required > MAX_OUTPUT {
        return Err("Rewritten external response exceeds 10MB limit".into());
    }
    if required > output.capacity() {
        let capacity = required
            .max(output.capacity().saturating_mul(2))
            .min(MAX_OUTPUT);
        output
            .try_reserve_exact(capacity - output.len())
            .map_err(|_| "External rewrite allocation failed")?;
    }
    output.push_str(value);
    Ok(())
}

pub(super) fn escape(value: &str) -> Result<String, String> {
    let length = value
        .bytes()
        .map(|byte| match byte {
            b'&' => 5,
            b'"' => 6,
            b'\'' => 5,
            b'<' => 4,
            _ => 1,
        })
        .sum::<usize>();
    if length > MAX_OUTPUT {
        return Err("Rewritten external response exceeds 10MB limit".into());
    }
    let mut output = String::new();
    output
        .try_reserve_exact(length)
        .map_err(|_| "External rewrite allocation failed")?;
    for part in value.split_inclusive(['&', '"', '\'', '<']) {
        let (text, replacement) = match part.as_bytes().last() {
            Some(b'&') => (&part[..part.len() - 1], "&amp;"),
            Some(b'"') => (&part[..part.len() - 1], "&quot;"),
            Some(b'\'') => (&part[..part.len() - 1], "&#39;"),
            Some(b'<') => (&part[..part.len() - 1], "&lt;"),
            _ => (part, ""),
        };
        append(&mut output, text)?;
        append(&mut output, replacement)?;
    }
    Ok(output)
}

fn decode_style_attribute(value: &str) -> Result<String, String> {
    if value.len() > MAX_OUTPUT {
        return Err("External style attribute exceeds 10MB limit".into());
    }
    let mut output = String::new();
    let mut cursor = 0;
    while let Some(relative) = value[cursor..].find('&') {
        let start = cursor + relative;
        append(&mut output, &value[cursor..start])?;
        let tail = &value[start + 1..];
        let end = tail.bytes().take(32).position(|byte| byte == b';');
        let decoded = end.and_then(|end| match &tail[..end] {
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "lt" => Some('<'),
            "gt" => Some('>'),
            entity => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|digits| u32::from_str_radix(digits, 16).ok())
                .or_else(|| {
                    entity
                        .strip_prefix('#')
                        .and_then(|digits| digits.parse::<u32>().ok())
                })
                .and_then(char::from_u32),
        });
        if let Some(character) = decoded {
            let mut bytes = [0; 4];
            append(&mut output, character.encode_utf8(&mut bytes))?;
            cursor = start + end.unwrap() + 2;
        } else {
            append(&mut output, "&")?;
            cursor = start + 1;
        }
    }
    append(&mut output, &value[cursor..])?;
    Ok(output)
}

// Scan tag boundaries with quoted attribute values, comments and raw text kept intact.
pub(super) fn document_base(text: &str, document: &url::Url) -> Result<(url::Url, String), String> {
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
            let mut first_href = None;
            while at < end {
                while at < end && (bytes[at].is_ascii_whitespace() || bytes[at] == b'/') {
                    at += 1;
                }
                let attribute_start = at;
                while at < end
                    && !bytes[at].is_ascii_whitespace()
                    && !matches!(bytes[at], b'=' | b'/' | b'>')
                {
                    at += 1;
                }
                if at == attribute_start {
                    at += 1;
                    continue;
                }
                let attribute = &text[attribute_start..at];
                while at < end && bytes[at].is_ascii_whitespace() {
                    at += 1;
                }
                let value = if at < end && bytes[at] == b'=' {
                    at += 1;
                    while at < end && bytes[at].is_ascii_whitespace() {
                        at += 1;
                    }
                    let delimiter = bytes
                        .get(at)
                        .copied()
                        .filter(|byte| matches!(byte, b'\'' | b'"'));
                    if delimiter.is_some() {
                        at += 1;
                    }
                    let value_start = at;
                    while at < end
                        && !delimiter.map_or_else(
                            || bytes[at].is_ascii_whitespace(),
                            |delimiter| bytes[at] == delimiter,
                        )
                    {
                        at += 1;
                    }
                    let value = &text[value_start..at];
                    if delimiter.is_some() && at < end {
                        at += 1;
                    }
                    value
                } else {
                    ""
                };
                if attribute.eq_ignore_ascii_case("href") && first_href.is_none() {
                    first_href = Some(value);
                }
            }
            if base.is_none() {
                if let Some(href) = first_href {
                    if href.len() > 8192 {
                        return Err("External preview base URL exceeds 8192-byte limit".into());
                    }
                    base = Some(
                        document
                            .join(&href.replace("&amp;", "&"))
                            .unwrap_or_else(|_| document.clone()),
                    );
                }
            }
            append(&mut source, &text[copy_from..start])?;
            copy_from = cursor;
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
    append(&mut source, &text[copy_from..])?;
    let base = base.unwrap_or_else(|| document.clone());
    if base.as_str().len() > 8192 {
        return Err("External preview base URL exceeds 8192-byte limit".into());
    }
    Ok((base, source))
}

#[derive(Clone, Copy)]
enum Kind {
    Url(bool, bool),
    Unquoted,
    Srcset,
    StyleAttribute,
    StyleBlock,
    ModuleBlock,
}

struct Transformer<F> {
    rewrite: F,
    work: usize,
    references: usize,
}

impl<F: FnMut(&str, bool, bool) -> Result<Option<String>, String>> Transformer<F> {
    fn url(&mut self, raw: &str, html: bool, module: bool) -> Result<Option<String>, String> {
        self.references += 1;
        if self.references > MAX_REFERENCES {
            return Err("External preview exceeds 8192-reference work limit".into());
        }
        if raw.len() > 8192 {
            return Err("External preview URL exceeds 8192-byte limit".into());
        }
        (self.rewrite)(raw, html, module)
    }

    fn replace(&mut self, input: &str, pattern: &Regex, kind: Kind) -> Result<String, String> {
        self.work = self.work.saturating_add(input.len());
        if self.work > MAX_WORK {
            return Err("External preview exceeds 128MB rewrite work limit".into());
        }
        let mut output = String::new();
        let mut cursor = 0;
        for captures in pattern.captures_iter(input) {
            let matched = captures.get(0).unwrap();
            append(&mut output, &input[cursor..matched.start()])?;
            match kind {
                Kind::Url(html, module) => {
                    let replacement = self.url(&captures[3], html, module)?;
                    for part in [
                        &captures[1],
                        &captures[2],
                        replacement.as_deref().unwrap_or(&captures[3]),
                        &captures[4],
                    ] {
                        append(&mut output, part)?;
                    }
                }
                Kind::Unquoted => {
                    let replacement = self.url(&captures[2], true, false)?;
                    append(&mut output, &captures[1])?;
                    append(&mut output, replacement.as_deref().unwrap_or(&captures[2]))?;
                }
                Kind::Srcset => self.srcset(&mut output, &captures)?,
                Kind::StyleAttribute => {
                    let css = self.css(&decode_style_attribute(&captures[3])?)?;
                    for part in [&captures[1], &captures[2], &escape(&css)?, &captures[4]] {
                        append(&mut output, part)?;
                    }
                }
                Kind::StyleBlock | Kind::ModuleBlock => {
                    let transformed = match kind {
                        Kind::StyleBlock => self.css(&captures[2])?,
                        _ => self.replace(&captures[2], &JS_IMPORT, Kind::Url(false, true))?,
                    };
                    for part in [&captures[1], &transformed, &captures[3]] {
                        append(&mut output, part)?;
                    }
                }
            }
            cursor = matched.end();
        }
        append(&mut output, &input[cursor..])?;
        Ok(output)
    }

    fn srcset(&mut self, output: &mut String, captures: &Captures<'_>) -> Result<(), String> {
        append(output, &captures[1])?;
        append(output, &captures[2])?;
        let mut rest = &captures[3];
        let mut first = true;
        while !rest.is_empty() {
            rest = rest.trim_start_matches(|ch: char| ch.is_ascii_whitespace() || ch == ',');
            if rest.is_empty() {
                break;
            }
            let end = rest
                .find(|ch: char| ch.is_ascii_whitespace())
                .unwrap_or(rest.len());
            let raw = &rest[..end];
            rest = &rest[end..];
            let descriptor_end = if raw.ends_with(',') {
                0
            } else {
                rest.find(',').unwrap_or(rest.len())
            };
            let descriptor = &rest[..descriptor_end];
            rest = &rest[descriptor_end..];
            let raw = raw.trim_end_matches(',');
            let replacement = self.url(raw, true, false)?;
            if !first {
                append(output, ", ")?;
            }
            first = false;
            append(output, replacement.as_deref().unwrap_or(raw))?;
            append(output, descriptor)?;
        }
        append(output, &captures[4])
    }

    fn css(&mut self, input: &str) -> Result<String, String> {
        let urls = self.replace(input, &CSS_URL, Kind::Url(false, false))?;
        self.replace(&urls, &CSS_IMPORT, Kind::Url(false, false))
    }
}

pub(super) fn rewrite(
    content_type: &str,
    text: &str,
    callback: impl FnMut(&str, bool, bool) -> Result<Option<String>, String>,
) -> Result<String, String> {
    if text.len() > MAX_OUTPUT {
        return Err("External response exceeds 10MB limit".into());
    }
    let mut transform = Transformer {
        rewrite: callback,
        work: 0,
        references: 0,
    };
    if content_type.starts_with("text/html") {
        let mut html = transform.replace(text, &ATTR, Kind::Url(true, false))?;
        html = transform.replace(&html, &UNQUOTED, Kind::Unquoted)?;
        html = transform.replace(&html, &SRCSET, Kind::Srcset)?;
        html = transform.replace(&html, &STYLE_ATTR, Kind::StyleAttribute)?;
        html = transform.replace(&html, &STYLE_ATTR_SINGLE, Kind::StyleAttribute)?;
        html = transform.replace(&html, &STYLE_BLOCK, Kind::StyleBlock)?;
        transform.replace(&html, &MODULE_BLOCK, Kind::ModuleBlock)
    } else if content_type.starts_with("text/css") {
        transform.css(text)
    } else if content_type.contains("javascript") {
        transform.replace(text, &JS_IMPORT, Kind::Url(false, true))
    } else {
        Ok(text.into())
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    #[test]
    fn append_rejects_before_growth_and_requested_capacity_stays_within_limit() {
        let mut output = String::new();
        for _ in 0..9 {
            append(&mut output, &"a".repeat(1024 * 1024)).unwrap();
        }
        append(&mut output, &"a".repeat(1024 * 1024 - 8)).unwrap();
        assert!(output.capacity() <= MAX_OUTPUT);
        let before = (output.len(), output.capacity());
        assert!(append(&mut output, "123456789").is_err());
        assert_eq!((output.len(), output.capacity()), before);
    }
}

#[cfg(test)]
mod style_entity_tests {
    use super::*;
    #[test]
    fn attribute_entities_decode_exactly_once_without_output_growth() {
        let encoded = "url(&quot;one.svg?literal=&amp;quot;&amp;mode=two&#x23;inline&quot;)";
        assert_eq!(
            decode_style_attribute(encoded).unwrap(),
            "url(\"one.svg?literal=&quot;&mode=two#inline\")"
        );
        let css = "url('one.svg?x=1&y=2#inline')";
        let escaped = escape(css).unwrap();
        assert_eq!(decode_style_attribute(&escaped).unwrap(), css);
        assert!(decode_style_attribute(&escaped).unwrap().len() <= escaped.len());
    }
    #[test]
    fn oversized_attribute_rejected_before_decode() {
        assert!(decode_style_attribute(&"a".repeat(MAX_OUTPUT + 1))
            .unwrap_err()
            .contains("10MB"));
    }
}
