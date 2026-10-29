use super::store::{active_generation, Fail, ROW_SPAN};
use super::{file_stat, Freshness, RecallIndex, Sources};
use rusqlite::{params_from_iter, types::Value, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Default)]
pub(crate) struct SearchRequest {
    pub workspace: String,
    pub account: bool,
    pub query: String,
    pub source: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub role: Option<String>,
    pub updated_after_ms: Option<i64>,
    pub updated_before_ms: Option<i64>,
    pub limit: usize,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Hit {
    pub key: String,
    pub source: String,
    pub id: String,
    pub workspace: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub updated_at: String,
    pub fingerprint: String,
    pub messages: usize,
    pub anchor: usize,
    pub excerpt: String,
    pub truncated: bool,
    pub source_truncated: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct SearchPage {
    pub hits: Vec<Hit>,
    pub next_cursor: Option<String>,
    pub generation: i64,
    #[allow(dead_code)]
    pub revision: i64,
    pub skipped: usize,
    pub undated: Option<usize>,
}

#[derive(Clone, Debug)]
pub(crate) enum SearchOutcome {
    Page(SearchPage),
    Fallback(String),
}

const EXPIRED: &str =
    "Recall index generation changed or expired; restart recall from its first page";

fn fts_match(query: &str) -> Option<String> {
    let lowered = query.trim().to_lowercase();
    let terms: Vec<&str> = lowered.split_whitespace().collect();
    if terms.is_empty()
        || terms
            .iter()
            .any(|term| !term.chars().any(char::is_alphanumeric))
    {
        return None;
    }
    Some(
        terms
            .iter()
            .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

pub(super) fn binding(owner: &str, request: &SearchRequest) -> String {
    let scope = serde_json::json!({
        "owner": owner,
        "workspace": if request.account { None } else { Some(&request.workspace) },
        "account": request.account,
        "query": request.query.trim().to_lowercase(),
        "source": request.source,
        "provider": request.provider.as_ref().map(|value| value.trim().to_lowercase()),
        "model": request.model.as_ref().map(|value| value.trim().to_lowercase()),
        "role": request.role,
        "after": request.updated_after_ms,
        "before": request.updated_before_ms,
        "limit": request.limit,
    });
    hex::encode(Sha256::digest(scope.to_string().as_bytes()))
}

fn parse_cursor(cursor: &str) -> Option<(i64, i64, usize, String)> {
    let mut parts = cursor.strip_prefix("rc1-")?.splitn(4, '-');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.to_owned(),
    ))
}

fn excerpt(text: &str, query: &str) -> (String, bool) {
    let lower = text.to_lowercase();
    let needle = query.trim().to_lowercase();
    let position = lower
        .find(&needle)
        .or_else(|| {
            needle
                .split_whitespace()
                .filter_map(|term| lower.find(term))
                .min()
        })
        .map(|byte| lower[..byte].chars().count())
        .unwrap_or(0);
    let characters: Vec<char> = text.chars().collect();
    let start = position.saturating_sub(100).min(characters.len());
    let end = (start + 500).min(characters.len());
    (
        characters[start..end].iter().collect(),
        start > 0 || end < characters.len(),
    )
}

impl RecallIndex {
    pub(crate) fn search(
        &self,
        request: &SearchRequest,
        sources: &dyn Sources,
    ) -> Result<SearchOutcome, String> {
        let connection = self.connect()?;
        self.search_inner(&connection, request, sources)
            .map_err(|error| match error {
                Fail::Msg(message) => message,
                other => self.describe(other),
            })
    }

    fn search_inner(
        &self,
        connection: &Connection,
        request: &SearchRequest,
        sources: &dyn Sources,
    ) -> Result<SearchOutcome, Fail> {
        let fallback = |reason: &str| -> Result<SearchOutcome, Fail> {
            if request.cursor.is_some() {
                Err(Fail::Msg(EXPIRED.into()))
            } else {
                Ok(SearchOutcome::Fallback(reason.into()))
            }
        };
        let matcher = if request.query.trim().is_empty() {
            if request.role.is_some() {
                return fallback("query_not_indexable");
            }
            None
        } else {
            match fts_match(&request.query) {
                Some(value) => Some(value),
                None => return fallback("query_not_indexable"),
            }
        };
        if active_generation(connection)?.is_none() {
            if request.cursor.is_some() {
                return Err(Fail::Msg(EXPIRED.into()));
            }
            if let Err(Fail::Msg(reason)) = self.start_rebuild_inner(connection, sources) {
                return Ok(SearchOutcome::Fallback(format!(
                    "rebuild_unavailable:{reason}"
                )));
            }
            let progress = self.rebuild_step_inner(
                connection,
                sources,
                self.limits.sync_max_docs.saturating_mul(4),
            )?;
            if !progress.activated {
                return Ok(SearchOutcome::Fallback(
                    progress
                        .failed
                        .map(|reason| format!("rebuild_failed:{reason}"))
                        .unwrap_or_else(|| format!("rebuilding:{}", progress.remaining)),
                ));
            }
        }
        match self.sync_inner(connection, sources)? {
            Freshness::Complete { .. } => {}
            Freshness::Incomplete(reason) => return fallback(&reason),
        }
        let Some((generation, revision)) = active_generation(connection)? else {
            return fallback("no_active_generation");
        };
        let expected_binding = binding(&self.owner, request);
        let offset = match &request.cursor {
            None => 0,
            Some(cursor) => {
                let Some((cursor_generation, cursor_revision, offset, cursor_binding)) =
                    parse_cursor(cursor)
                else {
                    return Err(Fail::Msg("Invalid recall index cursor".into()));
                };
                if cursor_binding != expected_binding {
                    return Err(Fail::Msg(
                        "Recall cursor does not match this account, workspace, query or filters"
                            .into(),
                    ));
                }
                if cursor_generation != generation || cursor_revision != revision {
                    return Err(Fail::Msg(EXPIRED.into()));
                }
                offset
            }
        };

        let mut values: Vec<Value> = Vec::new();
        let mut clauses = vec![
            "d.gen=?1".to_owned(),
            "d.owner=?2".to_owned(),
            "NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.key=d.key)".to_owned(),
        ];
        values.push(Value::Integer(generation));
        values.push(Value::Text(self.owner.clone()));
        fn push(clauses: &mut Vec<String>, values: &mut Vec<Value>, clause: &str, value: Value) {
            values.push(value);
            clauses.push(clause.replace('?', &format!("?{}", values.len())));
        }
        if !request.account {
            push(
                &mut clauses,
                &mut values,
                "d.workspace_key=?",
                Value::Text(hex::encode(Sha256::digest(
                    crate::session_search::normalize_workspace_path(&request.workspace).as_bytes(),
                ))),
            );
        }
        if let Some(source) = &request.source {
            push(
                &mut clauses,
                &mut values,
                "d.source=?",
                Value::Text(source.clone()),
            );
        }
        if let Some(provider) = &request.provider {
            push(
                &mut clauses,
                &mut values,
                "lower(d.provider)=?",
                Value::Text(provider.trim().to_lowercase()),
            );
        }
        if let Some(model) = &request.model {
            push(
                &mut clauses,
                &mut values,
                "lower(d.model)=?",
                Value::Text(model.trim().to_lowercase()),
            );
        }
        let dated = request.updated_after_ms.is_some() || request.updated_before_ms.is_some();
        let undated = if dated {
            let sql = format!(
                "SELECT COUNT(*) FROM docs d WHERE {} AND d.updated_ms IS NULL",
                clauses.join(" AND ")
            );
            let count: i64 =
                connection.query_row(&sql, params_from_iter(values.iter()), |row| row.get(0))?;
            Some(count as usize)
        } else {
            None
        };
        if dated {
            clauses.push("d.updated_ms IS NOT NULL".into());
        }
        if let Some(after) = request.updated_after_ms {
            push(
                &mut clauses,
                &mut values,
                "d.updated_ms>=?",
                Value::Integer(after),
            );
        }
        if let Some(before) = request.updated_before_ms {
            push(
                &mut clauses,
                &mut values,
                "d.updated_ms<?",
                Value::Integer(before),
            );
        }
        let where_clause = clauses.join(" AND ");
        values.push(Value::Integer(request.limit as i64 + 1));
        values.push(Value::Integer(offset as i64));
        let limit_slot = values.len() - 1;
        let offset_slot = values.len();
        let select = "d.id,d.key,d.source,d.doc_id,d.workspace,d.title,d.provider,d.model,d.updated_at,d.fingerprint,d.messages,d.size,d.mtime_ns,d.path,d.source_truncated";
        let sql = if let Some(matcher) = &matcher {
            values.push(Value::Text(matcher.clone()));
            let match_slot = values.len();
            let role_clause = if let Some(role) = &request.role {
                values.push(Value::Text(role.clone()));
                format!(" AND role=?{}", values.len())
            } else {
                String::new()
            };
            format!(
                "WITH m AS MATERIALIZED (SELECT rowid/{span} AS doc, rowid%{span} AS msg, bm25(fts) AS r FROM fts WHERE fts MATCH ?{match_slot}{role_clause}),
                 b AS (SELECT doc, msg, MIN(r) AS r FROM m GROUP BY doc)
                 SELECT {select}, b.msg FROM b JOIN docs d ON d.id=b.doc
                 WHERE {where_clause} ORDER BY b.r, d.updated_ms DESC, d.key LIMIT ?{limit_slot} OFFSET ?{offset_slot}",
                span = ROW_SPAN
            )
        } else {
            format!(
                "SELECT {select}, 1 FROM docs d WHERE {where_clause} ORDER BY d.updated_ms DESC, d.key LIMIT ?{limit_slot} OFFSET ?{offset_slot}"
            )
        };
        struct Row {
            doc: i64,
            hit: Hit,
            size: u64,
            mtime: String,
            path: String,
            msg: i64,
        }
        let rows: Vec<Row> = {
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(params_from_iter(values.iter()), |row| {
                Ok(Row {
                    doc: row.get(0)?,
                    hit: Hit {
                        key: row.get(1)?,
                        source: row.get(2)?,
                        id: row.get(3)?,
                        workspace: row.get(4)?,
                        title: row.get(5)?,
                        provider: row.get(6)?,
                        model: row.get(7)?,
                        updated_at: row.get(8)?,
                        fingerprint: row.get(9)?,
                        messages: row.get::<_, i64>(10)? as usize,
                        anchor: 1,
                        excerpt: String::new(),
                        truncated: false,
                        source_truncated: row.get::<_, i64>(14)? != 0,
                    },
                    size: row.get::<_, i64>(11)? as u64,
                    mtime: row.get(12)?,
                    path: row.get(13)?,
                    msg: row.get(15)?,
                })
            })?;
            rows.collect::<Result<_, _>>()?
        };
        let more = rows.len() > request.limit;
        let mut hits = Vec::new();
        for mut row in rows.into_iter().take(request.limit) {
            let live = file_stat(std::path::Path::new(&row.path));
            if live.map(|(size, mtime)| (size, mtime.to_string())) != Some((row.size, row.mtime)) {
                return fallback("source_changed_during_search");
            }
            let anchor = row.msg.max(1);
            let text: Option<String> = connection
                .query_row(
                    "SELECT text FROM fts WHERE rowid=?1",
                    [row.doc * ROW_SPAN + anchor],
                    |found| found.get(0),
                )
                .optional()?;
            let (found, truncated) = excerpt(&text.unwrap_or_default(), &request.query);
            row.hit.anchor = anchor as usize;
            row.hit.excerpt = found;
            row.hit.truncated = truncated;
            hits.push(row.hit);
        }
        let skipped = super::store::skipped_count(connection, generation)?;
        Ok(SearchOutcome::Page(SearchPage {
            next_cursor: more.then(|| {
                format!(
                    "rc1-{generation}-{revision}-{}-{expected_binding}",
                    offset + request.limit
                )
            }),
            hits,
            generation,
            revision,
            skipped,
            undated,
        }))
    }
}
