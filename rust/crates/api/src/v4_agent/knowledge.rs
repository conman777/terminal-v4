#[path = "knowledge_history.rs"]
mod history;

use crate::{
    session_search::safe_history_text,
    workspace::{
        account_profile_path, profile_path, read_profile, validate_support_path, WorkspaceProfile,
        WorkspaceSkill,
    },
    workspace_proposals::agent_proposals,
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Component, Path, PathBuf},
};

const FILE_BYTES: u64 = 64_000;
const WINDOW_CHARS: usize = 24_000;

pub(super) fn definitions() -> Vec<Value> {
    [
        ("recall_sessions", "Search owned app conversations. Query matches redacted titles or messages containing all terms; exact phrases rank ahead of unordered terms, then title matches. By default ranking applies within each returned page. Set rankWindow true to rank the whole bounded scan window; continue nextResultOffset with the same candidatePage, offset, filters, limit and windowRevision before advancing nextOffset or nextCandidatePage. Changes to a ranked window require restarting it. Ranking is not global across windows. Optional updatedAfter and updatedBefore filter last-update timestamps, inclusive and exclusive respectively; use RFC3339 or YYYY-MM-DD at midnight UTC. Undated records are excluded and counted. Returns redacted excerpts and references for read_session.", json!({"query":{"type":"string","maxLength":256},"limit":{"type":"integer","minimum":1,"maximum":25},"scope":{"type":"string","enum":["workspace","account"]},"source":{"type":"string","enum":["v4","terminal","structured","imported"]},"provider":{"type":"string","minLength":1,"maxLength":128},"model":{"type":"string","minLength":1,"maxLength":200},"role":{"type":"string","enum":["user","assistant","system","tool","terminal"]},"updatedAfter":{"type":"string","minLength":10,"maxLength":35},"updatedBefore":{"type":"string","minLength":10,"maxLength":35},"offset":{"type":"integer","minimum":0},"candidatePage":{"type":"integer","minimum":0},"rankWindow":{"type":"boolean"},"resultOffset":{"type":"integer","minimum":0,"maximum":50},"windowRevision":{"type":"string","minLength":64,"maxLength":64}}), vec![]),
        ("read_session", "Read an anchored window of one owned app session. Use source/workspacePath from recall for other conversation kinds or workspaces. Message anchors are 1-based; a fingerprint can reject stale history. Secrets are redacted; truncated text is identified.", json!({"sessionId":{"type":"string"},"anchor":{"type":"integer","minimum":1},"before":{"type":"integer","minimum":0,"maximum":10},"after":{"type":"integer","minimum":0,"maximum":10},"fingerprint":{"type":"string"},"charOffset":{"type":"integer","minimum":0},"source":{"type":"string","enum":["v4","terminal","structured","imported"]},"workspacePath":{"type":"string"}}), vec!["sessionId","anchor"]),
        ("read_context_archive", "Read a bounded redacted public/tool-evidence window from an owned V4 compaction archive. Use the session/receipt IDs and zero-based record index in a v4://context source reference. Private reasoning, signatures and binary images are excluded. Immutable source revisions and character offsets support reliable continuation.", json!({"sessionId":{"type":"string"},"receiptId":{"type":"string"},"record":{"type":"integer","minimum":0},"charOffset":{"type":"integer","minimum":0},"revision":{"type":"string"}}), vec!["sessionId","receiptId","record"]),
        ("inspect_knowledge", "Inspect this account's saved workspace/account memory, reusable skill package metadata, and pending reviewed proposals. Does not read another application's private memory.", json!({"scope":{"type":"string","enum":["workspace","account","both"]}}), vec![]),
        ("discover_skills", "Discover owned workspace/account skill packages and bounded SKILL.md packages from fixed project .v4/skills, .agents/skills, and .claude/skills roots. External packages are read-only; supporting files require explicit reads.", json!({}), vec![]),
        ("list_skill_files", "List a discovered skill package's instruction/support files with sizes and revisions. Re-resolves the skill reference in the current account/workspace; rejects symlinks and protected paths.", json!({"skillRef":{"type":"string"}}), vec!["skillRef"]),
        ("read_skill_file", "Read bounded numbered lines from a skill instruction or UTF-8 support file. Returns a revision and stable reference. Supporting scripts are not executed.", json!({"skillRef":{"type":"string"},"path":{"type":"string"},"startLine":{"type":"integer","minimum":1},"lines":{"type":"integer","minimum":1,"maximum":200},"charOffset":{"type":"integer","minimum":0}}), vec!["skillRef","path"]),
        ("propose_knowledge", "Stage memory or skill package creation/update/removal for explicit human review. Never applies its own proposal. Replacements/removals require exact before fields including beforeActivation and beforeSupportFiles; omitted beforeActivation means alwaysOn, and omitted activation on update preserves it. Package updates can create/edit/delete support files atomically. Agent shorthand operations: skillFileCreate{id,path,content}, skillFileReplace{id,path,beforeRevision,content}, skillFileDelete{id,path,beforeRevision} use file revisions; skillUpdate/skillRemove may use beforeRevision from packageRevision to preserve unread support content. V4 expands shorthands into full reviewed changes. scope is workspace or account; proposal is {id UUID,title,reason,operations}.", json!({"scope":{"type":"string","enum":["workspace","account"]},"proposal":{"type":"object"}}), vec!["scope","proposal"]),
    ].into_iter().map(|(name, description, properties, required)| json!({"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect()
}

pub(super) fn handles(name: &str) -> bool {
    matches!(
        name,
        "recall_sessions"
            | "read_session"
            | "read_context_archive"
            | "inspect_knowledge"
            | "discover_skills"
            | "list_skill_files"
            | "read_skill_file"
            | "propose_knowledge"
    )
}

fn parse<T: DeserializeOwned>(arguments: &Value) -> Result<T, String> {
    serde_json::from_value(arguments.clone()).map_err(|_| "Invalid knowledge tool arguments".into())
}

fn redacted(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(safe_history_text(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(redacted).collect()),
        Value::Object(items) => Value::Object(
            items
                .into_iter()
                .map(|(key, value)| (key, redacted(value)))
                .collect(),
        ),
        value => value,
    }
}

fn checked_storage_path(data: &Path, path: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(data)
        .map_err(|_| "Invalid knowledge storage path")?;
    let mut current = data.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Symlinked knowledge storage is not allowed".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err("Knowledge storage is unavailable".into()),
        }
    }
    Ok(())
}

fn profile(
    data: &Path,
    owner: &str,
    workspace: &Path,
    account: bool,
) -> Result<WorkspaceProfile, String> {
    let path = if account {
        account_profile_path(data, owner)
    } else {
        profile_path(data, owner, &workspace.to_string_lossy()).map_err(|error| error.message)?
    };
    checked_storage_path(data, &path)?;
    read_profile(&path).map_err(|error| error.message)
}

fn fingerprint(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn session_reference(source: history::Source, id: &str, workspace: &str, anchor: usize) -> String {
    let key = fingerprint(&crate::session_search::normalize_workspace_path(workspace));
    let query = format!("workspace={key}");
    format!(
        "v4://history/{}/{id}?{query}#message={anchor}",
        source.name()
    )
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Recall {
    query: String,
    limit: Option<usize>,
    scope: Option<String>,
    offset: Option<usize>,
    candidate_page: Option<usize>,
    source: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    role: Option<String>,
    updated_after: Option<String>,
    updated_before: Option<String>,
    rank_window: bool,
    result_offset: Option<usize>,
    window_revision: Option<String>,
}

fn recall_time_bound(value: Option<&str>) -> Result<Option<time::OffsetDateTime>, String> {
    let Some(value) = value else { return Ok(None) };
    if value.len() > 35 || value.trim() != value || value.chars().any(char::is_control) {
        return Err("Recall update-time bounds must be ISO dates or RFC3339 timestamps".into());
    }
    let normalized = if value.len() == 10 {
        format!("{value}T00:00:00Z")
    } else {
        value.to_owned()
    };
    time::OffsetDateTime::parse(&normalized, &time::format_description::well_known::Rfc3339)
        .map(Some)
        .map_err(|_| "Recall update-time bounds must be ISO dates or RFC3339 timestamps".into())
}

fn recall(data: &Path, owner: &str, workspace: &Path, input: &Value) -> Result<Value, String> {
    recall_with_budget(data, owner, workspace, input, history::SCAN_BYTES)
}
fn recall_with_budget(
    data: &Path,
    owner: &str,
    workspace: &Path,
    input: &Value,
    byte_limit: u64,
) -> Result<Value, String> {
    let input: Recall = parse(input)?;
    let limit = input.limit.unwrap_or(10);
    let offset = input.offset.unwrap_or(0);
    let candidate_page = input.candidate_page.unwrap_or(0);
    let result_offset = input.result_offset.unwrap_or(0);
    let entry_offset = candidate_page
        .checked_mul(2_000)
        .ok_or("candidatePage is too large")?;
    let scope = input.scope.as_deref().unwrap_or("workspace");
    if input.query.chars().count() > 256
        || input.query.chars().any(char::is_control)
        || !(1..=25).contains(&limit)
        || offset > 8_000
        || !["workspace", "account"].contains(&scope)
    {
        return Err("Recall accepts up to 256 query characters, 1–25 sessions, workspace/account scope and offset 0–8000".into());
    }
    if (!input.rank_window && (input.result_offset.is_some() || input.window_revision.is_some()))
        || result_offset > history::SCAN_FILES
        || (result_offset > 0 && input.window_revision.is_none())
        || input.window_revision.as_deref().is_some_and(|revision| {
            revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err("Ranked recall continuation requires rankWindow, a bounded resultOffset and its windowRevision".into());
    }
    let source = input
        .source
        .as_deref()
        .map(history::Source::parse)
        .transpose()?;
    for (value, max) in [
        (input.provider.as_deref(), 128),
        (input.model.as_deref(), 200),
    ] {
        if value.is_some_and(|value| {
            value.trim().is_empty()
                || value.chars().count() > max
                || value.chars().any(char::is_control)
        }) {
            return Err("Recall provider/model filters must be nonempty, bounded and contain no control characters".into());
        }
    }
    if input
        .role
        .as_deref()
        .is_some_and(|role| !["user", "assistant", "system", "tool", "terminal"].contains(&role))
    {
        return Err("Unknown recall message role".into());
    }
    let updated_after = recall_time_bound(input.updated_after.as_deref())?;
    let updated_before = recall_time_bound(input.updated_before.as_deref())?;
    if updated_after
        .zip(updated_before)
        .is_some_and(|(after, before)| after >= before)
    {
        return Err("Recall updatedAfter must be earlier than updatedBefore".into());
    }
    let needle = input.query.trim().to_lowercase();
    let terms: Vec<&str> = needle.split_whitespace().collect();
    let (candidates, truncated, omitted, warnings) =
        history::candidates(data, owner, workspace, scope == "account", entry_offset);
    let mut revision = if input.rank_window {
        let mut hash = Sha256::new();
        let revision_scope = json!({"owner":owner,"workspace":workspace.to_string_lossy(),"query":input.query,"scope":scope,"source":input.source,"provider":input.provider,"model":input.model,"role":input.role,"updatedAfter":input.updated_after,"updatedBefore":input.updated_before,"candidatePage":candidate_page,"offset":offset,"limit":limit,"byteLimit":byte_limit,"truncated":truncated,"omitted":omitted});
        hash.update(
            serde_json::to_vec(&revision_scope).map_err(|_| "Unable to encode recall scope")?,
        );
        for candidate in &candidates {
            let path = candidate.path.to_string_lossy();
            hash.update((path.len() as u64).to_be_bytes());
            hash.update(path.as_bytes());
            hash.update(candidate.source.name().as_bytes());
            hash.update(candidate.bytes.to_be_bytes());
        }
        Some(hash)
    } else {
        None
    };
    let total_candidates = candidates.len();
    let mut scanned = 0;
    let mut bytes = 0_u64;
    let mut unreadable = 0;
    let mut undated = 0;
    let mut next = offset;
    let mut rows = Vec::new();
    for candidate in candidates.into_iter().skip(offset) {
        if scanned >= history::SCAN_FILES {
            break;
        }
        if candidate.bytes > byte_limit {
            if let Some(hash) = revision.as_mut() {
                hash.update(b"candidate-exceeds-scan-budget");
            }
            scanned += 1;
            next += 1;
            unreadable += 1;
            continue;
        }
        if bytes.saturating_add(candidate.bytes) > byte_limit {
            break;
        }
        let session = match history::read_candidate_with_budget(
            data,
            &candidate,
            byte_limit.saturating_sub(bytes),
        ) {
            Ok(session) => session,
            Err(error) if error == "App conversation exceeds remaining scan budget" => {
                if let Some(hash) = revision.as_mut() {
                    hash.update(b"budget-exhausted");
                }
                if bytes == 0 {
                    scanned += 1;
                    next += 1;
                    unreadable += 1;
                    bytes = bytes.saturating_add(candidate.bytes);
                    continue;
                }
                bytes = bytes.saturating_add(candidate.bytes);
                break;
            }
            Err(_) => {
                if let Some(hash) = revision.as_mut() {
                    hash.update(b"unreadable");
                }
                scanned += 1;
                next += 1;
                bytes = bytes.saturating_add(candidate.bytes);
                unreadable += 1;
                continue;
            }
        };
        if let Some(hash) = revision.as_mut() {
            hash.update(b"readable");
            hash.update(session.fingerprint.as_bytes());
            hash.update((session.updated_at.len() as u64).to_be_bytes());
            hash.update(session.updated_at.as_bytes());
        }
        scanned += 1;
        next += 1;
        bytes = bytes.saturating_add(session.read_bytes);
        if scope == "workspace"
            && crate::session_search::normalize_workspace_path(&session.workspace)
                != crate::session_search::normalize_workspace_path(&workspace.to_string_lossy())
        {
            continue;
        }
        if source.is_some_and(|source| session.source != source)
            || input
                .provider
                .as_ref()
                .is_some_and(|provider| !session.provider.eq_ignore_ascii_case(provider.trim()))
            || input
                .model
                .as_ref()
                .is_some_and(|model| !session.model.eq_ignore_ascii_case(model.trim()))
        {
            continue;
        }
        if updated_after.is_some() || updated_before.is_some() {
            let Ok(updated) = time::OffsetDateTime::parse(
                &session.updated_at,
                &time::format_description::well_known::Rfc3339,
            ) else {
                undated += 1;
                continue;
            };
            if updated_after.is_some_and(|after| updated < after)
                || updated_before.is_some_and(|before| updated >= before)
            {
                continue;
            }
        }
        let title = safe_history_text(&session.title);
        let score = |text: &str, title_match: bool| -> Option<u8> {
            let lower = text.to_lowercase();
            if terms.iter().all(|term| lower.contains(term)) {
                Some(if needle.is_empty() {
                    0
                } else {
                    u8::from(lower.contains(&needle)) * 2 + u8::from(title_match)
                })
            } else {
                None
            }
        };
        let mut found: Option<(u8, usize, String)> = None;
        for (index, message) in session.messages.iter().enumerate() {
            if input
                .role
                .as_deref()
                .is_some_and(|role| message.role != role)
            {
                continue;
            }
            let text = safe_history_text(&message.text);
            if let Some(rank) = score(&text, false) {
                if found.as_ref().is_none_or(|(best, _, _)| rank > *best) {
                    found = Some((rank, index, text));
                }
                if needle.is_empty() || rank == 2 {
                    break;
                }
            }
        }
        if !needle.is_empty() && input.role.is_none() {
            if let Some(rank) = score(&title, true) {
                if found.as_ref().is_none_or(|(best, _, _)| rank > *best) {
                    if let Some(message) = session.messages.first() {
                        found = Some((rank, 0, safe_history_text(&message.text)));
                    }
                }
            }
        }
        let Some((rank, index, text)) = found else {
            continue;
        };
        let lower = text.to_lowercase();
        let match_index = lower
            .find(&needle)
            .or_else(|| terms.iter().filter_map(|term| lower.find(term)).min())
            .map(|byte| lower[..byte].chars().count())
            .unwrap_or(0);
        let characters: Vec<char> = text.chars().collect();
        let start = match_index.saturating_sub(100).min(characters.len());
        let end = (start + 500).min(characters.len());
        rows.push((rank, json!({"sessionId":session.id,"source":session.source.name(),"provider":session.provider,"model":session.model,"workspacePath":session.workspace,"title":safe_history_text(&session.title).chars().take(100).collect::<String>(),"updatedAt":session.updated_at,"messages":session.messages.len(),"anchor":index+1,"reference":session_reference(session.source,&session.id,&session.workspace,index+1),"fingerprint":session.fingerprint,"excerpt":characters[start..end].iter().collect::<String>(),"truncated":start>0 || end<characters.len(),"truncatedAtSource":session.truncated})));
        if !input.rank_window && rows.len() == limit {
            break;
        }
    }
    rows.sort_by(|left, right| right.0.cmp(&left.0));
    let window_revision = revision.map(|hash| hex::encode(hash.finalize()));
    if input
        .window_revision
        .as_deref()
        .is_some_and(|expected| Some(expected) != window_revision.as_deref())
    {
        return Err("Recall window changed; restart ranked recall from its first page".into());
    }
    if input.rank_window && result_offset > rows.len() {
        return Err("Ranked recall resultOffset exceeds this window".into());
    }
    let result_end = if input.rank_window {
        result_offset.saturating_add(limit).min(rows.len())
    } else {
        rows.len()
    };
    let next_result_offset = (input.rank_window && result_end < rows.len()).then_some(result_end);
    let rows: Vec<Value> = rows
        .into_iter()
        .skip(result_offset)
        .take(result_end.saturating_sub(result_offset))
        .map(|(_, row)| row)
        .collect();
    let window_complete = next_result_offset.is_none();
    let mut result = json!({"sessions":rows,"scanned":scanned,"scannedBytes":bytes,"unreadable":unreadable,"scope":scope,"nextOffset":if window_complete && next<total_candidates {Some(next)}else{None},"candidateLimitPerSource":2_000,"candidatePage":candidate_page,"nextCandidatePage":if window_complete && truncated {candidate_page.checked_add(1)}else{None},"candidateScanTruncated":truncated,"omitted":omitted,"scanLimit":history::SCAN_FILES,"byteLimit":byte_limit,"warnings":warnings});
    if updated_after.is_some() || updated_before.is_some() {
        result["undated"] = json!(undated);
    }
    if input.rank_window {
        result["windowRevision"] = json!(window_revision);
        result["nextResultOffset"] = json!(next_result_offset);
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadSession {
    session_id: String,
    anchor: usize,
    before: Option<usize>,
    after: Option<usize>,
    fingerprint: Option<String>,
    char_offset: Option<usize>,
    source: Option<String>,
    workspace_path: Option<String>,
}

fn read_session(
    data: &Path,
    owner: &str,
    workspace: &Path,
    arguments: &Value,
) -> Result<Value, String> {
    let input: ReadSession = parse(arguments)?;
    let before = input.before.unwrap_or(2);
    let after = input.after.unwrap_or(2);
    if input.anchor == 0 || before > 10 || after > 10 {
        return Err(
            "Use a positive message anchor and at most 10 surrounding messages on each side".into(),
        );
    }
    let source = history::Source::parse(input.source.as_deref().unwrap_or("v4"))?;
    let workspace_path = input
        .workspace_path
        .as_deref()
        .unwrap_or(workspace.to_str().ok_or("Workspace path must be UTF-8")?);
    if workspace_path.len() > 2048
        || !Path::new(workspace_path).is_absolute()
        || workspace_path.chars().any(char::is_control)
    {
        return Err("workspacePath must be a bounded absolute app-history workspace".into());
    }
    let session = history::load(data, owner, workspace_path, source, &input.session_id)?;
    let revision = session.fingerprint.clone();
    if input
        .fingerprint
        .as_ref()
        .is_some_and(|expected| expected != &revision)
    {
        return Err("Session changed; recall a fresh reference".into());
    }
    if input.anchor > session.messages.len() {
        return Err("Message anchor is outside this session".into());
    }
    let start = (input.anchor - 1).saturating_sub(before);
    let end = input
        .anchor
        .saturating_add(after)
        .min(session.messages.len());
    let mut left = WINDOW_CHARS;
    let mut messages = Vec::new();
    for (index, message) in session.messages.iter().enumerate().take(end).skip(start) {
        if left == 0 {
            break;
        }
        let text = safe_history_text(&message.text);
        let offset = if index + 1 == input.anchor {
            input.char_offset.unwrap_or(0)
        } else {
            0
        };
        let total = text.chars().count();
        if offset > total {
            return Err("charOffset is outside the anchor message".into());
        }
        let content = text
            .chars()
            .skip(offset)
            .take(left.min(8_000))
            .collect::<String>();
        let emitted = content.chars().count();
        left -= emitted;
        messages.push(json!({"anchor":index+1,"reference":session_reference(session.source,&session.id,&session.workspace,index+1),"role":message.role,"text":content,"charOffset":offset,"nextCharOffset":if offset+emitted<total {Some(offset+emitted)} else {None},"truncated":offset>0 || offset+emitted<total}));
    }
    let last = messages
        .last()
        .and_then(|message| message["anchor"].as_u64())
        .unwrap_or(start as u64) as usize;
    Ok(
        json!({"sessionId":session.id,"fingerprint":revision,"totalMessages":session.messages.len(),"messages":messages,"previousAnchor":if start>0 {Some(start)} else {None},"nextAnchor":if last<session.messages.len() {Some(last+1)} else {None},"characterLimit":WINDOW_CHARS}),
    )
}

fn package_revision(skill: &WorkspaceSkill) -> String {
    let mut digest = Sha256::new();
    digest.update(skill.id.as_bytes());
    for text in std::iter::once(&skill.name)
        .chain(std::iter::once(&skill.instructions))
        .chain(
            skill
                .support_files
                .iter()
                .flat_map(|(path, content)| [path, content]),
        )
    {
        digest.update((text.len() as u64).to_le_bytes());
        digest.update(text.as_bytes());
    }
    if skill.activation == Some(crate::workspace::SkillActivation::OnDemand) {
        digest.update(b"\0activation:onDemand");
    }
    hex::encode(digest.finalize())
}

fn skill_summary(skill: &WorkspaceSkill, scope: &str) -> Value {
    json!({"skillRef":format!("{scope}:{}",skill.id),"scope":scope,"name":skill.name,"activation":skill.activation.unwrap_or_default(),"instructionsPreview":skill.instructions.chars().take(250).collect::<String>(),"instructionsRevision":fingerprint(&skill.instructions),"packageRevision":package_revision(skill),"instructionsTruncated":skill.instructions.chars().count()>250,"supportFileCount":skill.support_files.len(),"supportBytes":skill.support_files.values().map(String::len).sum::<usize>()})
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Inspect {
    scope: Option<String>,
}

fn inspect(data: &Path, owner: &str, workspace: &Path, arguments: &Value) -> Result<Value, String> {
    let input: Inspect = parse(arguments)?;
    let scope = input.scope.as_deref().unwrap_or("both");
    if !["workspace", "account", "both"].contains(&scope) {
        return Err("Knowledge scope must be workspace, account, or both".into());
    }
    let mut result = json!({});
    for account in [false, true] {
        let name = if account { "account" } else { "workspace" };
        if scope != "both" && scope != name {
            continue;
        }
        let profile = profile(data, owner, workspace, account)?;
        let proposals = agent_proposals(
            data,
            owner,
            if account { None } else { Some(workspace) },
            None,
        )
        .map_err(|error| error.message)?;
        let proposals = proposals["proposals"].as_array().ok_or("Invalid saved proposals")?.iter().map(|proposal|json!({"id":proposal["id"],"title":proposal["title"],"reason":proposal["reason"].as_str().unwrap_or("").chars().take(300).collect::<String>(),"status":proposal["status"],"createdAt":proposal["createdAt"],"changes":proposal["operations"].as_array().map(Vec::len).unwrap_or(0)})).collect::<Vec<_>>();
        result[name] = json!({"memory":profile.memory,"skills":profile.skills.iter().map(|skill|skill_summary(skill,name)).collect::<Vec<_>>(),"proposals":proposals});
    }
    Ok(result)
}

fn discover(data: &Path, owner: &str, workspace: &Path) -> Result<Value, String> {
    let mut skills = Vec::new();
    for account in [false, true] {
        let scope = if account { "account" } else { "workspace" };
        for skill in profile(data, owner, workspace, account)?.skills {
            let mut row = skill_summary(&skill, scope);
            row.as_object_mut().unwrap().remove("instructions");
            row["description"] = json!(skill
                .instructions
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("")
                .chars()
                .take(250)
                .collect::<String>());
            row["readOnly"] = json!(false);
            skills.push(row);
        }
    }
    let discovered = crate::workspace_skills::project_skills(workspace);
    for skill in discovered.skills {
        skills.push(json!({"skillRef":format!("installed:{}",skill.id),"scope":"project","provider":skill.provider,"name":skill.name,"description":skill.instructions.lines().find(|line|!line.trim().is_empty()).unwrap_or("").chars().take(250).collect::<String>(),"readOnly":true,"instructionsRevision":fingerprint(&skill.instructions)}));
    }
    Ok(
        json!({"skills":skills,"warnings":discovered.warnings,"limits":{"ownedSkillsPerScope":20,"installedSkills":100}}),
    )
}

enum SkillSource {
    Owned(WorkspaceSkill),
    Installed(PathBuf),
}

fn source(
    data: &Path,
    owner: &str,
    workspace: &Path,
    reference: &str,
) -> Result<SkillSource, String> {
    let (scope, id) = reference.split_once(':').ok_or("Invalid skill reference")?;
    match scope {
        "workspace" | "account" => {
            let id = uuid::Uuid::parse_str(id).map_err(|_| "Invalid skill reference")?;
            let skill = profile(data, owner, workspace, scope == "account")?
                .skills
                .into_iter()
                .find(|skill| skill.id == id)
                .ok_or("Skill is unavailable in this account and workspace")?;
            Ok(SkillSource::Owned(skill))
        }
        "installed" if id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
            let skill = crate::workspace_skills::project_skills(workspace)
                .skills
                .into_iter()
                .find(|skill| skill.id == id)
                .ok_or("Installed skill is unavailable in the allowed project roots")?;
            let path = PathBuf::from(skill.path);
            Ok(SkillSource::Installed(
                path.parent().ok_or("Invalid skill directory")?.to_owned(),
            ))
        }
        _ => Err("Invalid skill reference".into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillFiles {
    skill_ref: String,
}

fn list_files(
    data: &Path,
    owner: &str,
    workspace: &Path,
    arguments: &Value,
) -> Result<Value, String> {
    let input: SkillFiles = parse(arguments)?;
    let mut files = Vec::new();
    let mut truncated = false;
    match source(data, owner, workspace, &input.skill_ref)? {
        SkillSource::Owned(skill) => {
            files.push(json!({"path":"SKILL.md","bytes":skill.instructions.len(),"revision":fingerprint(&skill.instructions)}));
            files.extend(skill.support_files.iter().map(|(path,content)|json!({"path":path,"bytes":content.len(),"revision":fingerprint(content)})));
        }
        SkillSource::Installed(root) => {
            let mut pending = vec![(root.clone(), 0)];
            let mut scanned = 0;
            while let Some((directory, depth)) = pending.pop() {
                let mut entries: Vec<_> = std::fs::read_dir(directory)
                    .map_err(|_| "Cannot list skill files")?
                    .take(201)
                    .filter_map(Result::ok)
                    .collect();
                entries.sort_by_key(|entry| entry.file_name());
                for entry in entries {
                    scanned += 1;
                    if scanned > 200 || files.len() >= 100 {
                        truncated = true;
                        break;
                    }
                    let relative = entry
                        .path()
                        .strip_prefix(&root)
                        .map_err(|_| "Invalid skill path")?
                        .to_string_lossy()
                        .into_owned();
                    if relative != "SKILL.md" && validate_support_path(&relative).is_err() {
                        continue;
                    }
                    let metadata = std::fs::symlink_metadata(entry.path())
                        .map_err(|_| "Cannot inspect skill file")?;
                    if metadata.file_type().is_symlink() {
                        continue;
                    }
                    if metadata.is_dir() {
                        if depth < 5 {
                            pending.push((entry.path(), depth + 1));
                        } else {
                            truncated = true;
                        }
                    } else if metadata.is_file() {
                        files.push(json!({"path":relative,"bytes":metadata.len(),"readable":metadata.len()<=FILE_BYTES}));
                    }
                }
                if scanned > 200 || files.len() >= 100 {
                    break;
                }
            }
            files.sort_by_key(|file| file["path"].as_str().unwrap_or("").to_owned());
        }
    }
    Ok(
        json!({"skillRef":input.skill_ref,"files":files,"truncated":truncated,"entryLimit":200,"fileLimit":100}),
    )
}

fn installed_file(root: &Path, relative: &str) -> Result<String, String> {
    if relative != "SKILL.md" {
        validate_support_path(relative).map_err(|error| error.message)?;
    }
    let mut path = root.to_owned();
    for component in Path::new(relative).components() {
        let Component::Normal(part) = component else {
            return Err("Invalid support path".into());
        };
        path.push(part);
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| "Skill file is unavailable")?;
        if metadata.file_type().is_symlink() {
            return Err("Skill symlinks are not allowed".into());
        }
    }
    let file = std::fs::File::open(path).map_err(|_| "Skill file is unavailable")?;
    if !file
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= FILE_BYTES)
    {
        return Err("Skill file is too large or not a regular file".into());
    }
    let mut text = String::new();
    file.take(FILE_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|_| "Skill file must be readable UTF-8")?;
    if text.len() as u64 > FILE_BYTES {
        return Err("Skill file exceeds 64000 bytes".into());
    }
    Ok(text)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadSkill {
    skill_ref: String,
    path: String,
    start_line: Option<usize>,
    lines: Option<usize>,
    char_offset: Option<usize>,
}

fn read_skill(
    data: &Path,
    owner: &str,
    workspace: &Path,
    arguments: &Value,
) -> Result<Value, String> {
    let input: ReadSkill = parse(arguments)?;
    let start = input.start_line.unwrap_or(1);
    let count = input.lines.unwrap_or(100);
    if start == 0 || count == 0 || count > 200 {
        return Err("Use a positive startLine and 1–200 lines".into());
    }
    if input.path != "SKILL.md" {
        validate_support_path(&input.path).map_err(|error| error.message)?;
    }
    let content = match source(data, owner, workspace, &input.skill_ref)? {
        SkillSource::Owned(skill) => {
            if input.path == "SKILL.md" {
                skill.instructions
            } else {
                skill
                    .support_files
                    .get(&input.path)
                    .cloned()
                    .ok_or("Skill support file is unavailable")?
            }
        }
        SkillSource::Installed(root) => installed_file(&root, &input.path)?,
    };
    let clean = safe_history_text(&content);
    let lines: Vec<_> = clean.lines().collect();
    if start > lines.len().max(1) {
        return Err("startLine is outside this skill file".into());
    }
    let mut remaining = WINDOW_CHARS;
    let mut rows = Vec::new();
    let mut truncated = false;
    for (index, line) in lines.iter().enumerate().skip(start - 1).take(count) {
        let offset = if index + 1 == start {
            input.char_offset.unwrap_or(0)
        } else {
            0
        };
        let total = line.chars().count();
        if offset > total {
            return Err("charOffset is outside the starting line".into());
        }
        let text = line
            .chars()
            .skip(offset)
            .take(remaining.min(4_000))
            .collect::<String>();
        let emitted = text.chars().count();
        remaining -= emitted;
        truncated |= offset > 0 || offset + emitted < total;
        rows.push(json!({"line":index+1,"text":text,"charOffset":offset,"nextCharOffset":if offset+emitted<total {Some(offset+emitted)} else {None}}));
        if remaining == 0 {
            truncated = true;
            break;
        }
    }
    let last = rows
        .last()
        .and_then(|row| row["line"].as_u64())
        .unwrap_or(start as u64 - 1) as usize;
    Ok(
        json!({"skillRef":input.skill_ref,"path":input.path,"reference":format!("v4://skill/{}/{}#line={start}",input.skill_ref,input.path),"revision":fingerprint(&content),"totalLines":lines.len(),"lines":rows,"nextLine":if last<lines.len(){Some(last+1)}else{None},"truncated":truncated}),
    )
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum SupportChange {
    SkillFileCreate {
        id: uuid::Uuid,
        path: String,
        content: String,
    },
    #[serde(rename_all = "camelCase")]
    SkillFileReplace {
        id: uuid::Uuid,
        path: String,
        before_revision: String,
        content: String,
    },
    #[serde(rename_all = "camelCase")]
    SkillFileDelete {
        id: uuid::Uuid,
        path: String,
        before_revision: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum RevisionChange {
    #[serde(rename_all = "camelCase")]
    SkillUpdate {
        id: uuid::Uuid,
        before_revision: String,
        name: Option<String>,
        instructions: Option<String>,
        support_files: Option<BTreeMap<String, String>>,
        activation: Option<crate::workspace::SkillActivation>,
    },
    #[serde(rename_all = "camelCase")]
    SkillRemove {
        id: uuid::Uuid,
        before_revision: String,
    },
}

fn support_update(skill: &WorkspaceSkill) -> Value {
    json!({"kind":"skillUpdate","id":skill.id,"beforeName":skill.name,"beforeInstructions":skill.instructions,"beforeActivation":skill.activation.unwrap_or_default(),"beforeSupportFiles":skill.support_files,"name":skill.name,"instructions":skill.instructions,"supportFiles":skill.support_files})
}

fn expand_proposal(profile: &WorkspaceProfile, mut proposal: Value) -> Result<Value, String> {
    let changes = proposal["operations"]
        .as_array()
        .ok_or("Proposal operations must be an array")?;
    if changes.is_empty() || changes.len() > 10 {
        return Err("Propose between 1 and 10 knowledge changes".into());
    }
    let mut operations = Vec::new();
    let mut packages = BTreeMap::<uuid::Uuid, usize>::new();
    let mut files = std::collections::HashSet::new();
    for change in changes {
        let kind = change["kind"]
            .as_str()
            .ok_or("Proposal operations require a kind")?;
        if kind.starts_with("skillFile") {
            let change: SupportChange = parse(change)?;
            let (id, path, expected, content) = match change {
                SupportChange::SkillFileCreate { id, path, content } => {
                    (id, path, None, Some(content))
                }
                SupportChange::SkillFileReplace {
                    id,
                    path,
                    before_revision,
                    content,
                } => (id, path, Some(before_revision), Some(content)),
                SupportChange::SkillFileDelete {
                    id,
                    path,
                    before_revision,
                } => (id, path, Some(before_revision), None),
            };
            validate_support_path(&path).map_err(|error| error.message)?;
            if !files.insert((id, path.to_lowercase())) {
                return Err("Change each support path only once in a proposal".into());
            }
            let skill = profile
                .skills
                .iter()
                .find(|skill| skill.id == id)
                .ok_or("Owned skill package was removed or is unavailable")?;
            let previous = skill.support_files.get(&path);
            match expected {
                Some(expected) if previous.is_none_or(|previous|fingerprint(previous)!=expected)=>return Err("Support file changed; list/read a fresh revision before proposing its change".into()),
                None if previous.is_some()=>return Err("Support file already exists; replace it with its current revision".into()),
                _=>{},
            }
            let index = *packages.entry(id).or_insert_with(|| {
                let index = operations.len();
                operations.push(support_update(skill));
                index
            });
            let support = operations[index]["supportFiles"]
                .as_object_mut()
                .ok_or("Invalid support package")?;
            if let Some(content) = content {
                support.insert(path, json!(content));
            } else {
                support.remove(&path);
            }
        } else if matches!(kind, "skillUpdate" | "skillRemove")
            && change.get("beforeRevision").is_some()
        {
            let change: RevisionChange = parse(change)?;
            let (id, expected) = match &change {
                RevisionChange::SkillUpdate {
                    id,
                    before_revision,
                    ..
                }
                | RevisionChange::SkillRemove {
                    id,
                    before_revision,
                } => (*id, before_revision),
            };
            let skill = profile
                .skills
                .iter()
                .find(|skill| skill.id == id)
                .ok_or("Owned skill package was removed or is unavailable")?;
            if package_revision(skill) != *expected {
                return Err("Skill package changed; inspect a fresh packageRevision before proposing its change".into());
            }
            operations.push(match change {
                RevisionChange::SkillRemove{..}=>json!({"kind":"skillRemove","id":skill.id,"beforeName":skill.name,"beforeInstructions":skill.instructions,"beforeActivation":skill.activation.unwrap_or_default(),"beforeSupportFiles":skill.support_files}),
                RevisionChange::SkillUpdate{name,instructions,support_files,activation,..}=>{
                    let mut operation=support_update(skill);
                    if let Some(name)=name {operation["name"]=json!(name);}
                    if let Some(instructions)=instructions {operation["instructions"]=json!(instructions);}
                    if let Some(support_files)=support_files {operation["supportFiles"]=json!(support_files);}
                    if let Some(activation)=activation {operation["activation"]=json!(activation);}
                    operation
                },
            });
        } else {
            operations.push(change.clone());
        }
    }
    proposal["operations"] = json!(operations);
    Ok(proposal)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Propose {
    scope: String,
    proposal: Value,
}

fn contains_sensitive_text(value: &Value) -> bool {
    match value {
        Value::String(text) => {
            safe_history_text(text) != text.lines().collect::<Vec<_>>().join("\n")
        }
        Value::Array(values) => values.iter().any(contains_sensitive_text),
        Value::Object(values) => values.values().any(contains_sensitive_text),
        _ => false,
    }
}

fn propose(data: &Path, owner: &str, workspace: &Path, arguments: &Value) -> Result<Value, String> {
    let input: Propose = parse(arguments)?;
    let target = match input.scope.as_str() {
        "workspace" => Some(workspace),
        "account" => None,
        _ => return Err("Proposal scope must be workspace or account".into()),
    };
    if contains_sensitive_text(&input.proposal) {
        return Err(
            "Remove credentials and terminal control sequences before proposing knowledge".into(),
        );
    }
    let profile = profile(data, owner, workspace, target.is_none())?;
    let proposal = expand_proposal(&profile, input.proposal)?;
    let mut result =
        agent_proposals(data, owner, target, Some(proposal)).map_err(|error| error.message)?;
    result["scope"] = json!(input.scope);
    result["proposal"] = json!({"id":result["proposal"]["id"],"title":result["proposal"]["title"],"status":result["proposal"]["status"],"createdAt":result["proposal"]["createdAt"],"changes":result["proposal"]["operations"].as_array().map(Vec::len).unwrap_or(0)});
    result["reviewRequired"] = json!(true);
    result["reviewLocation"] = json!(if target.is_some() {
        "Workspace knowledge > Learning"
    } else {
        "Account knowledge > Learning"
    });
    Ok(result)
}

pub(super) fn dispatch(
    data_dir: &Path,
    owner: &str,
    workspace: &Path,
    name: &str,
    arguments: &Value,
) -> Result<String, String> {
    if owner.is_empty() || owner.len() > 512 || owner.chars().any(char::is_control) {
        return Err("Invalid account".into());
    }
    if !workspace.is_absolute()
        || !workspace.is_dir()
        || std::fs::canonicalize(workspace).map_err(|_| "Workspace unavailable")? != workspace
    {
        return Err("A canonical workspace directory is required".into());
    }
    checked_storage_path(data_dir, &super::directory(data_dir, owner, workspace))?;
    let result = match name {
        "recall_sessions" => recall(data_dir, owner, workspace, arguments),
        "read_session" => read_session(data_dir, owner, workspace, arguments),
        "read_context_archive" => {
            super::compaction::read_source(data_dir, owner, workspace, arguments)
        }
        "inspect_knowledge" => inspect(data_dir, owner, workspace, arguments),
        "discover_skills" => {
            let _: BTreeMap<String, Value> = parse(arguments)?;
            if arguments.as_object().is_none_or(|map| !map.is_empty()) {
                return Err("discover_skills accepts no arguments".into());
            }
            discover(data_dir, owner, workspace)
        }
        "list_skill_files" => list_files(data_dir, owner, workspace, arguments),
        "read_skill_file" => read_skill(data_dir, owner, workspace, arguments),
        "propose_knowledge" => propose(data_dir, owner, workspace, arguments),
        _ => Err("Unknown knowledge tool".into()),
    }?;
    Ok(redacted(result).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recall_ranks_best_redacted_match_and_preserves_readable_references() {
        let data = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path().canonicalize().unwrap();
        let mut unordered = super::super::new_session("openai-api", "fixture", &workspace);
        unordered.messages.push(super::super::Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "deploy the blue service".into(),
        });
        super::super::save(data.path(), "owner", &mut unordered).unwrap();
        let mut exact = super::super::new_session("openai-api", "fixture", &workspace);
        exact.messages = vec![
            super::super::Message {
                attachments: Vec::new(),
                role: "user".into(),
                text: "blue service deploy".into(),
            },
            super::super::Message {
                attachments: Vec::new(),
                role: "assistant".into(),
                text: "deploy blue service
API_KEY=fixture-secret"
                    .into(),
            },
        ];
        super::super::save(data.path(), "owner", &mut exact).unwrap();
        let result = recall(
            data.path(),
            "owner",
            &workspace,
            &json!({"query":"deploy blue service"}),
        )
        .unwrap();
        let rows = result["sessions"].as_array().unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| row["sessionId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![exact.id.as_str(), unordered.id.as_str()]
        );
        assert_eq!(rows[0]["anchor"], 2);
        assert_eq!(
            rows[0]["reference"],
            session_reference(
                history::Source::V4,
                &exact.id,
                &workspace.to_string_lossy(),
                2
            )
        );
        assert!(!result.to_string().contains("fixture-secret"));
        assert_eq!(
            recall(
                data.path(),
                "owner",
                &workspace,
                &json!({"query":"fixture-secret"})
            )
            .unwrap()["sessions"],
            json!([])
        );
        let read = read_session(
            data.path(),
            "owner",
            &workspace,
            &json!({"sessionId":exact.id,"anchor":2,"fingerprint":rows[0]["fingerprint"]}),
        )
        .unwrap();
        assert!(read["messages"].to_string().contains("deploy blue service"));
        assert!(read_session(
            data.path(),
            "other",
            &workspace,
            &json!({"sessionId":exact.id,"anchor":2})
        )
        .is_err());
    }

    #[test]
    fn recall_continues_candidate_offsets_without_skipping_matching_sessions() {
        let data = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path().canonicalize().unwrap();
        let mut expected = Vec::new();
        for index in 0..3 {
            let mut session = super::super::new_session("openai-api", "fixture", &workspace);
            session.messages.push(super::super::Message {
                attachments: Vec::new(),
                role: "user".into(),
                text: format!("needle {index}"),
            });
            super::super::save(data.path(), "owner", &mut session).unwrap();
            expected.push(session.id);
        }
        let mut actual = Vec::new();
        let mut offset = 0;
        loop {
            let page = recall(
                data.path(),
                "owner",
                &workspace,
                &json!({"query":"needle", "limit":1, "offset":offset}),
            )
            .unwrap();
            actual.extend(
                page["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| row["sessionId"].as_str().unwrap().to_owned()),
            );
            match page["nextOffset"].as_u64() {
                Some(next) => {
                    assert!(next as usize > offset);
                    offset = next as usize;
                }
                None => break,
            }
        }
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected);
    }

    #[test]
    fn ranked_recall_scans_the_bounded_window_and_pages_without_skipping() {
        let data = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path().canonicalize().unwrap();
        let mut exact = super::super::new_session("openai-api", "fixture", &workspace);
        exact.messages.push(super::super::Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "deploy blue service".into(),
        });
        super::super::save(data.path(), "owner", &mut exact).unwrap();
        let mut unordered = super::super::new_session("openai-api", "fixture", &workspace);
        unordered.messages.push(super::super::Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "deploy the blue service".into(),
        });
        super::super::save(data.path(), "owner", &mut unordered).unwrap();
        let (candidates, _, _, _) = history::candidates(data.path(), "owner", &workspace, false, 0);
        for candidate in candidates {
            let newer = candidate.path.file_stem().unwrap() == unordered.id.as_str();
            std::fs::File::open(candidate.path)
                .unwrap()
                .set_modified(
                    std::time::SystemTime::UNIX_EPOCH
                        + std::time::Duration::from_secs(if newer { 200 } else { 100 }),
                )
                .unwrap();
        }
        let first: Value = serde_json::from_str(
            &dispatch(
                data.path(),
                "owner",
                &workspace,
                "recall_sessions",
                &json!({"query":"deploy blue service", "limit":1, "rankWindow":true}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            (
                first["sessions"][0]["sessionId"].as_str(),
                first["scanned"].as_u64(),
                first["nextResultOffset"].as_u64(),
                first["nextOffset"].as_u64()
            ),
            (Some(exact.id.as_str()), Some(2), Some(1), None)
        );
        let revision = first["windowRevision"].as_str().unwrap();
        let next: Value = serde_json::from_str(&dispatch(data.path(), "owner", &workspace, "recall_sessions", &json!({"query":"deploy blue service", "limit":1, "rankWindow":true, "resultOffset":1, "windowRevision":revision})).unwrap()).unwrap();
        assert_eq!(
            (
                next["sessions"][0]["sessionId"].as_str(),
                next["nextResultOffset"].as_u64(),
                next["nextOffset"].as_u64()
            ),
            (Some(unordered.id.as_str()), None, None)
        );
        assert!(recall(
            data.path(),
            "owner",
            &workspace,
            &json!({"query":"deploy blue service", "limit":1, "rankWindow":true, "resultOffset":1})
        )
        .is_err());
        assert!(recall(data.path(), "other", &workspace, &json!({"query":"deploy blue service", "limit":1, "rankWindow":true, "resultOffset":1, "windowRevision":revision})).is_err());
        unordered.messages[0].text.push_str(" changed");
        super::super::save(data.path(), "owner", &mut unordered).unwrap();
        assert!(recall(data.path(), "owner", &workspace, &json!({"query":"deploy blue service", "limit":1, "rankWindow":true, "resultOffset":1, "windowRevision":revision})).is_err());
    }

    #[test]
    fn ranked_recall_advances_candidate_windows_only_after_results_are_read() {
        let data = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path().canonicalize().unwrap();
        let mut expected = Vec::new();
        for index in 0..51 {
            let mut session = super::super::new_session("openai-api", "fixture", &workspace);
            session.messages.push(super::super::Message {
                attachments: Vec::new(),
                role: "user".into(),
                text: format!("needle {index}"),
            });
            super::super::save(data.path(), "owner", &mut session).unwrap();
            expected.push(session.id);
        }
        let first = recall(
            data.path(),
            "owner",
            &workspace,
            &json!({"query":"needle", "limit":25, "rankWindow":true}),
        )
        .unwrap();
        assert_eq!(
            (
                first["scanned"].as_u64(),
                first["nextResultOffset"].as_u64(),
                first["nextOffset"].as_u64()
            ),
            (Some(50), Some(25), None)
        );
        let revision = first["windowRevision"].as_str().unwrap();
        let second = recall(data.path(), "owner", &workspace, &json!({"query":"needle", "limit":25, "rankWindow":true, "resultOffset":25, "windowRevision":revision})).unwrap();
        assert_eq!(
            (
                second["nextResultOffset"].as_u64(),
                second["nextOffset"].as_u64()
            ),
            (None, Some(50))
        );
        let third = recall(
            data.path(),
            "owner",
            &workspace,
            &json!({"query":"needle", "limit":25, "rankWindow":true, "offset":50}),
        )
        .unwrap();
        assert_eq!(
            (third["scanned"].as_u64(), third["nextOffset"].as_u64()),
            (Some(1), None)
        );
        let mut actual = [&first, &second, &third]
            .into_iter()
            .flat_map(|page| {
                page["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| row["sessionId"].as_str().unwrap().to_owned())
            })
            .collect::<Vec<_>>();
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected);
        assert!(recall(data.path(), "owner", &workspace, &json!({"resultOffset":1})).is_err());
        assert!(recall(
            data.path(),
            "owner",
            &workspace,
            &json!({"rankWindow":true, "resultOffset":51, "windowRevision":revision})
        )
        .is_err());
        assert!(recall(data.path(), "owner", &workspace, &json!({"query":"changed", "limit":25, "rankWindow":true, "resultOffset":25, "windowRevision":revision})).is_err());
    }

    #[test]
    fn recall_filters_source_provider_model_and_message_role_without_losing_pagination() {
        let data = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path().canonicalize().unwrap();
        let mut session = super::super::new_session("openai-api", "fixture-model", &workspace);
        session.messages = vec![
            super::super::Message {
                attachments: Vec::new(),
                role: "user".into(),
                text: "needle user".into(),
            },
            super::super::Message {
                attachments: Vec::new(),
                role: "assistant".into(),
                text: "needle assistant".into(),
            },
        ];
        super::super::save(data.path(), "owner", &mut session).unwrap();
        let args = json!({"query":"needle", "source":"v4", "provider":"OPENAI-API", "model":"fixture-model", "role":"assistant", "limit":1});
        let result = recall(data.path(), "owner", &workspace, &args).unwrap();
        assert_eq!(
            (
                result["sessions"][0]["sessionId"].clone(),
                result["sessions"][0]["anchor"].clone(),
                result["nextOffset"].clone()
            ),
            (json!(session.id), json!(2), Value::Null)
        );
        for filter in [
            json!({"source":"imported"}),
            json!({"provider":"other"}),
            json!({"model":"other"}),
            json!({"role":"tool"}),
        ] {
            assert_eq!(
                recall(data.path(), "owner", &workspace, &filter).unwrap()["sessions"],
                json!([])
            );
        }
        assert_eq!(
            recall(
                data.path(),
                "owner",
                &workspace,
                &json!({"query":"needle user", "role":"assistant"})
            )
            .unwrap()["sessions"],
            json!([])
        );
        for filter in [
            json!({"source":"invalid"}),
            json!({"role":"invalid"}),
            json!({"provider":""}),
            json!({"model":"bad\nmodel"}),
        ] {
            assert!(recall(data.path(), "owner", &workspace, &filter).is_err());
        }
    }

    #[test]
    fn recall_filters_update_time_with_explicit_bounds_and_reports_unknown_dates() {
        let data = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path().canonicalize().unwrap();
        let mut expected = String::new();
        for (date, matches) in [
            ("2026-01-01T23:59:59Z", false),
            ("2026-01-02T00:00:00Z", true),
            ("2026-01-03T00:00:00Z", false),
            ("invalid-date", false),
        ] {
            let mut session = super::super::new_session("openai-api", "fixture", &workspace);
            session.updated_at = date.into();
            session.messages.push(super::super::Message {
                attachments: Vec::new(),
                role: "user".into(),
                text: "needle".into(),
            });
            super::super::save(data.path(), "owner", &mut session).unwrap();
            if matches {
                expected = session.id;
            }
        }
        let input = json!({"query":"needle", "rankWindow":true, "updatedAfter":"2026-01-01T19:00:00-05:00", "updatedBefore":"2026-01-03"});
        let result = recall(data.path(), "owner", &workspace, &input).unwrap();
        assert_eq!(
            (
                result["sessions"].as_array().unwrap().len(),
                result["sessions"][0]["sessionId"].as_str(),
                result["undated"].as_u64()
            ),
            (1, Some(expected.as_str()), Some(1))
        );
        assert_eq!(
            recall(
                data.path(),
                "owner",
                &workspace,
                &json!({"query":"needle", "rankWindow":true})
            )
            .unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        for bounds in [
            json!({"updatedAfter":"tomorrow"}),
            json!({"updatedBefore":"2026-02-30"}),
            json!({"updatedAfter":"2026-01-03", "updatedBefore":"2026-01-02"}),
        ] {
            assert!(recall(data.path(), "owner", &workspace, &bounds).is_err());
        }
    }

    #[test]
    fn knowledge_tools_expose_anchored_recall_and_review_only_changes() {
        let names: Vec<_> = definitions()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            names,
            vec![
                "recall_sessions",
                "read_session",
                "read_context_archive",
                "inspect_knowledge",
                "discover_skills",
                "list_skill_files",
                "read_skill_file",
                "propose_knowledge"
            ]
        );
        let recall = definitions()
            .into_iter()
            .find(|tool| tool["name"] == "recall_sessions")
            .unwrap();
        for filter in [
            "source",
            "provider",
            "model",
            "role",
            "rankWindow",
            "resultOffset",
            "windowRevision",
        ] {
            assert!(recall["parameters"]["properties"].get(filter).is_some());
        }
        assert!(!handles("accept_knowledge"));
    }

    #[test]
    fn recall_is_owner_and_workspace_scoped_and_redacts_credentials() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let mut session = super::super::new_session("openai-api", "fixture", &workspace);
        session.messages = vec![
            super::super::Message {
                attachments: Vec::new(),
                role: "user".into(),
                text: "Resolve orange fixture".into(),
            },
            super::super::Message {
                attachments: Vec::new(),
                role: "assistant".into(),
                text: "Found orange result\nAPI_KEY=never-expose-this".into(),
            },
        ];
        super::super::save(data.path(), "owner", &mut session).unwrap();
        let result: Value = serde_json::from_str(
            &dispatch(
                data.path(),
                "owner",
                &workspace,
                "recall_sessions",
                &json!({"query":"orange"}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(result["sessions"][0]["sessionId"], session.id);
        assert_eq!(result["sessions"][0]["anchor"], 1);
        let text = dispatch(
            data.path(),
            "owner",
            &workspace,
            "read_session",
            &json!({"sessionId":session.id,"anchor":2,"before":0,"after":0}),
        )
        .unwrap();
        assert!(text.contains("[redacted]"));
        assert!(!text.contains("never-expose-this"));
        assert!(dispatch(
            data.path(),
            "other",
            &workspace,
            "read_session",
            &json!({"sessionId":session.id,"anchor":1})
        )
        .is_err());
        let other = tempfile::tempdir().unwrap();
        assert!(dispatch(
            data.path(),
            "owner",
            &std::fs::canonicalize(other.path()).unwrap(),
            "read_session",
            &json!({"sessionId":session.id,"anchor":1})
        )
        .is_err());
    }

    #[test]
    fn read_session_continuation_is_anchored_and_rejects_stale_revisions() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let mut session = super::super::new_session("openai-api", "fixture", &workspace);
        session.messages.push(super::super::Message {
            attachments: Vec::new(),
            role: "assistant".into(),
            text: format!("{}FINAL", "é".repeat(9_000)),
        });
        super::super::save(data.path(), "owner", &mut session).unwrap();
        let first = read_session(
            data.path(),
            "owner",
            &workspace,
            &json!({"sessionId":session.id,"anchor":1,"before":0,"after":0}),
        )
        .unwrap();
        assert_eq!(first["messages"][0]["nextCharOffset"], 8_000);
        let next = read_session(data.path(),"owner",&workspace,&json!({"sessionId":session.id,"anchor":1,"before":0,"after":0,"charOffset":8_000,"fingerprint":first["fingerprint"]})).unwrap();
        assert!(next["messages"][0]["text"]
            .as_str()
            .unwrap()
            .ends_with("FINAL"));
        assert_eq!(next["messages"][0]["nextCharOffset"], Value::Null);
        assert!(read_session(
            data.path(),
            "owner",
            &workspace,
            &json!({"sessionId":session.id,"anchor":1,"fingerprint":"stale"})
        )
        .is_err());
        assert!(read_session(
            data.path(),
            "owner",
            &workspace,
            &json!({"sessionId":session.id,"anchor":0})
        )
        .is_err());
    }

    fn synthetic_legacy_owner(data: &Path) {
        let db = rusqlite::Connection::open(data.join("terminal.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users(id) VALUES('owner');",
        )
        .unwrap();
    }

    fn owned_fixture(data: &Path, owner: &str, workspace: &Path, account: bool) -> WorkspaceSkill {
        let skill:WorkspaceSkill = serde_json::from_value(json!({"id":uuid::Uuid::new_v4(),"name":"Fixture review","instructions":"Check synthetic changes.","supportFiles":{"scripts/check.py":"print('fixture')\n","references/guide.md":"Fixture guide\nAPI_KEY=fixture-secret"}})).unwrap();
        let path = if account {
            account_profile_path(data, owner)
        } else {
            profile_path(data, owner, &workspace.to_string_lossy()).unwrap()
        };
        crate::workspace::write_profile(
            &path,
            &WorkspaceProfile {
                memory: "Synthetic memory".into(),
                skills: vec![skill.clone()],
                ..Default::default()
            },
        )
        .unwrap();
        skill
    }

    #[test]
    fn on_demand_discovery_is_account_scoped_and_revision_tracks_activation() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let mut skill = owned_fixture(data.path(), "owner", &workspace, true);
        let old_revision = package_revision(&skill);
        skill.activation = Some(crate::workspace::SkillActivation::OnDemand);
        assert_ne!(old_revision, package_revision(&skill));
        let path = account_profile_path(data.path(), "owner");
        let mut saved = crate::workspace::read_profile(&path).unwrap();
        saved.skills[0] = skill.clone();
        crate::workspace::write_profile(&path, &saved).unwrap();
        let row = discover(data.path(), "owner", &workspace).unwrap()["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["skillRef"] == format!("account:{}", skill.id))
            .unwrap()
            .clone();
        assert_eq!(row["activation"], "onDemand");
        let reference = row["skillRef"].as_str().unwrap();
        assert!(read_skill(
            data.path(),
            "owner",
            &workspace,
            &json!({"skillRef":reference,"path":"scripts/check.py"})
        )
        .is_ok());
        assert!(read_skill(
            data.path(),
            "other",
            &workspace,
            &json!({"skillRef":reference,"path":"scripts/check.py"})
        )
        .is_err());
        let stale = json!({"operations":[{"kind":"skillRemove","id":skill.id,"beforeRevision":old_revision}]});
        assert!(expand_proposal(&saved, stale).is_err());
    }
    #[test]
    fn owned_support_files_are_addressable_redacted_and_isolated() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let skill = owned_fixture(data.path(), "owner", &workspace, false);
        let reference = format!("workspace:{}", skill.id);
        let files = list_files(
            data.path(),
            "owner",
            &workspace,
            &json!({"skillRef":reference}),
        )
        .unwrap();
        assert_eq!(
            files["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["path"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["SKILL.md", "references/guide.md", "scripts/check.py"]
        );
        let output = dispatch(
            data.path(),
            "owner",
            &workspace,
            "read_skill_file",
            &json!({"skillRef":reference,"path":"references/guide.md"}),
        )
        .unwrap();
        assert!(output.contains("Fixture guide"));
        assert!(!output.contains("fixture-secret"));
        assert!(list_files(
            data.path(),
            "other",
            &workspace,
            &json!({"skillRef":reference})
        )
        .is_err());
        assert!(read_skill(
            data.path(),
            "owner",
            &workspace,
            &json!({"skillRef":reference,"path":"../outside"})
        )
        .is_err());
        assert!(read_skill(
            data.path(),
            "owner",
            &workspace,
            &json!({"skillRef":reference,"path":"scripts/check.py","unexpected":true})
        )
        .is_err());
        let account = owned_fixture(data.path(), "owner", &workspace, true);
        let other_workspace = tempfile::tempdir().unwrap();
        let other_workspace = std::fs::canonicalize(other_workspace.path()).unwrap();
        assert!(list_files(
            data.path(),
            "owner",
            &other_workspace,
            &json!({"skillRef":format!("account:{}",account.id)})
        )
        .is_ok());
        assert!(list_files(
            data.path(),
            "other",
            &other_workspace,
            &json!({"skillRef":format!("account:{}",account.id)})
        )
        .is_err());
    }

    #[test]
    fn recall_covers_only_owned_app_transcripts_with_source_attribution_and_cross_workspace_scope()
    {
        let data = tempfile::tempdir().unwrap();
        synthetic_legacy_owner(data.path());
        let workspace = tempfile::tempdir().unwrap();
        let other_workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let other_workspace = std::fs::canonicalize(other_workspace.path()).unwrap();
        let mut v4 = super::super::new_session("openai-api", "fixture", &workspace);
        v4.messages.push(super::super::Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "needle V4 fixture".into(),
        });
        super::super::save(data.path(), "owner", &mut v4).unwrap();
        let write = |path: PathBuf, body: Value| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body.to_string()).unwrap();
        };
        write(
            data.path()
                .join("users/owner/sessions/terminal-fixture.json"),
            json!({"id":"terminal-fixture","title":"Terminal fixture","cwd":workspace,"shell":"sh","updatedAt":"2026-10-17T10:00:00Z","history":[{"text":"needle terminal fixture\nAPI_","ts":1,"seq":1},{"text":"KEY=fixture-secret","ts":2,"seq":2}]}),
        );
        write(
            data.path().join("users/owner/structured/ss-fixture.json"),
            json!({"id":"ss-fixture","title":"Structured fixture","cwd":workspace,"provider":"claude","updatedAt":"2026-10-17T11:00:00Z","events":[{"type":"message_completed","role":"user","content":"needle structured fixture","seq":1,"ts":1},{"type":"tool_output","output":"never-recall-tool-payload","seq":2,"ts":2}]}),
        );
        write(
            data.path()
                .join("users/owner/sessions/other-workspace.json"),
            json!({"id":"other-workspace","title":"Other fixture","cwd":other_workspace,"updatedAt":"2026-10-17T09:00:00Z","history":[{"text":"needle other workspace","ts":1}]}),
        );
        let imported = "a".repeat(64);
        let native = data
            .path()
            .join("native-history")
            .join(hex::encode(Sha256::digest(b"owner")))
            .join(hex::encode(Sha256::digest(
                crate::session_search::normalize_workspace_path(&workspace.to_string_lossy())
                    .as_bytes(),
            )))
            .join(format!("{imported}.json"));
        write(
            native,
            json!({"sourceId":imported,"provider":"codex","workspacePath":workspace,"title":"Imported fixture","messages":[{"role":"assistant","text":"needle imported fixture"}],"truncated":false}),
        );
        let current = recall(data.path(), "owner", &workspace, &json!({"query":"needle"})).unwrap();
        let mut sources = current["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["source"].as_str().unwrap())
            .collect::<Vec<_>>();
        sources.sort();
        assert_eq!(sources, vec!["imported", "structured", "terminal", "v4"]);
        let terminal = read_session(
            data.path(),
            "owner",
            &workspace,
            &json!({"source":"terminal","sessionId":"terminal-fixture","anchor":1}),
        )
        .unwrap();
        assert_eq!(terminal["messages"][0]["role"], "terminal");
        assert!(!dispatch(
            data.path(),
            "owner",
            &workspace,
            "read_session",
            &json!({"source":"terminal","sessionId":"terminal-fixture","anchor":1})
        )
        .unwrap()
        .contains("fixture-secret"));
        let structured = read_session(
            data.path(),
            "owner",
            &workspace,
            &json!({"source":"structured","sessionId":"ss-fixture","anchor":1}),
        )
        .unwrap();
        assert_eq!(structured["totalMessages"], 1);
        assert!(!structured.to_string().contains("never-recall-tool-payload"));
        let all = recall(
            data.path(),
            "owner",
            &workspace,
            &json!({"query":"needle","scope":"account"}),
        )
        .unwrap();
        assert_eq!(all["sessions"].as_array().unwrap().len(), 5);
        assert!(read_session(
            data.path(),
            "owner",
            &workspace,
            &json!({"source":"terminal","sessionId":"other-workspace","anchor":1})
        )
        .is_err());
        assert!(read_session(data.path(),"owner",&workspace,&json!({"source":"terminal","sessionId":"other-workspace","workspacePath":other_workspace,"anchor":1})).is_ok());
        assert_eq!(
            recall(
                data.path(),
                "other",
                &workspace,
                &json!({"scope":"account"})
            )
            .unwrap()["sessions"],
            json!([])
        );
        assert!(read_session(
            data.path(),
            "other",
            &workspace,
            &json!({"source":"imported","sessionId":imported,"anchor":1})
        )
        .is_err());
        assert!(read_session(
            data.path(),
            "own_er",
            &workspace,
            &json!({"source":"terminal","sessionId":"terminal-fixture","anchor":1})
        )
        .is_err());
    }

    #[tokio::test]
    async fn real_provider_tool_loop_stages_knowledge_for_review_and_uses_account_context() {
        use axum::{routing::post, Json};
        use std::sync::{Arc, Mutex};
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = calls.clone();
        let proposal = json!({"id":uuid::Uuid::new_v4(),"title":"Fixture memory","reason":"Local provider fixture","operations":[{"kind":"memoryAppend","content":"Verified synthetic fact"}]});
        let router=axum::Router::new().route("/v1/chat/completions",post(move |Json(body):Json<Value>| {
            let calls=captured.clone();let proposal=proposal.clone();async move {
                let mut calls=calls.lock().unwrap();calls.push(body);
                let tool=match calls.len() {
                    1=>Some(("stage", "propose_knowledge",json!({"scope":"workspace","proposal":proposal}))),
                    2=>Some(("inspect","inspect_knowledge",json!({"scope":"workspace"}))),
                    _=>None,
                };
                Json(match tool {Some((id,name,args))=>json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":id,"type":"function","function":{"name":name,"arguments":args.to_string()}}]}}]}),None=>json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Knowledge staged for human review"}}]})})
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let provider = super::super::Provider {
            #[cfg(unix)]
            profile: None,
            transport: "openai-chat".into(),
            url: format!("http://{addr}/v1/chat/completions"),
            secret: "fixture-only".into(),
            client: reqwest::Client::new(),
        };
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        crate::workspace::write_profile(
            &account_profile_path(data.path(), "owner"),
            &WorkspaceProfile {
                memory: "Account fixture context".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let mut session = super::super::new_session("openai-api", "fixture", &workspace);
        assert_eq!(
            super::super::turn(
                &provider,
                data.path(),
                "owner",
                &mut session,
                "Remember the verified fact",
                None,
                false
            )
            .await
            .unwrap(),
            "Knowledge staged for human review"
        );
        assert_eq!(
            profile(data.path(), "owner", &workspace, false)
                .unwrap()
                .memory,
            ""
        );
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert!(calls[0]["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("Account fixture context"));
        assert!(calls[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "recall_sessions"));
        let staged: Value = serde_json::from_str(
            calls[1]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(staged["reviewRequired"], true);
        let inspected: Value = serde_json::from_str(
            calls[2]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(inspected["workspace"]["proposals"][0]["status"], "pending");
        assert_eq!(inspected["workspace"]["memory"], "");
        server.abort();
    }

    #[test]
    fn ranked_time_filter_rejects_changed_bounds_and_fallback_timestamps() {
        let data = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path().canonicalize().unwrap();
        synthetic_legacy_owner(data.path());
        let directory = data.path().join("users/owner/sessions");
        std::fs::create_dir_all(&directory).unwrap();
        for index in 0..2 {
            let path = directory.join(format!("terminal-{index}.json"));
            std::fs::write(&path, json!({"id":format!("terminal-{index}"),"cwd":workspace,"history":[{"text":"needle"}]}).to_string()).unwrap();
            std::fs::File::open(path)
                .unwrap()
                .set_modified(
                    std::time::SystemTime::UNIX_EPOCH
                        + std::time::Duration::from_secs(100 + index * 100),
                )
                .unwrap();
        }
        let first: Value = serde_json::from_str(&dispatch(data.path(), "owner", &workspace, "recall_sessions", &json!({"query":"needle","limit":1,"rankWindow":true,"updatedAfter":"1970-01-01","updatedBefore":"1970-01-02"})).unwrap()).unwrap();
        assert_eq!(first["nextResultOffset"], 1);
        let revision = first["windowRevision"].as_str().unwrap();
        let next = json!({"query":"needle","limit":1,"rankWindow":true,"updatedAfter":"1970-01-01","updatedBefore":"1970-01-02","resultOffset":1,"windowRevision":revision});
        assert_eq!(
            recall(data.path(), "owner", &workspace, &next).unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut changed = next.clone();
        changed["updatedBefore"] = json!("1970-01-03");
        assert!(recall(data.path(), "owner", &workspace, &changed).is_err());
        std::fs::File::open(directory.join("terminal-0.json"))
            .unwrap()
            .set_modified(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(101))
            .unwrap();
        assert!(recall(data.path(), "owner", &workspace, &next).is_err());
    }

    #[test]
    fn recall_paginates_within_its_byte_budget_even_without_matches() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        synthetic_legacy_owner(data.path());
        let directory = data.path().join("users/owner/sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let text = "x:".repeat(1_500_000);
        for index in 0..7 {
            std::fs::write(directory.join(format!("terminal-{index}.json")),json!({"id":format!("terminal-{index}"),"title":"Fixture","cwd":workspace,"history":[{"text":text}]}).to_string()).unwrap();
        }
        let page = recall_with_budget(
            data.path(),
            "owner",
            &workspace,
            &json!({"query":"absent"}),
            16_000_000,
        )
        .unwrap();
        assert_eq!(page["sessions"], json!([]));
        assert_eq!(page["scanned"], 5);
        assert_eq!(page["nextOffset"], 5);
        assert!(page["scannedBytes"].as_u64().unwrap() <= history::SCAN_BYTES);
        let next = recall_with_budget(
            data.path(),
            "owner",
            &workspace,
            &json!({"query":"absent","offset":5}),
            16_000_000,
        )
        .unwrap();
        assert_eq!(next["scanned"], 2);
        assert_eq!(next["nextOffset"], Value::Null);
    }

    #[test]
    fn recall_skips_a_candidate_larger_than_the_entire_scan_budget() {
        let data = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path().canonicalize().unwrap();
        synthetic_legacy_owner(data.path());
        let directory = data.path().join("users/owner/sessions");
        std::fs::create_dir_all(&directory).unwrap();
        for (id, content, modified) in [
            ("oversized", "x".repeat(2_000), 200),
            ("smaller", "needle".to_owned(), 100),
        ] {
            let path = directory.join(format!("{id}.json"));
            std::fs::write(
                &path,
                json!({"id":id,"title":"Fixture","cwd":workspace,"history":[{"text":content}]})
                    .to_string(),
            )
            .unwrap();
            std::fs::File::open(path)
                .unwrap()
                .set_modified(
                    std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(modified),
                )
                .unwrap();
        }
        for ranked in [false, true] {
            let page = recall_with_budget(
                data.path(),
                "owner",
                &workspace,
                &json!({"query":"needle", "rankWindow":ranked}),
                1_000,
            )
            .unwrap();
            assert_eq!(
                (
                    page["sessions"][0]["sessionId"].as_str(),
                    page["scanned"].as_u64(),
                    page["unreadable"].as_u64(),
                    page["nextOffset"].as_u64()
                ),
                (Some("smaller"), Some(2), Some(1), None)
            );
            assert!(page["scannedBytes"].as_u64().unwrap() <= 1_000);
        }
    }

    #[test]
    fn recall_skips_an_expanded_transcript_larger_than_the_entire_scan_budget() {
        let data = tempfile::tempdir().unwrap();
        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = workspace_dir.path().canonicalize().unwrap();
        let mut oversized = super::super::new_session("openai-api", "fixture", &workspace);
        oversized.messages.push(super::super::Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "x".repeat(150_000),
        });
        super::super::save(data.path(), "owner", &mut oversized).unwrap();
        let mut smaller = super::super::new_session("openai-api", "fixture", &workspace);
        smaller.messages.push(super::super::Message {
            attachments: Vec::new(),
            role: "user".into(),
            text: "needle".into(),
        });
        super::super::save(data.path(), "owner", &mut smaller).unwrap();
        let (candidates, _, _, _) = history::candidates(data.path(), "owner", &workspace, false, 0);
        for candidate in candidates {
            let newer = candidate.path.file_stem().unwrap() == oversized.id.as_str();
            std::fs::File::open(candidate.path)
                .unwrap()
                .set_modified(
                    std::time::SystemTime::UNIX_EPOCH
                        + std::time::Duration::from_secs(if newer { 200 } else { 100 }),
                )
                .unwrap();
        }
        for ranked in [false, true] {
            let page = recall_with_budget(
                data.path(),
                "owner",
                &workspace,
                &json!({"query":"needle", "rankWindow":ranked}),
                10_000,
            )
            .unwrap();
            assert_eq!(
                (
                    page["sessions"][0]["sessionId"].as_str(),
                    page["scanned"].as_u64(),
                    page["unreadable"].as_u64(),
                    page["nextOffset"].as_u64()
                ),
                (Some(smaller.id.as_str()), Some(2), Some(1), None)
            );
            assert!(page["scannedBytes"].as_u64().unwrap() <= 10_000);
        }
    }

    #[test]
    fn revision_file_proposals_preserve_unread_secrets_and_reject_stale_files() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let skill = owned_fixture(data.path(), "owner", &workspace, false);
        let proposal = json!({"id":uuid::Uuid::new_v4(),"title":"Update own support files","reason":"Synthetic fixture","operations":[{"kind":"skillFileReplace","id":skill.id,"path":"scripts/check.py","beforeRevision":fingerprint(&skill.support_files["scripts/check.py"]),"content":"print('updated')\n"},{"kind":"skillFileCreate","id":skill.id,"path":"references/new.md","content":"New guide"}]});
        let staged = propose(
            data.path(),
            "owner",
            &workspace,
            &json!({"scope":"workspace","proposal":proposal}),
        )
        .unwrap();
        assert_eq!(staged["proposal"]["status"], "pending");
        assert!(!staged.to_string().contains("fixture-secret"));
        assert_eq!(
            profile(data.path(), "owner", &workspace, false)
                .unwrap()
                .skills[0],
            skill
        );
        let proposals = agent_proposals(data.path(), "owner", Some(&workspace), None).unwrap();
        let operation = &proposals["proposals"][0]["operations"][0];
        assert_eq!(operation["kind"], "skillUpdate");
        assert_eq!(
            operation["supportFiles"]["references/guide.md"],
            skill.support_files["references/guide.md"]
        );
        assert_eq!(
            operation["supportFiles"]["scripts/check.py"],
            "print('updated')\n"
        );
        let stale = json!({"id":uuid::Uuid::new_v4(),"title":"Stale delete","reason":"Synthetic fixture","operations":[{"kind":"skillFileDelete","id":skill.id,"path":"references/guide.md","beforeRevision":"stale"}]});
        assert!(propose(
            data.path(),
            "owner",
            &workspace,
            &json!({"scope":"workspace","proposal":stale})
        )
        .is_err());
        let remove = json!({"id":uuid::Uuid::new_v4(),"title":"Remove fixture package","reason":"Synthetic fixture","operations":[{"kind":"skillRemove","id":skill.id,"beforeRevision":package_revision(&skill)}]});
        assert!(propose(
            data.path(),
            "owner",
            &workspace,
            &json!({"scope":"workspace","proposal":remove})
        )
        .is_ok());
        let delete = json!({"id":uuid::Uuid::new_v4(),"title":"Remove support file","reason":"Synthetic fixture","operations":[{"kind":"skillFileDelete","id":skill.id,"path":"references/guide.md","beforeRevision":fingerprint(&skill.support_files["references/guide.md"])}]});
        assert!(propose(
            data.path(),
            "owner",
            &workspace,
            &json!({"scope":"workspace","proposal":delete})
        )
        .is_ok());
        assert_eq!(
            agent_proposals(data.path(), "owner", Some(&workspace), None).unwrap()["proposals"][2]
                ["operations"][0]["supportFiles"]
                .get("references/guide.md"),
            None
        );
    }

    #[test]
    fn support_file_long_line_continuation_preserves_the_unread_tail() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let mut skill = owned_fixture(data.path(), "owner", &workspace, false);
        skill.support_files.insert(
            "assets/template.html".into(),
            format!("{}END", "a".repeat(5_000)),
        );
        let path = profile_path(data.path(), "owner", &workspace.to_string_lossy()).unwrap();
        crate::workspace::write_profile(
            &path,
            &WorkspaceProfile {
                skills: vec![skill.clone()],
                ..Default::default()
            },
        )
        .unwrap();
        let reference = format!("workspace:{}", skill.id);
        let first = read_skill(
            data.path(),
            "owner",
            &workspace,
            &json!({"skillRef":reference,"path":"assets/template.html"}),
        )
        .unwrap();
        assert_eq!(first["lines"][0]["nextCharOffset"], 4_000);
        let next = read_skill(
            data.path(),
            "owner",
            &workspace,
            &json!({"skillRef":reference,"path":"assets/template.html","charOffset":4_000}),
        )
        .unwrap();
        assert!(next["lines"][0]["text"].as_str().unwrap().ends_with("END"));
        assert_eq!(next["lines"][0]["nextCharOffset"], Value::Null);
    }

    #[test]
    fn proposals_stage_without_applying_and_reject_secrets() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let proposal = json!({"id":uuid::Uuid::new_v4(),"title":"Fixture package","reason":"Synthetic verified fixture","operations":[{"kind":"skillCreate","skill":{"id":uuid::Uuid::new_v4(),"name":"Fixture","instructions":"Read fixture.","supportFiles":{"scripts/check.py":"print(42)\n"}}}]});
        let result = propose(
            data.path(),
            "owner",
            &workspace,
            &json!({"scope":"account","proposal":proposal}),
        )
        .unwrap();
        assert_eq!(
            (
                result["reviewRequired"].clone(),
                result["proposal"]["status"].clone()
            ),
            (json!(true), json!("pending"))
        );
        assert!(profile(data.path(), "owner", &workspace, true)
            .unwrap()
            .skills
            .is_empty());
        assert_eq!(
            inspect(
                data.path(),
                "other",
                &workspace,
                &json!({"scope":"account"})
            )
            .unwrap()["account"]["proposals"],
            json!([])
        );
        let sensitive = json!({"id":uuid::Uuid::new_v4(),"title":"Bad","reason":"Fixture","operations":[{"kind":"memoryAppend","content":"API_KEY=never-store"}]});
        assert!(propose(
            data.path(),
            "owner",
            &workspace,
            &json!({"scope":"workspace","proposal":sensitive})
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn installed_support_files_reject_symlinks_traversal_and_email_files() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let directory = workspace.join(".agents/skills/review");
        std::fs::create_dir_all(directory.join("scripts")).unwrap();
        std::fs::write(directory.join("SKILL.md"), "Review synthetic fixtures.").unwrap();
        std::fs::write(directory.join("scripts/check.py"), "print(42)\n").unwrap();
        std::fs::write(directory.join("mail.mbox"), "Do not read fixture mailbox").unwrap();
        let external = tempfile::tempdir().unwrap();
        std::fs::write(external.path().join("outside.txt"), "Do not expose").unwrap();
        std::os::unix::fs::symlink(
            external.path().join("outside.txt"),
            directory.join("linked.txt"),
        )
        .unwrap();
        let discovery = discover(data.path(), "owner", &workspace).unwrap();
        let reference = discovery["skills"][0]["skillRef"].as_str().unwrap();
        let files = list_files(
            data.path(),
            "owner",
            &workspace,
            &json!({"skillRef":reference}),
        )
        .unwrap();
        assert_eq!(
            files["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["path"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["SKILL.md", "scripts/check.py"]
        );
        for path in ["linked.txt", "mail.mbox", "../outside.txt"] {
            assert!(read_skill(
                data.path(),
                "owner",
                &workspace,
                &json!({"skillRef":reference,"path":path})
            )
            .is_err());
        }
        assert!(read_skill(
            data.path(),
            "owner",
            &workspace,
            &json!({"skillRef":reference,"path":"scripts/check.py"})
        )
        .unwrap()["lines"][0]["text"]
            .as_str()
            .unwrap()
            .contains("42"));
        let history = super::super::directory(data.path(), "owner", &workspace);
        std::fs::create_dir_all(history.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(external.path(), &history).unwrap();
        assert!(dispatch(
            data.path(),
            "owner",
            &workspace,
            "recall_sessions",
            &json!({})
        )
        .is_err());
    }
}
