//! Pre-write syntax checks for `apply_patch`. Nothing here executes content.
//!
//! JSON uses `serde_json`. No TOML, YAML or Python parser crate is in
//! `Cargo.lock`, so TOML and YAML use hand-written structural checkers that
//! only reject documents that are definitely invalid. They are deliberately
//! conservative: a document they accept may still be rejected by a full
//! parser (for example a TOML date with an impossible day, or YAML with bad
//! indentation between sibling nodes), but a document they reject is invalid.
//! Python is not supported: a correct Python grammar cannot be hand-rolled
//! safely, and the only available parser would be a host `python3` process.

use serde_json::Value;
use std::collections::HashSet;

pub(super) const SUPPORTED: &str = "json, toml, yaml";

pub(super) fn is_supported(language: &str) -> bool {
    matches!(language, "json" | "toml" | "yaml")
}

pub(super) fn validate(language: &str, content: &str) -> Result<(), String> {
    let result = match language {
        "json" => serde_json::from_str::<Value>(content)
            .map(|_| ())
            .map_err(|err| err.to_string()),
        "toml" => validate_toml(content),
        "yaml" => validate_yaml(content),
        _ => return Err(format!("Unsupported validate_syntax language: {language}")),
    };
    result.map_err(|err| {
        format!(
            "{} syntax validation failed: {err}; no changes written",
            language.to_uppercase()
        )
    })
}

const MAX_DEPTH: usize = 64;

pub(super) fn validate_toml(content: &str) -> Result<(), String> {
    Toml::new(content).document()
}

struct Toml<'a> {
    s: &'a [u8],
    i: usize,
    table: Vec<String>,
    values: HashSet<Vec<String>>,
    tables: HashSet<Vec<String>>,
    dotted: HashSet<Vec<String>>,
    arrays: HashSet<Vec<String>>,
}

type Res<T> = Result<T, String>;

impl<'a> Toml<'a> {
    fn new(content: &'a str) -> Self {
        Self {
            s: content.as_bytes(),
            i: 0,
            table: Vec::new(),
            values: HashSet::new(),
            tables: HashSet::new(),
            dotted: HashSet::new(),
            arrays: HashSet::new(),
        }
    }

    fn fail<T>(&self, message: &str) -> Res<T> {
        let line = self.s[..self.i.min(self.s.len())]
            .iter()
            .filter(|b| **b == b'\n')
            .count()
            + 1;
        Err(format!("line {line}: {message}"))
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn starts(&self, text: &str) -> bool {
        self.s[self.i..].starts_with(text.as_bytes())
    }

    fn skip_blank(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t')) {
            self.i += 1;
        }
    }

    fn comment(&mut self) -> Res<()> {
        while let Some(b) = self.peek() {
            if b == b'\n' || (b == b'\r' && self.s.get(self.i + 1) == Some(&b'\n')) {
                break;
            }
            if is_control(b) {
                return self.fail("control character in comment");
            }
            self.i += 1;
        }
        Ok(())
    }

    fn newline(&mut self) -> bool {
        if self.peek() == Some(b'\n') {
            self.i += 1;
            true
        } else if self.starts("\r\n") {
            self.i += 2;
            true
        } else {
            false
        }
    }

    fn end_of_expression(&mut self) -> Res<()> {
        self.skip_blank();
        if self.peek() == Some(b'#') {
            self.comment()?;
        }
        if self.peek().is_none() || self.newline() {
            Ok(())
        } else {
            self.fail("unexpected characters after expression")
        }
    }

    fn document(&mut self) -> Res<()> {
        loop {
            self.skip_blank();
            match self.peek() {
                None => return Ok(()),
                Some(b'#') => self.comment()?,
                Some(_) if self.newline() => {}
                Some(b'[') => {
                    self.header()?;
                    self.end_of_expression()?;
                }
                Some(_) => {
                    self.key_value()?;
                    self.end_of_expression()?;
                }
            }
        }
    }

