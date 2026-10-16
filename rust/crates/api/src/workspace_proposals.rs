use crate::{
    auth::AuthenticatedUser,
    state::AppState,
    workspace::{mutate_workspace_record, validate_profile, WorkspaceProfile, WorkspaceSkill},
    ApiError,
};
use axum::{
    extract::{Path, Query, State},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Operation {
    MemoryAppend {
        content: String,
    },
    MemoryReplace {
        before: String,
        content: String,
    },
    SkillCreate {
        skill: WorkspaceSkill,
    },
    #[serde(rename_all = "camelCase")]
    SkillUpdate {
        id: Uuid,
        before_name: String,
        before_instructions: String,
        name: String,
        instructions: String,
    },
    #[serde(rename_all = "camelCase")]
    SkillRemove {
        id: Uuid,
        before_name: String,
        before_instructions: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct ProposalInput {
    id: Uuid,
    title: String,
    reason: String,
    operations: Vec<Operation>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum ProposalStatus {
    Pending,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proposal {
    #[serde(flatten)]
    input: ProposalInput,
    status: ProposalStatus,
    created_at: i64,
}

#[derive(Deserialize)]
struct WorkspaceQuery {
    path: String,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/workspace/proposals",
            axum::routing::get(list).post(stage),
        )
        .route(
            "/api/workspace/proposals/{id}/accept",
            axum::routing::post(accept),
        )
        .route(
            "/api/workspace/proposals/{id}/reject",
            axum::routing::post(reject),
        )
}

fn conflict(message: &str) -> ApiError {
    ApiError {
        status: axum::http::StatusCode::CONFLICT,
        message: message.into(),
    }
}

fn validate_input(input: &ProposalInput) -> Result<(), ApiError> {
    if input.id.is_nil()
        || input.title.trim().is_empty()
        || input.title.chars().count() > 120
        || input.reason.trim().is_empty()
        || input.reason.chars().count() > 1000
        || input.operations.is_empty()
        || input.operations.len() > 10
        || serde_json::to_vec(input)
            .map_err(|_| ApiError::internal("Invalid suggestion"))?
            .len()
            > 16_000
    {
        return Err(ApiError::bad_request(
            "Suggestions require a UUID, title, evidence, and 1 to 10 changes within 16000 bytes",
        ));
    }
    let mut targets = HashSet::new();
    for operation in &input.operations {
        let target = match operation {
            Operation::MemoryAppend { content } => {
                if content.trim().is_empty() || content.chars().count() > 6000 {
                    return Err(ApiError::bad_request(
                        "Appended knowledge must contain at most 6000 characters",
                    ));
                }
                "memory".into()
            }
            Operation::MemoryReplace { before, content } => {
                if before.chars().count() > 6000 || content.chars().count() > 6000 {
                    return Err(ApiError::bad_request(
                        "Knowledge must contain at most 6000 characters",
                    ));
                }
                "memory".into()
            }
            Operation::SkillCreate { skill } => {
                if skill.id.is_nil() {
                    return Err(ApiError::bad_request("Skills require a non-empty UUID"));
                }
                validate_profile(&WorkspaceProfile {
                    skills: vec![skill.clone()],
                    ..Default::default()
                })?;
                skill.id.to_string()
            }
            Operation::SkillUpdate {
                id,
                before_name,
                before_instructions,
                name,
                instructions,
            } => {
                if id.is_nil() {
                    return Err(ApiError::bad_request("Skills require a non-empty UUID"));
                }
                for (skill_name, skill_instructions) in
                    [(before_name, before_instructions), (name, instructions)]
                {
                    validate_profile(&WorkspaceProfile {
                        skills: vec![WorkspaceSkill {
                            id: *id,
                            name: skill_name.clone(),
                            instructions: skill_instructions.clone(),
                        }],
                        ..Default::default()
                    })?;
                }
                id.to_string()
            }
            Operation::SkillRemove {
                id,
                before_name,
                before_instructions,
            } => {
                if id.is_nil() {
                    return Err(ApiError::bad_request("Skills require a non-empty UUID"));
                }
                validate_profile(&WorkspaceProfile {
                    skills: vec![WorkspaceSkill {
                        id: *id,
                        name: before_name.clone(),
                        instructions: before_instructions.clone(),
                    }],
                    ..Default::default()
                })?;
                id.to_string()
            }
        };
        if !targets.insert(target) {
            return Err(ApiError::bad_request(
                "A suggestion may change each knowledge or skill entry only once",
            ));
        }
    }
    Ok(())
}

fn apply_operations(
    profile: &WorkspaceProfile,
    operations: &[Operation],
) -> Result<WorkspaceProfile, ApiError> {
    let mut next = profile.clone();
    for operation in operations {
        match operation {
            Operation::MemoryAppend { content } => {
                if !next.memory.is_empty() {
                    next.memory.push_str("\n\n");
                }
                next.memory.push_str(content);
            }
            Operation::MemoryReplace { before, content } => {
                if &next.memory != before {
                    return Err(conflict(
                        "Saved knowledge changed. Request a new suggestion before replacing it.",
                    ));
                }
                next.memory = content.clone();
            }
            Operation::SkillCreate { skill } => {
                if next.skills.iter().any(|existing| existing.id == skill.id) {
                    return Err(conflict(
                        "The proposed skill ID already exists. Request a new suggestion.",
                    ));
                }
                next.skills.push(skill.clone());
            }
            Operation::SkillUpdate {
                id,
                before_name,
                before_instructions,
                name,
                instructions,
            } => {
                let skill = next
                    .skills
                    .iter_mut()
                    .find(|skill| skill.id == *id)
                    .ok_or_else(|| {
                        conflict("The saved skill was removed. Request a new suggestion.")
                    })?;
                if &skill.name != before_name || &skill.instructions != before_instructions {
                    return Err(conflict(
                        "The saved skill changed. Request a new suggestion before updating it.",
                    ));
                }
                skill.name = name.clone();
                skill.instructions = instructions.clone();
            }
            Operation::SkillRemove {
                id,
                before_name,
                before_instructions,
            } => {
                let skill = next
                    .skills
                    .iter()
                    .find(|skill| skill.id == *id)
                    .ok_or_else(|| {
                        conflict("The saved skill was removed. Request a new suggestion.")
                    })?;
                if &skill.name != before_name || &skill.instructions != before_instructions {
                    return Err(conflict(
                        "The saved skill changed. Request a new suggestion before removing it.",
                    ));
                }
                next.skills.retain(|skill| skill.id != *id);
            }
        }
    }
    validate_profile(&next)?;
    Ok(next)
}

fn read_proposals(metadata: &Value) -> Result<Vec<Proposal>, ApiError> {
    let Some(value) = metadata.get("proposals") else {
        return Ok(Vec::new());
    };
    let proposals: Vec<Proposal> = serde_json::from_value(value.clone())
        .map_err(|_| ApiError::internal("Saved suggestions are invalid"))?;
    if proposals.len() > 30
        || proposals
            .iter()
            .filter(|proposal| proposal.status == ProposalStatus::Pending)
            .count()
            > 15
    {
        return Err(ApiError::internal(
            "Saved suggestions exceed the review limit",
        ));
    }
    let mut ids = HashSet::new();
    for proposal in &proposals {
        if !ids.insert(proposal.input.id) || validate_input(&proposal.input).is_err() {
            return Err(ApiError::internal("Saved suggestions are invalid"));
        }
    }
    Ok(proposals)
}

fn stage_proposal(
    profile: &WorkspaceProfile,
    metadata: &mut Value,
    input: ProposalInput,
) -> Result<Proposal, ApiError> {
    validate_input(&input)?;
    let mut proposals = read_proposals(metadata)?;
    if let Some(existing) = proposals
        .iter()
        .find(|proposal| proposal.input.id == input.id)
    {
        if existing.input != input {
            return Err(conflict(
                "This suggestion ID was already used for different changes",
            ));
        }
        return Ok(existing.clone());
    }
    apply_operations(profile, &input.operations)?;
    if proposals
        .iter()
        .filter(|proposal| proposal.status == ProposalStatus::Pending)
        .count()
        >= 15
    {
        return Err(ApiError::bad_request(
            "Review or reject pending suggestions before adding more",
        ));
    }
    if proposals.len() >= 30 {
        let index = proposals
            .iter()
            .position(|proposal| proposal.status != ProposalStatus::Pending)
            .ok_or_else(|| ApiError::internal("Suggestion history is full"))?;
        proposals.remove(index);
    }
    let proposal = Proposal {
        input,
        status: ProposalStatus::Pending,
        created_at: time::OffsetDateTime::now_utc().unix_timestamp(),
    };
    proposals.push(proposal.clone());
    metadata["proposals"] = serde_json::to_value(proposals)
        .map_err(|_| ApiError::internal("Unable to save suggestion"))?;
    Ok(proposal)
}

fn decide_proposal(
    profile: &mut WorkspaceProfile,
    metadata: &mut Value,
    id: Uuid,
    decision: ProposalStatus,
) -> Result<Proposal, ApiError> {
    let mut proposals = read_proposals(metadata)?;
    let proposal = proposals
        .iter_mut()
        .find(|proposal| proposal.input.id == id)
        .ok_or_else(|| ApiError {
            status: axum::http::StatusCode::NOT_FOUND,
            message: "Suggestion not found".into(),
        })?;
    if proposal.status == decision {
        return Ok(proposal.clone());
    }
    if proposal.status != ProposalStatus::Pending {
        return Err(conflict("This suggestion has already been reviewed"));
    }
    if decision == ProposalStatus::Accepted {
        *profile = apply_operations(profile, &proposal.input.operations)?;
    }
    proposal.status = decision;
    let result = proposal.clone();
    metadata["proposals"] = serde_json::to_value(proposals)
        .map_err(|_| ApiError::internal("Unable to save suggestion"))?;
    Ok(result)
}

type ProposalResponse = (
    [(axum::http::header::HeaderName, &'static str); 1],
    Json<Value>,
);
fn response(value: Value) -> ProposalResponse {
    (
        [(axum::http::header::CACHE_CONTROL, "private, no-store")],
        Json(value),
    )
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<WorkspaceQuery>,
) -> Result<ProposalResponse, ApiError> {
    let directory = state.config().data_dir.clone();
    let proposals = tokio::task::spawn_blocking(move || {
        mutate_workspace_record(
            &directory,
            &user.user_id,
            &query.path,
            |_profile, metadata| read_proposals(metadata),
        )
    })
    .await
    .map_err(|_| ApiError::internal("Unable to load suggestions"))??;
    Ok(response(json!({"proposals": proposals})))
}

async fn stage(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<WorkspaceQuery>,
    Json(input): Json<ProposalInput>,
) -> Result<ProposalResponse, ApiError> {
    let directory = state.config().data_dir.clone();
    let proposal = tokio::task::spawn_blocking(move || {
        mutate_workspace_record(
            &directory,
            &user.user_id,
            &query.path,
            |profile, metadata| stage_proposal(profile, metadata, input),
        )
    })
    .await
    .map_err(|_| ApiError::internal("Unable to stage suggestion"))??;
    Ok(response(json!({"proposal": proposal})))
}

async fn accept(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<WorkspaceQuery>,
    Path(id): Path<Uuid>,
) -> Result<ProposalResponse, ApiError> {
    decide(state, user, query, id, ProposalStatus::Accepted).await
}
async fn reject(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<WorkspaceQuery>,
    Path(id): Path<Uuid>,
) -> Result<ProposalResponse, ApiError> {
    decide(state, user, query, id, ProposalStatus::Rejected).await
}
async fn decide(
    state: AppState,
    user: AuthenticatedUser,
    query: WorkspaceQuery,
    id: Uuid,
    decision: ProposalStatus,
) -> Result<ProposalResponse, ApiError> {
    let directory = state.config().data_dir.clone();
    let (proposal, profile) = tokio::task::spawn_blocking(move || {
        mutate_workspace_record(
            &directory,
            &user.user_id,
            &query.path,
            |profile, metadata| {
                let proposal = decide_proposal(profile, metadata, id, decision)?;
                Ok((proposal, profile.clone()))
            },
        )
    })
    .await
    .map_err(|_| ApiError::internal("Unable to review suggestion"))??;
    Ok(response(json!({"proposal": proposal, "profile": profile})))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(operations: Vec<Operation>) -> ProposalInput {
        ProposalInput {
            id: Uuid::new_v4(),
            title: "Verified knowledge".into(),
            reason: "Learned during the task".into(),
            operations,
        }
    }
    #[test]
    fn acceptance_preserves_unrelated_changes_and_is_idempotent() {
        let unrelated = WorkspaceSkill {
            id: Uuid::new_v4(),
            name: "Review".into(),
            instructions: "Check errors".into(),
        };
        let mut profile = WorkspaceProfile {
            memory: "Initial facts".into(),
            default_agent: "claude".into(),
            ..Default::default()
        };
        let mut metadata = json!({"otherFeature": true});
        let proposal = stage_proposal(
            &profile,
            &mut metadata,
            input(vec![Operation::MemoryAppend {
                content: "Run cargo test".into(),
            }]),
        )
        .unwrap();
        profile.skills.push(unrelated.clone());
        profile.memory.push_str("\nUnrelated new fact");
        decide_proposal(
            &mut profile,
            &mut metadata,
            proposal.input.id,
            ProposalStatus::Accepted,
        )
        .unwrap();
        decide_proposal(
            &mut profile,
            &mut metadata,
            proposal.input.id,
            ProposalStatus::Accepted,
        )
        .unwrap();
        assert_eq!(
            profile,
            WorkspaceProfile {
                memory: "Initial facts\nUnrelated new fact\n\nRun cargo test".into(),
                skills: vec![unrelated],
                default_agent: "claude".into(),
                selection: None
            }
        );
        assert_eq!(metadata["otherFeature"], true);
    }
    #[test]
    fn stale_destructive_changes_are_refused_without_partial_application() {
        let original = WorkspaceProfile {
            memory: "Original fact".into(),
            ..Default::default()
        };
        let operations = vec![
            Operation::SkillCreate {
                skill: WorkspaceSkill {
                    id: Uuid::new_v4(),
                    name: "Test".into(),
                    instructions: "Run tests".into(),
                },
            },
            Operation::MemoryReplace {
                before: original.memory.clone(),
                content: "Replacement".into(),
            },
        ];
        let mut metadata = json!({});
        let proposal = stage_proposal(&original, &mut metadata, input(operations)).unwrap();
        let mut profile = WorkspaceProfile {
            memory: "Changed independently".into(),
            ..Default::default()
        };
        let snapshot = (profile.clone(), metadata.clone());
        assert_eq!(
            decide_proposal(
                &mut profile,
                &mut metadata,
                proposal.input.id,
                ProposalStatus::Accepted
            )
            .unwrap_err()
            .status,
            axum::http::StatusCode::CONFLICT
        );
        assert_eq!((profile, metadata), snapshot);
    }
    #[test]
    fn rejected_changes_never_apply_and_repeated_rejection_is_safe() {
        let mut profile = WorkspaceProfile::default();
        let mut metadata = json!({});
        let proposal = stage_proposal(
            &profile,
            &mut metadata,
            input(vec![Operation::MemoryAppend {
                content: "New fact".into(),
            }]),
        )
        .unwrap();
        for _ in 0..2 {
            decide_proposal(
                &mut profile,
                &mut metadata,
                proposal.input.id,
                ProposalStatus::Rejected,
            )
            .unwrap();
        }
        assert!(decide_proposal(
            &mut profile,
            &mut metadata,
            proposal.input.id,
            ProposalStatus::Accepted
        )
        .is_err());
        assert_eq!(profile, WorkspaceProfile::default());
    }
    #[test]
    fn validation_rejects_budget_overflows_duplicates_and_command_fields() {
        let profile = WorkspaceProfile {
            memory: "x".repeat(6000),
            ..Default::default()
        };
        let append = input(vec![Operation::MemoryAppend {
            content: "Extra".into(),
        }]);
        let mut metadata = json!({});
        assert!(stage_proposal(&profile, &mut metadata, append.clone()).is_err());
        assert!(validate_input(&input(vec![
            append.operations[0].clone(),
            append.operations[0].clone()
        ]))
        .is_err());
        let mut encoded = serde_json::to_value(append).unwrap();
        encoded["launchCommand"] = json!("arbitrary command");
        assert!(serde_json::from_value::<ProposalInput>(encoded).is_err());
        assert_eq!(metadata, json!({}));
    }
    #[test]
    fn conflicting_skill_edits_and_duplicate_stage_ids_are_refused() {
        let skill = WorkspaceSkill {
            id: Uuid::new_v4(),
            name: "Review".into(),
            instructions: "Check errors".into(),
        };
        let mut profile = WorkspaceProfile {
            skills: vec![skill.clone()],
            ..Default::default()
        };
        let suggestion = input(vec![Operation::SkillUpdate {
            id: skill.id,
            before_name: skill.name,
            before_instructions: skill.instructions,
            name: "Review".into(),
            instructions: "Check async boundaries".into(),
        }]);
        let mut metadata = json!({});
        let proposal = stage_proposal(&profile, &mut metadata, suggestion.clone()).unwrap();
        assert_eq!(
            stage_proposal(&profile, &mut metadata, suggestion.clone()).unwrap(),
            proposal
        );
        assert!(stage_proposal(
            &profile,
            &mut metadata,
            ProposalInput {
                title: "Different proposal".into(),
                ..suggestion
            }
        )
        .is_err());
        profile.skills[0].name = "Renamed".into();
        assert!(decide_proposal(
            &mut profile,
            &mut metadata,
            proposal.input.id,
            ProposalStatus::Accepted
        )
        .is_err());
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[test]
    fn concurrent_acceptance_and_manual_updates_keep_one_receipt_and_all_other_changes() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().to_string_lossy().into_owned();
        let input = ProposalInput {
            id: Uuid::new_v4(),
            title: "Test command".into(),
            reason: "Verified command".into(),
            operations: vec![Operation::MemoryAppend {
                content: "Run cargo test".into(),
            }],
        };
        mutate_workspace_record(
            directory.path(),
            "owner",
            &workspace,
            |profile, metadata| stage_proposal(profile, metadata, input.clone()),
        )
        .unwrap();
        let workers: Vec<_> = (0..4)
            .map(|index| {
                let data_dir = directory.path().to_path_buf();
                let workspace = workspace.clone();
                let id = input.id;
                std::thread::spawn(move || {
                    mutate_workspace_record(&data_dir, "owner", &workspace, |profile, metadata| {
                        decide_proposal(profile, metadata, id, ProposalStatus::Accepted)?;
                        profile.skills.push(WorkspaceSkill {
                            id: Uuid::new_v4(),
                            name: format!("Workflow {index}"),
                            instructions: "Preserve this independent change".into(),
                        });
                        Ok(())
                    })
                    .unwrap()
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let (profile, proposals) = mutate_workspace_record(
            directory.path(),
            "owner",
            &workspace,
            |profile, metadata| Ok((profile.clone(), read_proposals(metadata)?)),
        )
        .unwrap();
        assert_eq!(
            (
                profile.memory,
                profile.skills.len(),
                proposals.len(),
                proposals[0].status
            ),
            ("Run cargo test".into(), 4, 1, ProposalStatus::Accepted)
        );
    }

    async fn request(
        app: Router,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let response = app
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let payload =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        (status, payload)
    }

    #[tokio::test]
    async fn proposal_http_routes_require_auth_isolate_owners_and_persist_explicit_review() {
        let directory = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: directory.path().into(),
            jwt_secret: "proposal-test-secret".into(),
            ..Default::default()
        };
        let state = AppState::new_with_external_auth(config, None).unwrap();
        let app = crate::app(state);
        let owner = crate::auth::issue_access_token("proposal-test-secret", "owner-one", "one");
        let other = crate::auth::issue_access_token("proposal-test-secret", "owner-two", "two");
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", directory.path().to_str().unwrap())
            .finish();
        let base = format!("/api/workspace/proposals?{query}");
        assert_eq!(
            request(app.clone(), "GET", &base, None, Value::Null)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        let id = Uuid::new_v4();
        let input = json!({"id":id,"title":"Keep command","reason":"Verified","operations":[{"kind":"memoryAppend","content":"Run tests"}]});
        let staged = request(app.clone(), "POST", &base, Some(&owner), input.clone()).await;
        assert_eq!(
            (staged.0, staged.1["proposal"]["status"].clone()),
            (StatusCode::OK, json!("pending"))
        );
        assert_eq!(
            request(app.clone(), "GET", &base, Some(&other), Value::Null)
                .await
                .1,
            json!({"proposals":[]})
        );
        let accept_path = format!("/api/workspace/proposals/{id}/accept?{query}");
        assert_eq!(
            request(app.clone(), "POST", &accept_path, Some(&other), Value::Null)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        let accepted = request(app.clone(), "POST", &accept_path, Some(&owner), Value::Null).await;
        assert_eq!(
            (
                accepted.0,
                accepted.1["profile"]["memory"].clone(),
                accepted.1["proposal"]["status"].clone()
            ),
            (StatusCode::OK, json!("Run tests"), json!("accepted"))
        );
        assert_eq!(
            request(app.clone(), "POST", &accept_path, Some(&owner), Value::Null)
                .await
                .1["profile"]["memory"],
            "Run tests"
        );
        assert_eq!(
            request(app, "GET", &base, Some(&owner), Value::Null)
                .await
                .1["proposals"][0]["status"],
            "accepted"
        );
    }
}
