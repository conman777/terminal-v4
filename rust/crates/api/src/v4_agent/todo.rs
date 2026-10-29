use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

const MAX_ITEMS: usize = 256;
const MAX_TEXT_CHARS: usize = 4000;
const MAX_LIST_BYTES: usize = 48_000;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct State {
    pub(super) revision: u64,
    pub(super) todos: Vec<Item>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(super) struct Item {
    id: String,
    content: String,
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent: Option<String>,
}

impl State {
    pub(super) fn is_empty(&self) -> bool {
        self.revision == 0 && self.todos.is_empty()
    }
}

pub(super) fn definition() -> Value {
    json!({"name":"todo_list","description":"Track this conversation's task list for multi-step work. Omit todos to read it. Supply todos to replace the list, or merge=true to update items by id and add new items. Items can have a parent id. Mark completed only after verification.","parameters":{"type":"object","properties":{"todos":{"type":"array","maxItems":MAX_ITEMS,"items":{"type":"object","properties":{"id":{"type":"string"},"content":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed","cancelled"]},"parent":{"type":["string","null"]}},"required":["id"],"additionalProperties":false}},"merge":{"type":"boolean"}},"required":[],"additionalProperties":false}})
}

fn checked_text(value: &Value, name: &str, limit: usize) -> Result<String, String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("Todo {name} must be a string"))?
        .trim();
    if value.is_empty()
        || value.chars().count() > limit
        || value
            .chars()
            .any(|c| c.is_control() && (name != "content" || !matches!(c, '\n' | '\r' | '\t')))
    {
        return Err(format!("Todo {name} is empty or exceeds its limit"));
    }
    Ok(value.into())
}

fn validate(state: &State) -> Result<(), String> {
    if state.revision > 9_007_199_254_740_991
        || state.todos.len() > MAX_ITEMS
        || serde_json::to_vec(&state.todos)
            .map_err(|_| "Cannot encode todo list")?
            .len()
            > MAX_LIST_BYTES
    {
        return Err("Todo list exceeds its bounds".into());
    }
    let mut by_id = HashMap::new();
    for item in &state.todos {
        if checked_text(&json!(item.id), "id", 128)? != item.id
            || checked_text(&json!(item.content), "content", MAX_TEXT_CHARS)? != item.content
            || !["pending", "in_progress", "completed", "cancelled"].contains(&item.status.as_str())
            || by_id.insert(item.id.as_str(), item).is_some()
        {
            return Err("Todo list is invalid".into());
        }
        if let Some(parent) = &item.parent {
            if checked_text(&json!(parent), "parent", 128)? != *parent {
                return Err("Todo parent is invalid".into());
            }
        }
    }
    for item in &state.todos {
        let mut parent = item.parent.as_deref();
        let mut chain = HashSet::from([item.id.as_str()]);
        while let Some(id) = parent {
            if !chain.insert(id) {
                return Err("Todo parent must exist and cannot form a cycle".into());
            }
            parent = by_id
                .get(id)
                .ok_or("Todo parent must exist and cannot form a cycle")?
                .parent
                .as_deref();
        }
    }
    Ok(())
}

fn update(state: &State, input: &Value) -> Result<State, String> {
    validate(state)?;
    let args = input
        .as_object()
        .ok_or("Todo arguments must be an object")?;
    if args.keys().any(|key| key != "todos" && key != "merge") {
        return Err("Unexpected todo arguments".into());
    }
    let merge = match args.get("merge") {
        None => false,
        Some(value) => value.as_bool().ok_or("Todo merge must be a boolean")?,
    };
    let Some(todos) = args.get("todos") else {
        return Ok(state.clone());
    };
    let todos = todos.as_array().ok_or("Todo list must be an array")?;
    if todos.len() > MAX_ITEMS {
        return Err("Todo list exceeds 256 items".into());
    }
    let mut next = if merge {
        state.todos.clone()
    } else {
        Vec::new()
    };
    let mut seen = HashSet::new();
    for item in todos {
        let item = item.as_object().ok_or("Todo item must be an object")?;
        if item
            .keys()
            .any(|key| !["id", "content", "status", "parent"].contains(&key.as_str()))
        {
            return Err("Unexpected todo item field".into());
        }
        let id = checked_text(item.get("id").ok_or("Todo id is required")?, "id", 128)?;
        if !seen.insert(id.clone()) {
            return Err("Todo ids must be unique".into());
        }
        let existing = next.iter().position(|entry| entry.id == id);
        let previous = existing.map(|index| &next[index]);
        let content = match item.get("content") {
            Some(value) => checked_text(value, "content", MAX_TEXT_CHARS)?,
            None => previous
                .map(|entry| entry.content.clone())
                .ok_or("Todo content is required")?,
        };
        let status = match item.get("status") {
            Some(value) => checked_text(value, "status", 32)?,
            None => previous
                .map(|entry| entry.status.clone())
                .ok_or("Todo status is required")?,
        };
        if !["pending", "in_progress", "completed", "cancelled"].contains(&status.as_str()) {
            return Err("Invalid todo status".into());
        }
        let parent = match item.get("parent") {
            Some(Value::Null) => None,
            Some(Value::String(value)) if value.trim().is_empty() => None,
            Some(value) => Some(checked_text(value, "parent", 128)?),
            None => previous.and_then(|entry| entry.parent.clone()),
        };
        let updated = Item {
            id,
            content,
            status,
            parent,
        };
        if let Some(index) = existing {
            next[index] = updated;
        } else {
            next.push(updated);
        }
        if next.len() > MAX_ITEMS {
            return Err("Todo list exceeds 256 items".into());
        }
    }
    let revision = if next == state.todos {
        state.revision
    } else {
        state
            .revision
            .checked_add(1)
            .filter(|&value| value <= 9_007_199_254_740_991)
            .ok_or("Todo revision limit reached")?
    };
    let candidate = State {
        revision,
        todos: next,
    };
    validate(&candidate)?;
    Ok(candidate)
}

pub(super) fn execute(
    data: &Path,
    owner: &str,
    session: &mut super::Session,
    input: &Value,
) -> Result<String, String> {
    let mut candidate = super::load(data, owner, Path::new(&session.workspace), &session.id)?;
    if candidate.store.revision != session.store.revision || candidate.todo != session.todo {
        return Err("V4 conversation changed; reload before accessing the todo list".into());
    }
    let next = update(&session.todo, input)?;
    if next != session.todo {
        candidate.todo = next;
        super::save(data, owner, &mut candidate)?;
        let usage = session.store.usage.clone();
        session.todo = candidate.todo;
        session.store = candidate.store;
        session.store.usage = usage;
    }
    let mut summary = json!({"total":session.todo.todos.len(),"pending":0,"in_progress":0,"completed":0,"cancelled":0});
    for item in &session.todo.todos {
        let count = summary[&item.status]
            .as_u64()
            .ok_or("Invalid saved todo status")?;
        summary[&item.status] = json!(count + 1);
    }
    Ok(
        json!({"todos":session.todo.todos,"revision":session.todo.revision,"summary":summary})
            .to_string(),
    )
}

pub(super) fn compaction_snapshot(state: &State) -> Result<Option<Value>, String> {
    validate(state)?;
    let mut included: HashSet<&str> = state
        .todos
        .iter()
        .filter(|item| matches!(item.status.as_str(), "pending" | "in_progress"))
        .map(|item| item.id.as_str())
        .collect();
    let mut changed = true;
    while changed {
        changed = false;
        for item in &state.todos {
            if included.contains(item.id.as_str()) {
                if let Some(parent) = &item.parent {
                    changed |= included.insert(parent);
                }
            }
        }
    }
    if included.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        json!({"revision":state.revision,"todos":state.todos.iter().filter(|item| included.contains(item.id.as_str())).collect::<Vec<_>>() }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replace_merge_read_and_revision_are_atomic() {
        let empty = State::default();
        let created = update(
            &empty,
            &json!({"todos":[
                {"id":"1","content":"Inspect","status":"completed"},
                {"id":"2","content":"Fix","status":"in_progress","parent":"1"}
            ]}),
        )
        .unwrap();
        assert_eq!(created.revision, 1);
        let merged = update(
            &created,
            &json!({"merge":true,"todos":[
                {"id":"2","status":"completed"},
                {"id":"3","content":"Verify","status":"pending","parent":"1"}
            ]}),
        )
        .unwrap();
        assert_eq!(merged.revision, 2);
        assert_eq!(merged.todos.len(), 3);
        assert_eq!(merged.todos[1].status, "completed");
        assert_eq!(merged.todos[2].parent.as_deref(), Some("1"));
        assert_eq!(update(&merged, &json!({})).unwrap(), merged);
        assert_eq!(
            update(
                &merged,
                &json!({"merge":true,"todos":[{"id":"2","status":"completed"}]})
            )
            .unwrap(),
            merged
        );
        assert!(update(
            &merged,
            &json!({"merge":true,"todos":[{"id":"2","status":"broken"}]})
        )
        .is_err());
        assert_eq!(merged.todos[1].status, "completed");
    }

    #[test]
    fn rejects_invalid_items_cycles_duplicates_and_unbounded_lists_without_mutation() {
        let state = update(
            &State::default(),
            &json!({"todos":[{"id":"a","content":"First","status":"pending"}]}),
        )
        .unwrap();
        for input in [
            json!({"todos":[{"id":"a","content":" ","status":"pending"}]}),
            json!({"todos":[{"id":"a","content":"A","status":"pending","parent":"missing"}]}),
            json!({"todos":[{"id":"a","content":"A","status":"pending","parent":"b"},{"id":"b","content":"B","status":"pending","parent":"a"}]}),
            json!({"todos":[{"id":"a","content":"A","status":"pending"},{"id":"a","content":"B","status":"pending"}]}),
            json!({"todos":[{"id":"a","content":"x".repeat(MAX_TEXT_CHARS + 1),"status":"pending"}]}),
            json!({"todos":{},"merge":true}),
            json!({"merge":"yes"}),
            json!({"unrecognized":true}),
        ] {
            assert!(update(&state, &input).is_err(), "{input}");
            assert_eq!(state.revision, 1);
            assert_eq!(state.todos[0].content, "First");
        }
        let mut corrupt = state.clone();
        corrupt.todos[0].status = "broken".into();
        assert!(update(&corrupt, &json!({})).is_err());
        assert!(compaction_snapshot(&corrupt).is_err());

        let items = (0..=MAX_ITEMS)
            .map(|id| json!({"id":id.to_string(),"content":"x","status":"pending"}))
            .collect::<Vec<_>>();
        assert!(update(&state, &json!({"todos":items})).is_err());
        let large = (0..13).map(|id| json!({"id":id.to_string(),"content":"x".repeat(MAX_TEXT_CHARS),"status":"pending"})).collect::<Vec<_>>();
        assert!(update(&state, &json!({"todos":large})).is_err());
        let mut full_revision = state.clone();
        full_revision.revision = 9_007_199_254_740_991;
        assert!(update(&full_revision, &json!({"todos":[]})).is_err());
    }

    #[test]
    fn compaction_keeps_active_items_and_ancestors_without_resurrecting_finished_work() {
        let state = update(
            &State::default(),
            &json!({"todos":[
                {"id":"a","content":"Parent","status":"completed"},
                {"id":"b","content":"Active child","status":"in_progress","parent":"a"},
                {"id":"c","content":"Finished sibling","status":"completed","parent":"a"}
            ]}),
        )
        .unwrap();
        let snapshot = compaction_snapshot(&state).unwrap().unwrap();
        assert_eq!(snapshot["revision"], 1);
        assert_eq!(
            snapshot["todos"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        let done = update(&state, &json!({"todos":[]})).unwrap();
        assert_eq!(compaction_snapshot(&done).unwrap(), None);
    }

    #[test]
    fn stored_todos_are_session_scoped_and_checkpoint_before_reporting_success() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let other_workspace = tempfile::tempdir().unwrap();
        let mut session = super::super::new_session("deepseek", "fixture-model", workspace.path());
        super::super::save(data.path(), "owner", &mut session).unwrap();
        let mut stale = session.clone();
        let mut other_session =
            super::super::new_session("deepseek", "fixture-model", workspace.path());
        super::super::save(data.path(), "owner", &mut other_session).unwrap();
        session.history.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":"call","type":"function","function":{"name":"todo_list","arguments":"{}"}}]}));
        let pending = session.history.clone();
        let input = json!({"todos":[{"id":"1","content":"Inspect","status":"in_progress"}]});
        let result: Value =
            serde_json::from_str(&execute(data.path(), "owner", &mut session, &input).unwrap())
                .unwrap();
        assert_eq!(
            result["summary"],
            json!({"total":1,"pending":0,"in_progress":1,"completed":0,"cancelled":0})
        );
        let persisted =
            super::super::load(data.path(), "owner", workspace.path(), &session.id).unwrap();
        assert_eq!(persisted.todo, session.todo);
        assert!(
            persisted.history.is_empty(),
            "a crash must not persist a dangling provider tool call"
        );
        assert_eq!(session.history, pending);
        assert!(execute(data.path(), "other", &mut session, &json!({})).is_err());
        assert!(
            super::super::load(data.path(), "owner", other_workspace.path(), &session.id).is_err()
        );
        let other: Value = serde_json::from_str(
            &execute(data.path(), "owner", &mut other_session, &json!({})).unwrap(),
        )
        .unwrap();
        assert_eq!(other["todos"], json!([]));
        assert!(execute(data.path(), "owner", &mut stale, &input).is_err());
        assert_eq!(stale.todo, State::default());
        assert_eq!(
            super::super::load(data.path(), "owner", workspace.path(), &session.id)
                .unwrap()
                .todo,
            session.todo
        );
        assert!(!super::super::ToolPolicy::ReadOnlyChild.allows("todo_list"));
        let mut legacy = serde_json::to_value(&session).unwrap();
        legacy.as_object_mut().unwrap().remove("todo");
        let decoded: super::super::Session = serde_json::from_value(legacy).unwrap();
        assert_eq!(decoded.todo, State::default());
    }

    #[test]
    fn failed_checkpoint_leaves_session_and_persisted_todos_unchanged() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut session = super::super::new_session("deepseek", "fixture-model", workspace.path());
        super::super::save(data.path(), "owner", &mut session).unwrap();
        let path = super::super::directory(data.path(), "owner", workspace.path())
            .join(format!("{}.json", session.id));
        let mut head: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        head["store"]["revision"] = json!(u64::MAX);
        let bytes = serde_json::to_vec(&head).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        session.store.revision = u64::MAX;
        let error = execute(
            data.path(),
            "owner",
            &mut session,
            &json!({"todos":[
                {"id":"1", "content":"Not committed", "status":"pending"}
            ]}),
        )
        .unwrap_err();
        assert!(error.contains("revision"));
        assert_eq!(session.todo, State::default());
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }

    #[tokio::test]
    async fn provider_can_update_and_read_todos_across_turns_and_restart() {
        use axum::{routing::post, Json};
        use std::sync::{Arc, Mutex};
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let router = axum::Router::new().route("/chat", post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            async move {
                let mut requests = captured.lock().unwrap();
                requests.push(body);
                let args = match requests.len() {
                    1 => Some(json!({"todos":[{"id":"a","content":"Inspect","status":"completed"},{"id":"b","content":"Verify","status":"pending","parent":"a"}]})),
                    3 => Some(json!({})),
                    _ => None,
                };
                Json(if let Some(args) = args {
                    json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[{"id":format!("todo-{}",requests.len()),"type":"function","function":{"name":"todo_list","arguments":args.to_string()}}]}}]})
                } else {
                    json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"Done"}}]})
                })
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let provider = super::super::Provider {
            #[cfg(unix)]
            profile: None,
            transport: "openai-chat".into(),
            url: format!("http://{address}/chat"),
            secret: "fixture".into(),
            client: reqwest::Client::new(),
        };
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().canonicalize().unwrap();
        let mut session = super::super::new_session("deepseek", "fixture-model", &root);
        assert_eq!(
            super::super::turn(
                &provider,
                data.path(),
                "owner",
                &mut session,
                "Plan the work",
                None,
                false
            )
            .await
            .unwrap(),
            "Done"
        );
        let mut reopened = super::super::load(data.path(), "owner", &root, &session.id).unwrap();
        assert_eq!(reopened.todo.revision, 1);
        assert_eq!(
            super::super::turn(
                &provider,
                data.path(),
                "owner",
                &mut reopened,
                "Read the plan",
                None,
                false
            )
            .await
            .unwrap(),
            "Done"
        );
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "todo_list"));
        let result: Value = serde_json::from_str(
            requests[3]["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(result["revision"], 1);
        assert_eq!(result["todos"][1]["parent"], "a");
        server.abort();
    }
}