    fn key(&mut self) -> Res<Vec<String>> {
        let mut parts = Vec::new();
        loop {
            self.skip_blank();
            let part = match self.peek() {
                Some(b'"') => self.basic_string()?,
                Some(b'\'') => self.literal_string()?,
                Some(b) if is_bare(b) => {
                    let start = self.i;
                    while self.peek().is_some_and(is_bare) {
                        self.i += 1;
                    }
                    String::from_utf8_lossy(&self.s[start..self.i]).into_owned()
                }
                _ => return self.fail("expected a key"),
            };
            parts.push(part);
            self.skip_blank();
            if self.peek() == Some(b'.') {
                self.i += 1;
            } else {
                return Ok(parts);
            }
        }
    }

    fn header(&mut self) -> Res<()> {
        let array = self.starts("[[");
        self.i += if array { 2 } else { 1 };
        let path = self.key()?;
        self.skip_blank();
        let close = if array { "]]" } else { "]" };
        if !self.starts(close) {
            return self.fail("unterminated table header");
        }
        self.i += close.len();
        for end in 1..path.len() {
            if self.values.contains(&path[..end]) {
                return self.fail("table path crosses a value");
            }
        }
        if array {
            if self.tables.contains(&path)
                || self.values.contains(&path)
                || self.dotted.contains(&path)
            {
                return self.fail("array of tables conflicts with an earlier definition");
            }
            let below = |key: &Vec<String>| key.len() > path.len() && key.starts_with(&path);
            self.tables.retain(|key| !below(key));
            self.values.retain(|key| !below(key));
            self.dotted.retain(|key| !below(key));
            self.arrays
                .retain(|key| !below(key) || key.len() == path.len());
            self.arrays.insert(path.clone());
        } else if self.tables.contains(&path)
            || self.values.contains(&path)
            || self.dotted.contains(&path)
            || self.arrays.contains(&path)
        {
            return self.fail("table is defined more than once");
        } else {
            self.tables.insert(path.clone());
        }
        self.table = path;
        Ok(())
    }

    fn key_value(&mut self) -> Res<()> {
        let key = self.key()?;
        self.skip_blank();
        if self.peek() != Some(b'=') {
            return self.fail("expected '=' after key");
        }
        self.i += 1;
        self.skip_blank();
        let mut full = self.table.clone();
        full.extend(key);
        let depth = self.table.len();
        for end in depth + 1..full.len() {
            let prefix = &full[..end];
            if self.values.contains(prefix)
                || self.tables.contains(prefix)
                || self.arrays.contains(prefix)
            {
                return self.fail("dotted key conflicts with an earlier definition");
            }
        }
        for end in 1..full.len() {
            if self.values.contains(&full[..end]) {
                return self.fail("key path crosses a value");
            }
        }
        if self.values.contains(&full)
            || self.tables.contains(&full)
            || self.dotted.contains(&full)
            || self.arrays.contains(&full)
        {
            return self.fail("key is defined more than once");
        }
        for end in depth + 1..full.len() {
            self.dotted.insert(full[..end].to_vec());
        }
        self.value(0)?;
        self.values.insert(full);
        Ok(())
    }

    fn value(&mut self, depth: usize) -> Res<()> {
        if depth > MAX_DEPTH {
            return self.fail("nesting is too deep");
        }
        match self.peek() {
            Some(b'"') if self.starts("\"\"\"") => self.multiline_basic(),
            Some(b'"') => self.basic_string().map(|_| ()),
            Some(b'\'') if self.starts("'''") => self.multiline_literal(),
            Some(b'\'') => self.literal_string().map(|_| ()),
            Some(b'[') => self.array(depth),
            Some(b'{') => self.inline_table(depth),
            Some(_) => self.scalar(),
            None => self.fail("expected a value"),
        }
    }

    fn skip_array_space(&mut self) -> Res<()> {
        loop {
            self.skip_blank();
            if self.peek() == Some(b'#') {
                self.comment()?;
            } else if !self.newline() {
                return Ok(());
            }
        }
    }

    fn array(&mut self, depth: usize) -> Res<()> {
        self.i += 1;
        loop {
            self.skip_array_space()?;
            if self.peek() == Some(b']') {
                self.i += 1;
                return Ok(());
            }
            self.value(depth + 1)?;
            self.skip_array_space()?;
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(());
                }
                _ => return self.fail("expected ',' or ']' in array"),
            }
        }
    }

    fn inline_table(&mut self, depth: usize) -> Res<()> {
        self.i += 1;
        self.skip_blank();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(());
        }
        let mut seen: HashSet<Vec<String>> = HashSet::new();
        loop {
            let key = self.key()?;
            self.skip_blank();
            if self.peek() != Some(b'=') {
                return self.fail("expected '=' in inline table");
            }
            self.i += 1;
            self.skip_blank();
            for end in 1..=key.len() {
                if seen.contains(&key[..end]) {
                    return self.fail("duplicate key in inline table");
                }
            }
            if seen.iter().any(|other| other.starts_with(&key)) {
                return self.fail("duplicate key in inline table");
            }
            seen.insert(key);
            self.value(depth + 1)?;
            self.skip_blank();
            match self.peek() {
                Some(b',') => {
                    self.i += 1;
                    self.skip_blank();
                    if self.peek() == Some(b'}') {
                        return self.fail("trailing comma in inline table");
                    }
                }
                Some(b'}') => {
                    self.i += 1;
                    return Ok(());
                }
                _ => return self.fail("expected ',' or '}' in inline table"),
            }
        }
    }

    fn basic_string(&mut self) -> Res<String> {
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let Some(b) = self.peek() else {
                return self.fail("unterminated string");
            };
            self.i += 1;
            match b {
                b'"' => return Ok(String::from_utf8_lossy(&out).into_owned()),
                b'\\' => self.escape(&mut out)?,
                b'\n' | b'\r' => return self.fail("newline in single-line string"),
                _ if is_control(b) => return self.fail("control character in string"),
                _ => out.push(b),
            }
        }
    }

    fn escape(&mut self, out: &mut Vec<u8>) -> Res<()> {
        let Some(b) = self.peek() else {
            return self.fail("unterminated escape");
        };
        self.i += 1;
        match b {
            b'b' | b't' | b'n' | b'f' | b'r' | b'"' | b'\\' => out.push(b),
            b'u' | b'U' => {
                let width = if b == b'u' { 4 } else { 8 };
                let digits = self.s.get(self.i..self.i + width).unwrap_or(&[]);
                let valid = digits.len() == width && digits.iter().all(u8::is_ascii_hexdigit);
                let scalar = valid
                    .then(|| std::str::from_utf8(digits).ok())
                    .flatten()
                    .and_then(|text| u32::from_str_radix(text, 16).ok())
                    .and_then(char::from_u32);
                if scalar.is_none() {
                    return self.fail("invalid unicode escape");
                }
                self.i += width;
            }
            _ => return self.fail("invalid escape sequence"),
        }
        Ok(())
    }

    fn literal_string(&mut self) -> Res<String> {
        self.i += 1;
        let start = self.i;
        loop {
            let Some(b) = self.peek() else {
                return self.fail("unterminated string");
            };
            if b == b'\'' {
                let text = String::from_utf8_lossy(&self.s[start..self.i]).into_owned();
                self.i += 1;
                return Ok(text);
            }
            if b == b'\n' || b == b'\r' {
                return self.fail("newline in single-line string");
            }
            if is_control(b) {
                return self.fail("control character in string");
            }
            self.i += 1;
        }
    }

    fn multiline_basic(&mut self) -> Res<()> {
        self.i += 3;
        self.newline();
        loop {
            let Some(b) = self.peek() else {
                return self.fail("unterminated multi-line string");
            };
            match b {
                b'"' => {
                    if self.close_multiline(b'"')? {
                        return Ok(());
                    }
                }
                b'\\' => {
                    self.i += 1;
                    let mut ahead = self.i;
                    while matches!(self.s.get(ahead), Some(b' ' | b'\t')) {
                        ahead += 1;
                    }
                    if matches!(self.s.get(ahead), Some(b'\n'))
                        || self.s[ahead.min(self.s.len())..].starts_with(b"\r\n")
                    {
                        self.i = ahead;
                        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
                            self.i += 1;
                        }
                    } else {
                        self.escape(&mut Vec::new())?;
                    }
                }
                b'\r' if self.starts("\r\n") => self.i += 2,
                b'\n' | b'\t' => self.i += 1,
                _ if is_control(b) => return self.fail("control character in string"),
                _ => self.i += 1,
            }
        }
    }

    fn multiline_literal(&mut self) -> Res<()> {
        self.i += 3;
        self.newline();
        loop {
            let Some(b) = self.peek() else {
                return self.fail("unterminated multi-line string");
            };
            match b {
                b'\'' => {
                    if self.close_multiline(b'\'')? {
                        return Ok(());
                    }
                }
                b'\r' if self.starts("\r\n") => self.i += 2,
                b'\n' | b'\t' => self.i += 1,
                _ if is_control(b) => return self.fail("control character in string"),
                _ => self.i += 1,
            }
        }
    }

    fn close_multiline(&mut self, quote: u8) -> Res<bool> {
        let run = self.s[self.i..].iter().take_while(|b| **b == quote).count();
        if run < 3 {
            self.i += run;
            return Ok(false);
        }
        if run > 5 {
            return self.fail("too many quotes closing a multi-line string");
        }
        self.i += run;
        Ok(true)
    }

    fn scalar(&mut self) -> Res<()> {
        let start = self.i;
        while self
            .peek()
            .is_some_and(|b| !matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}' | b'#'))
        {
            self.i += 1;
        }
        let mut token = &self.s[start..self.i];
        let spaced_time = is_date(token)
            && self.peek() == Some(b' ')
            && self.s.get(self.i + 1).is_some_and(u8::is_ascii_digit)
            && self.s.get(self.i + 2).is_some_and(u8::is_ascii_digit)
            && self.s.get(self.i + 3) == Some(&b':');
        if spaced_time {
            self.i += 1;
            while self.peek().is_some_and(|b| {
                !matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b',' | b']' | b'}' | b'#')
            }) {
                self.i += 1;
            }
            token = &self.s[start..self.i];
        }
        if valid_scalar(token, spaced_time) {
            Ok(())
        } else {
            self.i = start;
            self.fail("invalid value")
        }
    }
}

fn is_control(b: u8) -> bool {
    (b < 0x20 && b != b'\t') || b == 0x7f
}

fn is_bare(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn digits(s: &[u8], radix: u32) -> Option<usize> {
    let mut i = 0;
    let mut previous_digit = false;
    while i < s.len() {
        if (s[i] as char).is_digit(radix) {
            previous_digit = true;
        } else if s[i] == b'_'
            && previous_digit
            && s.get(i + 1).is_some_and(|b| (*b as char).is_digit(radix))
        {
            previous_digit = false;
        } else {
            break;
        }
        i += 1;
    }
    (i > 0).then_some(i)
}

fn number(token: &[u8]) -> bool {
    let body = match token.first() {
        Some(b'+' | b'-') => &token[1..],
        _ => token,
    };
    let Some(whole) = digits(body, 10) else {
        return false;
    };
    if whole > 1 && body[0] == b'0' {
        return false;
    }
    let mut rest = &body[whole..];
    if rest.is_empty() {
        return true;
    }
    if rest[0] == b'.' {
        let Some(fraction) = digits(&rest[1..], 10) else {
            return false;
        };
        rest = &rest[1 + fraction..];
    }
    if matches!(rest.first(), Some(b'e' | b'E')) {
        rest = &rest[1..];
        if matches!(rest.first(), Some(b'+' | b'-')) {
            rest = &rest[1..];
        }
        let Some(exponent) = digits(rest, 10) else {
            return false;
        };
        rest = &rest[exponent..];
    }
    rest.is_empty()
}

fn is_date(token: &[u8]) -> bool {
    token.len() == 10
        && token[4] == b'-'
        && token[7] == b'-'
        && token
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
        && (1..=12).contains(&number_at(token, 5, 2))
        && (1..=31).contains(&number_at(token, 8, 2))
}

fn number_at(token: &[u8], start: usize, len: usize) -> u32 {
    std::str::from_utf8(&token[start..start + len])
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(u32::MAX)
}

fn is_time(token: &[u8]) -> bool {
    if token.len() < 8
        || token[2] != b':'
        || token[5] != b':'
        || ![0, 1, 3, 4, 6, 7]
            .iter()
            .all(|i| token[*i].is_ascii_digit())
        || number_at(token, 0, 2) > 23
        || number_at(token, 3, 2) > 59
        || number_at(token, 6, 2) > 60
    {
        return false;
    }
    let mut rest = &token[8..];
    if rest.first() == Some(&b'.') {
        let Some(fraction) =
            digits(&rest[1..], 10).filter(|n| rest[1..1 + n].iter().all(u8::is_ascii_digit))
        else {
            return false;
        };
        rest = &rest[1 + fraction..];
    }
    rest.is_empty()
        || matches!(rest, b"Z" | b"z")
        || (rest.len() == 6
            && matches!(rest[0], b'+' | b'-')
            && rest[3] == b':'
            && [1, 2, 4, 5].iter().all(|i| rest[*i].is_ascii_digit())
            && number_at(rest, 1, 2) <= 23
            && number_at(rest, 4, 2) <= 59)
}

fn valid_datetime(token: &[u8], spaced: bool) -> bool {
    if token.len() >= 10 && is_date(&token[..10]) {
        let rest = &token[10..];
        return rest.is_empty()
            || (matches!(rest[0], b'T' | b't') || (spaced && rest[0] == b' '))
                && is_time(&rest[1..]);
    }
    is_time(token) && !token.ends_with(b"Z") && !token.contains(&b'+')
}

fn valid_scalar(token: &[u8], spaced: bool) -> bool {
    if token.is_empty() {
        return false;
    }
    if matches!(
        token,
        b"true" | b"false" | b"inf" | b"+inf" | b"-inf" | b"nan" | b"+nan" | b"-nan"
    ) {
        return true;
    }
    if token.len() > 2 && token[0] == b'0' {
        let radix = match token[1] {
            b'x' => Some(16),
            b'o' => Some(8),
            b'b' => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            return digits(&token[2..], radix) == Some(token.len() - 2);
        }
    }
    number(token) || valid_datetime(token, spaced)
}

pub(super) fn validate_yaml(content: &str) -> Result<(), String> {
    Yaml::default().run(content)
}

#[derive(Default)]
struct Yaml {
    flow: Vec<u8>,
    quote: Option<(u8, usize)>,
    block_parent: Option<isize>,
    scopes: Vec<(usize, HashSet<String>)>,
}

#[derive(Default)]
struct Line {
    key: Option<String>,
    colons: usize,
    block_header: bool,
}

impl Yaml {
    fn run(&mut self, content: &str) -> Result<(), String> {
        for (index, raw) in content.lines().enumerate() {
            self.line(index + 1, raw)?;
        }
        if let Some((_, opened)) = self.quote {
            return Err(format!("line {opened}: unterminated quoted scalar"));
        }
        if !self.flow.is_empty() {
            return Err("unterminated flow collection".into());
        }
        Ok(())
    }

    fn line(&mut self, number: usize, raw: &str) -> Result<(), String> {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let marker = raw.starts_with("---") || raw.starts_with("...");
        let marker_end = raw
            .as_bytes()
            .get(3)
            .is_none_or(|b| matches!(b, b' ' | b'\t'));
        let is_marker = marker && marker_end;
        if is_marker && self.quote.is_none() {
            self.block_parent = None;
            self.flow.clear();
            self.scopes.clear();
            if raw.starts_with("...") {
                return Ok(());
            }
            let rest = &raw[3..];
            let scan_from = rest.trim_start();
            if scan_from.is_empty() || scan_from.starts_with('#') {
                return Ok(());
            }
            let info = self.scan(number, scan_from, true)?;
            if info.block_header {
                self.block_parent = Some(-1);
            }
            return Ok(());
        }
        let trimmed = raw.trim_start_matches(' ');
        let indent = raw.len() - trimmed.len();
        let blank = trimmed.trim().is_empty();
        if let Some(parent) = self.block_parent {
            if blank || indent as isize > parent {
                return Ok(());
            }
            self.block_parent = None;
        }
        if blank {
            return Ok(());
        }
        let clean_start = self.quote.is_none() && self.flow.is_empty();
        if clean_start {
            if trimmed.starts_with('\t') {
                return Err(format!("line {number}: tab used for indentation"));
            }
            if indent == 0 && trimmed.starts_with('%') {
                return Ok(());
            }
            if trimmed.starts_with('#') {
                return Ok(());
            }
        }
        if !clean_start {
            self.scan(number, raw, false)?;
            return Ok(());
        }
        let mut offset = indent;
        let mut dashed = false;
        let mut dash_indent = indent;
        let mut text = trimmed;
        while text == "-" || text.starts_with("- ") || text.starts_with("-\t") {
            if !dashed {
                dash_indent = offset;
            }
            dashed = true;
            let after = &text[1..];
            let spaces = after.len() - after.trim_start_matches(' ').len();
            offset += 1 + spaces;
            text = &after[spaces..];
        }
        let info = self.scan(number, text, true)?;
        if info.colons > 1 {
            return Err(format!(
                "line {number}: mapping values are not allowed here"
            ));
        }
        if let Some(key) = info.key.clone().filter(|key| key != "<<") {
            if dashed {
                self.scopes.retain(|(level, _)| *level < dash_indent);
            } else {
                self.scopes.retain(|(level, _)| *level <= offset);
            }
            let position = self.scopes.iter().position(|(level, _)| *level == offset);
            let position = position.unwrap_or_else(|| {
                self.scopes.push((offset, HashSet::new()));
                self.scopes.len() - 1
            });
            if !self.scopes[position].1.insert(key.clone()) {
                return Err(format!("line {number}: duplicate mapping key '{key}'"));
            }
        } else if dashed {
            self.scopes.retain(|(level, _)| *level < dash_indent);
        }
        if info.block_header {
            self.block_parent = Some(if info.key.is_some() {
                offset
            } else {
                dash_indent
            } as isize);
        }
        Ok(())
    }

    fn scan(&mut self, number: usize, text: &str, record: bool) -> Result<Line, String> {
        let bytes = text.as_bytes();
        let mut info = Line::default();
        let mut start_of_token = true;
        let mut key_start = 0usize;
        let mut quoted_key: Option<String> = None;
        let mut last_quoted = false;
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];
            if let Some((quote, _)) = self.quote {
                if quote == b'"' && b == b'\\' {
                    match bytes.get(i + 1) {
                        None => i += 1,
                        Some(
                            b'0' | b'a' | b'b' | b't' | b'\t' | b'n' | b'v' | b'f' | b'r' | b'e'
                            | b' ' | b'"' | b'/' | b'\\' | b'N' | b'_' | b'L' | b'P',
                        ) => i += 2,
                        Some(kind @ (b'x' | b'u' | b'U')) => {
                            let width = match kind {
                                b'x' => 2,
                                b'u' => 4,
                                _ => 8,
                            };
                            let hex = bytes.get(i + 2..i + 2 + width).unwrap_or(&[]);
                            if hex.len() != width || !hex.iter().all(u8::is_ascii_hexdigit) {
                                return Err(format!(
                                    "line {number}: invalid escape in double-quoted scalar"
                                ));
                            }
                            i += 2 + width;
                        }
                        Some(_) => {
                            return Err(format!(
                                "line {number}: invalid escape in double-quoted scalar"
                            ))
                        }
                    }
                    continue;
                }
                if b == quote {
                    if quote == b'\'' && bytes.get(i + 1) == Some(&b'\'') {
                        i += 2;
                        continue;
                    }
                    self.quote = None;
                    last_quoted = true;
                    if info.colons == 0 && info.key.is_none() && self.flow.is_empty() {
                        quoted_key = Some(text[key_start..i].to_owned());
                    }
                }
                i += 1;
                continue;
            }
            let previous_blank = i == 0 || matches!(bytes[i - 1], b' ' | b'\t');
            match b {
                b'#' if previous_blank => break,
                b'"' | b'\'' if start_of_token => {
                    self.quote = Some((b, number));
                    key_start = i + 1;
                    start_of_token = false;
                    last_quoted = false;
                }
                b'[' | b'{' if start_of_token || !self.flow.is_empty() => {
                    self.flow.push(if b == b'[' { b']' } else { b'}' });
                    start_of_token = true;
                    last_quoted = false;
                }
                b']' | b'}' if !self.flow.is_empty() => {
                    if self.flow.pop() != Some(b) {
                        return Err(format!("line {number}: mismatched flow collection bracket"));
                    }
                    start_of_token = false;
                    last_quoted = true;
                }
                b',' if !self.flow.is_empty() => start_of_token = true,
                b'&' | b'!' if start_of_token => {
                    while i < bytes.len() && !matches!(bytes[i], b' ' | b'\t') {
                        i += 1;
                    }
                    continue;
                }
                b'|' | b'>' if start_of_token && self.flow.is_empty() && record => {
                    let header = &text[i + 1..];
                    let (indicators, comment) = match header.find([' ', '\t']) {
                        Some(cut) => (&header[..cut], header[cut..].trim_start()),
                        None => (header, ""),
                    };
                    let valid = indicators.len() <= 2
                        && indicators
                            .bytes()
                            .all(|c| matches!(c, b'+' | b'-' | b'1'..=b'9'));
                    if valid && (comment.is_empty() || comment.starts_with('#')) {
                        info.block_header = true;
                        return Ok(info);
                    }
                    start_of_token = false;
                }
                b':' if self.flow.is_empty()
                    && bytes.get(i + 1).is_none_or(|n| matches!(n, b' ' | b'\t')) =>
                {
                    info.colons += 1;
                    if info.key.is_none() && record {
                        info.key = Some(match quoted_key.take() {
                            Some(key) => key,
                            None => text[key_start..i].trim().to_owned(),
                        });
                    }
                    start_of_token = true;
                    last_quoted = false;
                }
                b':' if !self.flow.is_empty()
                    && (last_quoted
                        || bytes
                            .get(i + 1)
                            .is_none_or(|n| matches!(n, b' ' | b'\t' | b',' | b']' | b'}'))) =>
                {
                    start_of_token = true;
                    last_quoted = false;
                }
                b' ' | b'\t' => {}
                _ => {
                    start_of_token = false;
                    last_quoted = false;
                }
            }
            i += 1;
        }
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(language: &str, text: &str) {
        assert_eq!(validate(language, text), Ok(()), "{text}");
    }

    fn bad(language: &str, text: &str) {
        let err = validate(language, text).unwrap_err();
        assert!(
            err.contains("syntax validation failed") && err.contains("no changes written"),
            "{err}"
        );
    }

    #[test]
    fn toml_accepts_representative_documents() {
        ok("toml", "");
        ok("toml", "# only a comment\n");
        ok(
            "toml",
            r#"
title = "T"
n = 1_000
neg = -0
hex = 0xDEAD_beef
oct = 0o755
bin = 0b1010
f = 3.14e+2
inf = -inf
nan = nan
flag = true
d = 1979-05-27
dt = 1979-05-27T07:32:00Z
dt2 = 1979-05-27 07:32:00.5-07:00
t = 07:32:00
lit = 'C:\path'
ml = """
line "quoted" \
   continued\u00e9
"""
mll = '''
raw \n ''''
arr = [ 1, 2,
  # comment
  3, ]
mixed = [[1, 2], ["a"]]
inline = { a = 1, b.c = "x" }
dotted.key = 1
"quoted key" = 2
'lit key' = 3
[server]
host = "h"
[server.tls]
on = false
[[products]]
name = "a"
[[products]]
name = "b"
[products.dims]
w = 1
"#,
        );
        ok("toml", "a = 1\r\nb = 2\r\n");
        ok("toml", "[a.b]\nx = 1\n[a]\ny = 2\n");
    }

    #[test]
    fn toml_rejects_definite_syntax_errors() {
        for text in [
            "a",
            "a =",
            "= 1",
            "a = b",
            "a = 1 2",
            "a = \"unterminated",
            "a = 'unterminated",
            "a = \"\"\"unterminated",
            "a = \"bad \\q escape\"",
            "a = \"bad \\u12 escape\"",
            "a = \"nl\nx\"",
            "a = [1, 2",
            "a = [1 2]",
            "a = { b = 1,}",
            "a = { b = 1\n}",
            "a = { b = 1, b = 2 }",
            "[a",
            "[a]]",
            "[]",
            "[a] x = 1",
            "a = 01",
            "a = 1__0",
            "a = _1",
            "a = 1.",
            "a = .5",
            "a = 0x",
            "a = 2024-13-01",
            "a = 1979-05-27T25:00:00",
            "a = True",
            "a = 1\na = 2",
            "a = 1\n[a]",
            "[a]\n[a]",
            "[a]\nb = 1\nb = 2",
            "[a]\nx = 1\n[[a]]",
            "[[a]]\n[a]",
            "a.b = 1\n[a]",
            "x = 1\nx.y = 2",
            "# c\u{1}\na = 1",
        ] {
            bad("toml", text);
        }
    }

    #[test]
    fn toml_array_of_tables_elements_get_fresh_namespaces() {
        ok(
            "toml",
            "[[p]]\nn = 1\n[p.d]\nw = 1\n[[p]]\nn = 2\n[p.d]\nw = 2\n",
        );
        bad("toml", "[[p]]\n[p.d]\nw = 1\n[p.d]\nw = 2\n");
    }

    #[test]
    fn toml_nesting_depth_is_bounded() {
        let deep = format!("a = {}{}", "[".repeat(5000), "]".repeat(5000));
        bad("toml", &deep);
    }

    #[test]
    fn yaml_accepts_representative_documents() {
        ok("yaml", "");
        ok("yaml", "# comment only\n");
        ok(
            "yaml",
            r#"%YAML 1.2
---
name: app
version: "1.0"
url: http://example.com:8080/x
time: 12:30:45
quoted: 'it''s'
escaped: "tab\t and \u00e9 and \x41"
say: He said "hi
flow: [a, b, {c: d}]
multi: [
  1, 2,
  3
]
json: {"a": 1, "b": [true, null]}
anchor: &a { x: 1 }
ref: *a
text: |
  not: a key
  not: a key
  tabs	inside block scalar are fine
folded: >-
  some
  words: here
list:
  - one
  - two: 2
    three: 3
  - two: 4
nested:
  a:
    x: 1
  b:
    x: 2
? complex
: value
merge:
  <<: *a
  <<: *a
long: "spans
  lines"
plain: multi word
  continued
...
---
other: 1
other2: 2
"#,
        );
        ok("yaml", "a: 1\r\nb: 2\r\n");
        ok("yaml", "- |\n  text: x\n- y\n");
        ok("yaml", "--- |\n  literal: text\n  literal: again\n");
        ok("yaml", "a: 1 # b: 2\n");
        ok("yaml", "\"a\": 1\n\"b\": 2\n");
    }

    #[test]
    fn yaml_rejects_definite_structural_errors() {
        for text in [
            "a: 1\na: 2\n",
            "a:\n  b: 1\n  b: 2\n",
            "- a: 1\n  a: 2\n",
            "a: \"unterminated\n",
            "a: 'unterminated\n",
            "a: [1, 2\n",
            "a: {b: 1\n",
            "a: [1, 2}\n",
            "a: {x: [1}]\n",
            "a: \"bad \\q escape\"\n",
            "a: \"bad \\x4\"\n",
            "a: b: c\n",
            "a: 1\n\tb: 2\n",
            "a:\n\tb: 1\n",
            "\"a\": 1\n\"a\": 2\n",
        ] {
            bad("yaml", text);
        }
    }

    #[test]
    fn yaml_duplicate_keys_are_scoped_to_their_own_mapping() {
        ok("yaml", "a:\n  x: 1\nb:\n  x: 2\n");
        ok("yaml", "- a: 1\n- a: 2\n");
        ok("yaml", "---\na: 1\n---\na: 2\n");
        bad("yaml", "---\na: 1\na: 2\n");
    }

    #[test]
    fn python_and_unknown_languages_are_not_supported() {
        for language in ["python", "ruby", "JSON", "yml", ""] {
            assert!(!is_supported(language), "{language}");
        }
        assert!(validate("python", "def (:").is_err());
    }

    #[test]
    fn json_still_validates() {
        ok("json", "{\"a\": [1, 2]}");
        bad("json", "{\"a\": [1, 2}");
    }
}
