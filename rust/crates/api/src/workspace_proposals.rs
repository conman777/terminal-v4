use crate::{
    auth::AuthenticatedUser,
    state::AppState,
    workspace::KNOWLEDGE_RECORD_BYTES,
    workspace::{
        mutate_account_record, mutate_workspace_record, validate_profile, validate_support_files,
        SkillActivation, WorkspaceProfile, WorkspaceSkill,
    },
    ApiError,
};
use axum::{
    extract::{Path, Query, State},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before_activation: Option<SkillActivation>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        before_support_files: BTreeMap<String, String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_support_files"
        )]
        support_files: Option<BTreeMap<String, String>>,
        name: String,
        instructions: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        activation: Option<SkillActivation>,
    },
    #[serde(rename_all = "camelCase")]
    SkillRemove {
        id: Uuid,
        before_name: String,
        before_instructions: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before_activation: Option<SkillActivation>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        before_support_files: BTreeMap<String, String>,
    },
}

fn deserialize_support_files<'de, D>(
    deserializer: D,
) -> Result<Option<BTreeMap<String, String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    BTreeMap::deserialize(deserializer).map(Some)
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
        .route(
            "/api/account/knowledge/proposals",
            axum::routing::get(list_account).post(stage_account),
        )
        .route(
            "/api/account/knowledge/proposals/{id}/accept",
            axum::routing::post(accept_account),
        )
        .route(
            "/api/account/knowledge/proposals/{id}/reject",
            axum::routing::post(reject_account),
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
            > 640_000
    {
        return Err(ApiError::bad_request(
            "Suggestions require a UUID, title, evidence, and 1 to 10 changes within 640000 bytes",
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
                before_activation,
                before_support_files,
                support_files,
                name,
                instructions,
                activation,
            } => {
                if id.is_nil() {
                    return Err(ApiError::bad_request("Skills require a non-empty UUID"));
                }
                let _ = (before_activation, activation);
                validate_support_files(before_support_files)?;
                if let Some(files) = support_files {
                    validate_support_files(files)?;
                }
                for (skill_name, skill_instructions) in
                    [(before_name, before_instructions), (name, instructions)]
                {
                    validate_profile(&WorkspaceProfile {
                        skills: vec![WorkspaceSkill {
                            id: *id,
                            name: skill_name.clone(),
                            instructions: skill_instructions.clone(),
                            activation: None,
                            support_files: Default::default(),
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
                before_activation,
                before_support_files,
            } => {
                if id.is_nil() {
                    return Err(ApiError::bad_request("Skills require a non-empty UUID"));
                }
                let _ = before_activation;
                validate_profile(&WorkspaceProfile {
                    skills: vec![WorkspaceSkill {
                        id: *id,
                        name: before_name.clone(),
                        instructions: before_instructions.clone(),
                        activation: None,
                        support_files: before_support_files.clone(),
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
                before_activation,
                before_support_files,
                support_files,
                name,
                instructions,
                activation,
            } => {
                let skill = next
                    .skills
                    .iter_mut()
                    .find(|skill| skill.id == *id)
                    .ok_or_else(|| {
                        conflict("The saved skill was removed. Request a new suggestion.")
                    })?;
                if &skill.name != before_name
                    || &skill.instructions != before_instructions
                    || skill.activation.unwrap_or_default() != before_activation.unwrap_or_default()
                    || &skill.support_files != before_support_files
                {
                    return Err(conflict(
                        "The saved skill changed. Request a new suggestion before updating it.",
                    ));
                }
                skill.name = name.clone();
                skill.instructions = instructions.clone();
                if let Some(activation) = activation {
                    skill.activation = Some(*activation);
                }
                if let Some(files) = support_files {
                    skill.support_files = files.clone();
                }
            }
            Operation::SkillRemove {
                id,
                before_name,
                before_instructions,
                before_activation,
                before_support_files,
            } => {
                let skill = next
                    .skills
                    .iter()
                    .find(|skill| skill.id == *id)
                    .ok_or_else(|| {
                        conflict("The saved skill was removed. Request a new suggestion.")
                    })?;
                if &skill.name != before_name
                    || &skill.instructions != before_instructions
                    || skill.activation.unwrap_or_default() != before_activation.unwrap_or_default()
                    || &skill.support_files != before_support_files
                {
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
    let projected = apply_operations(profile, &input.operations)?;
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
    let mut next_metadata = metadata.clone();
    loop {
        next_metadata["proposals"] = serde_json::to_value(&proposals)
            .map_err(|_| ApiError::internal("Unable to save suggestion"))?;
        let within_budget = [profile, &projected].into_iter().all(|candidate| {
            let Ok(mut document) = serde_json::to_value(candidate) else {
                return false;
            };
            document["workspaceMetadata"] = next_metadata.clone();
            serde_json::to_vec(&document)
                .is_ok_and(|encoded| encoded.len() <= KNOWLEDGE_RECORD_BYTES)
        });
        if within_budget {
            break;
        }
        let index = proposals.iter().position(|proposal| proposal.status != ProposalStatus::Pending).ok_or_else(|| ApiError::bad_request("Review or reject pending suggestions to free knowledge storage before adding this package"))?;
        proposals.remove(index);
    }
    *metadata = next_metadata;
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

pub(crate) fn agent_proposals(
    data_dir: &std::path::Path,
    owner: &str,
    workspace: Option<&std::path::Path>,
    input: Option<Value>,
) -> Result<Value, ApiError> {
    let operation = |profile: &mut WorkspaceProfile, metadata: &mut Value| {
        if let Some(input) = input {
            let input: ProposalInput = serde_json::from_value(input)
                .map_err(|_| ApiError::bad_request("Invalid knowledge proposal fields"))?;
            Ok(json!({"proposal": stage_proposal(profile, metadata, input)?}))
        } else {
            Ok(json!({"proposals": read_proposals(metadata)?}))
        }
    };
    match workspace {
        Some(workspace) => {
            mutate_workspace_record(data_dir, owner, &workspace.to_string_lossy(), operation)
        }
        None => mutate_account_record(data_dir, owner, operation),
    }
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

async fn list_account(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
) -> Result<ProposalResponse, ApiError> {
    let data = state.config().data_dir.clone();
    let result =
        tokio::task::spawn_blocking(move || agent_proposals(&data, &user.user_id, None, None))
            .await
            .map_err(|_| ApiError::internal("Unable to load account suggestions"))??;
    Ok(response(result))
}
async fn stage_account(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<Value>,
) -> Result<ProposalResponse, ApiError> {
    let data = state.config().data_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        agent_proposals(&data, &user.user_id, None, Some(input))
    })
    .await
    .map_err(|_| ApiError::internal("Unable to stage account suggestion"))??;
    Ok(response(result))
}
async fn accept_account(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<ProposalResponse, ApiError> {
    decide_account(state, user, id, ProposalStatus::Accepted).await
}
async fn reject_account(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(id): Path<Uuid>,
) -> Result<ProposalResponse, ApiError> {
    decide_account(state, user, id, ProposalStatus::Rejected).await
}
async fn decide_account(
    state: AppState,
    user: AuthenticatedUser,
    id: Uuid,
    decision: ProposalStatus,
) -> Result<ProposalResponse, ApiError> {
    let data = state.config().data_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        mutate_account_record(&data, &user.user_id, |profile, metadata| {
            let proposal = decide_proposal(profile, metadata, id, decision)?;
            Ok(json!({"proposal":proposal,"profile":profile}))
        })
    })
    .await
    .map_err(|_| ApiError::internal("Unable to review account suggestion"))??;
    Ok(response(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn input(operations: Vec<Operation>) -> ProposalInput {
        ProposalInput {
            id: Uuid::new_v4(),
            title: "Verified knowledge".into(),
            reason: "Learned during the task".into(),
            operations,
        }
    }
    #[test]
    fn activation_changes_conflict_with_old_and_stale_proposals() {
        let skill: WorkspaceSkill = serde_json::from_value(json!({"id":Uuid::new_v4(),"name":"Review","instructions":"Check changes","supportFiles":{"refs/a.md":"Keep"}})).unwrap();
        let mut profile = WorkspaceProfile {
            skills: vec![skill.clone()],
            ..Default::default()
        };
        let mut metadata = json!({});
        let old: Operation = serde_json::from_value(json!({"kind":"skillUpdate","id":skill.id,"beforeName":skill.name,"beforeInstructions":skill.instructions,"beforeSupportFiles":skill.support_files,"name":"Review","instructions":"Updated"})).unwrap();
        let proposal = stage_proposal(&profile, &mut metadata, input(vec![old])).unwrap();
        profile.skills[0].activation = Some(SkillActivation::OnDemand);
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
        assert_eq!((profile.clone(), metadata.clone()), snapshot);
        let update: Operation = serde_json::from_value(json!({"kind":"skillUpdate","id":skill.id,"beforeName":skill.name,"beforeInstructions":skill.instructions,"beforeActivation":"onDemand","beforeSupportFiles":skill.support_files,"name":"Review","instructions":"Updated"})).unwrap();
        let proposal = stage_proposal(&profile, &mut metadata, input(vec![update])).unwrap();
        decide_proposal(
            &mut profile,
            &mut metadata,
            proposal.input.id,
            ProposalStatus::Accepted,
        )
        .unwrap();
        assert_eq!(
            profile.skills[0].activation,
            Some(SkillActivation::OnDemand)
        );
        assert_eq!(profile.skills[0].support_files, skill.support_files);
        let change: Operation = serde_json::from_value(json!({"kind":"skillUpdate","id":skill.id,"beforeName":"Review","beforeInstructions":"Updated","beforeActivation":"onDemand","beforeSupportFiles":skill.support_files,"name":"Review","instructions":"Updated","activation":"alwaysOn"})).unwrap();
        let proposal = stage_proposal(&profile, &mut metadata, input(vec![change])).unwrap();
        decide_proposal(
            &mut profile,
            &mut metadata,
            proposal.input.id,
            ProposalStatus::Accepted,
        )
        .unwrap();
        assert_eq!(
            profile.skills[0].activation,
            Some(SkillActivation::AlwaysOn)
        );
        assert_eq!(profile.skills[0].support_files, skill.support_files);
    }
    #[test]
    fn acceptance_preserves_unrelated_changes_and_is_idempotent() {
        let unrelated = WorkspaceSkill {
            id: Uuid::new_v4(),
            name: "Review".into(),
            instructions: "Check errors".into(),
            activation: None,
            support_files: Default::default(),
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
                    activation: None,
                    support_files: Default::default(),
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
    fn skill_update_preserves_omitted_files_and_persists_explicit_empty_files() {
        for replacement in [
            None,
            Some(json!({})),
            Some(json!({"references/new.md":"New"})),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let skill: WorkspaceSkill = serde_json::from_value(json!({"id":Uuid::new_v4(),"name":"Review","instructions":"Check fixture.","supportFiles":{"references/original.md":"Original"}})).unwrap();
            let saved = WorkspaceProfile {
                skills: vec![skill.clone()],
                ..Default::default()
            };
            crate::workspace::write_profile(
                &crate::workspace::account_profile_path(directory.path(), "owner"),
                &saved,
            )
            .unwrap();
            let mut operation = json!({"kind":"skillUpdate","id":skill.id,"beforeName":skill.name,"beforeInstructions":skill.instructions,"beforeSupportFiles":skill.support_files,"name":"Review","instructions":"Check updated fixture."});
            if let Some(files) = &replacement {
                operation["supportFiles"] = files.clone();
            }
            let expected = replacement
                .clone()
                .unwrap_or_else(|| json!(skill.support_files));
            let input = super::tests::input(vec![serde_json::from_value(operation).unwrap()]);
            let id = input.id;
            mutate_account_record(directory.path(), "owner", |profile, metadata| {
                stage_proposal(profile, metadata, input)
            })
            .unwrap();
            let staged = mutate_account_record(directory.path(), "owner", |_profile, metadata| {
                read_proposals(metadata)
            })
            .unwrap();
            let encoded = serde_json::to_value(&staged[0]).unwrap();
            assert_eq!(
                encoded["operations"][0].get("supportFiles"),
                replacement.as_ref()
            );
            mutate_account_record(directory.path(), "owner", |profile, metadata| {
                decide_proposal(profile, metadata, id, ProposalStatus::Accepted)
            })
            .unwrap();
            let (profile, receipts) =
                mutate_account_record(directory.path(), "owner", |profile, metadata| {
                    Ok((profile.clone(), read_proposals(metadata)?))
                })
                .unwrap();
            assert_eq!(json!(profile.skills[0].support_files), expected);
            assert_eq!(profile.skills[0].instructions, "Check updated fixture.");
            assert_eq!(receipts[0].status, ProposalStatus::Accepted);
        }
    }

    #[test]
    fn skill_update_refuses_null_support_files() {
        let operation = json!({"kind":"skillUpdate","id":Uuid::new_v4(),"beforeName":"Review","beforeInstructions":"Before","name":"Review","instructions":"After","supportFiles":null});
        assert!(serde_json::from_value::<Operation>(operation).is_err());
    }

    #[test]
    fn full_sized_support_package_can_be_updated_with_exact_previous_files() {
        let skill: WorkspaceSkill = serde_json::from_value(json!({"id":Uuid::new_v4(),"name":"Review","instructions":"Check fixture.","supportFiles":{"references/a.md":"a".repeat(64_000),"references/b.md":"b".repeat(64_000)}})).unwrap();
        let profile = WorkspaceProfile {
            skills: vec![skill.clone()],
            ..Default::default()
        };
        let update = input(vec![Operation::SkillUpdate {
            id: skill.id,
            before_name: skill.name.clone(),
            before_instructions: skill.instructions.clone(),
            before_activation: None,
            before_support_files: skill.support_files.clone(),
            name: skill.name,
            instructions: skill.instructions,
            activation: None,
            support_files: Some(BTreeMap::from([
                ("references/a.md".into(), "c".repeat(64_000)),
                ("references/b.md".into(), "d".repeat(64_000)),
            ])),
        }]);
        assert!(stage_proposal(&profile, &mut json!({}), update).is_ok());
    }

    #[test]
    fn support_package_lifecycle_is_atomic_reviewed_and_stale_safe() {
        let mut profile = WorkspaceProfile::default();
        let mut metadata = json!({});
        let skill:WorkspaceSkill=serde_json::from_value(json!({"id":Uuid::new_v4(),"name":"Review","instructions":"Check fixture.","supportFiles":{"scripts/check.py":"print(1)","references/old.md":"Old guide"}})).unwrap();
        let create = stage_proposal(
            &profile,
            &mut metadata,
            input(vec![Operation::SkillCreate {
                skill: skill.clone(),
            }]),
        )
        .unwrap();
        assert!(profile.skills.is_empty());
        decide_proposal(
            &mut profile,
            &mut metadata,
            create.input.id,
            ProposalStatus::Accepted,
        )
        .unwrap();
        assert_eq!(profile.skills[0], skill);
        let new_files = BTreeMap::from([
            ("scripts/check.py".into(), "print(2)".into()),
            ("references/new.md".into(), "New guide".into()),
        ]);
        let update = stage_proposal(
            &profile,
            &mut metadata,
            input(vec![Operation::SkillUpdate {
                id: skill.id,
                before_name: skill.name.clone(),
                before_instructions: skill.instructions.clone(),
                before_activation: None,
                before_support_files: skill.support_files.clone(),
                name: skill.name.clone(),
                instructions: skill.instructions.clone(),
                activation: None,
                support_files: Some(new_files.clone()),
            }]),
        )
        .unwrap();
        profile.skills[0]
            .support_files
            .insert("scripts/check.py".into(), "Independent change".into());
        let snapshot = (profile.clone(), metadata.clone());
        assert_eq!(
            decide_proposal(
                &mut profile,
                &mut metadata,
                update.input.id,
                ProposalStatus::Accepted
            )
            .unwrap_err()
            .status,
            axum::http::StatusCode::CONFLICT
        );
        assert_eq!((profile.clone(), metadata.clone()), snapshot);
        profile.skills[0] = skill.clone();
        decide_proposal(
            &mut profile,
            &mut metadata,
            update.input.id,
            ProposalStatus::Accepted,
        )
        .unwrap();
        assert_eq!(profile.skills[0].support_files, new_files);
        let remove = stage_proposal(
            &profile,
            &mut metadata,
            input(vec![Operation::SkillRemove {
                id: skill.id,
                before_name: skill.name,
                before_instructions: skill.instructions,
                before_activation: None,
                before_support_files: new_files,
            }]),
        )
        .unwrap();
        decide_proposal(
            &mut profile,
            &mut metadata,
            remove.input.id,
            ProposalStatus::Accepted,
        )
        .unwrap();
        assert!(profile.skills.is_empty());
        assert_eq!(
            read_proposals(&metadata)
                .unwrap()
                .iter()
                .map(|proposal| proposal.status)
                .collect::<Vec<_>>(),
            vec![ProposalStatus::Accepted; 3]
        );
    }

    #[test]
    fn conflicting_skill_edits_and_duplicate_stage_ids_are_refused() {
        let skill = WorkspaceSkill {
            id: Uuid::new_v4(),
            name: "Review".into(),
            instructions: "Check errors".into(),
            activation: None,
            support_files: Default::default(),
        };
        let mut profile = WorkspaceProfile {
            skills: vec![skill.clone()],
            ..Default::default()
        };
        let suggestion = input(vec![Operation::SkillUpdate {
            id: skill.id,
            before_name: skill.name,
            before_instructions: skill.instructions,
            before_activation: None,
            before_support_files: skill.support_files,
            support_files: None,
            name: "Review".into(),
            instructions: "Check async boundaries".into(),
            activation: None,
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
    fn full_escaped_two_package_profile_can_review_an_exact_update_without_dropping_other_files() {
        let directory = tempfile::tempdir().unwrap();
        let skill:WorkspaceSkill=serde_json::from_value(json!({"id":Uuid::new_v4(),"name":"First","instructions":"Check fixture.","supportFiles":{"references/a.md":"\\".repeat(64_000),"references/b.md":"\\".repeat(64_000)}})).unwrap();
        let second = WorkspaceSkill {
            id: Uuid::new_v4(),
            name: "Second".into(),
            ..skill.clone()
        };
        let original = WorkspaceProfile {
            skills: vec![skill.clone(), second.clone()],
            ..Default::default()
        };
        crate::workspace::write_profile(
            &crate::workspace::account_profile_path(directory.path(), "owner"),
            &original,
        )
        .unwrap();
        let changed = BTreeMap::from([
            ("references/a.md".into(), "\"".repeat(64_000)),
            ("references/b.md".into(), "\"".repeat(64_000)),
        ]);
        let update = mutate_account_record(directory.path(), "owner", |profile, metadata| {
            stage_proposal(
                profile,
                metadata,
                super::tests::input(vec![Operation::SkillUpdate {
                    id: skill.id,
                    before_name: skill.name.clone(),
                    before_instructions: skill.instructions.clone(),
                    before_activation: None,
                    before_support_files: skill.support_files.clone(),
                    name: skill.name.clone(),
                    instructions: skill.instructions.clone(),
                    activation: None,
                    support_files: Some(changed.clone()),
                }]),
            )
        })
        .unwrap();
        mutate_account_record(directory.path(), "owner", |profile, metadata| {
            decide_proposal(profile, metadata, update.input.id, ProposalStatus::Accepted)
        })
        .unwrap();
        let (profile, receipts) =
            mutate_account_record(directory.path(), "owner", |profile, metadata| {
                Ok((profile.clone(), read_proposals(metadata)?))
            })
            .unwrap();
        assert_eq!(profile.skills[0].support_files, changed);
        assert_eq!(profile.skills[1], second);
        assert_eq!(receipts[0].status, ProposalStatus::Accepted);
        assert_eq!(
            receipts[0].input.operations[0],
            Operation::SkillUpdate {
                id: skill.id,
                before_name: skill.name.clone(),
                before_instructions: skill.instructions.clone(),
                before_activation: None,
                before_support_files: skill.support_files,
                name: skill.name,
                instructions: skill.instructions,
                support_files: Some(profile.skills[0].support_files.clone()),
                activation: None,
            }
        );
    }

    #[test]
    fn maximum_escaped_package_persists_edits_and_deletion_while_pruning_only_reviewed_receipts() {
        let directory = tempfile::tempdir().unwrap();
        let skill:WorkspaceSkill=serde_json::from_value(json!({"id":Uuid::new_v4(),"name":"Review","instructions":"Check fixture.","supportFiles":{"references/a.md":"\\".repeat(64_000),"references/b.md":"\\".repeat(64_000)}})).unwrap();
        let create = mutate_account_record(directory.path(), "owner", |profile, metadata| {
            stage_proposal(
                profile,
                metadata,
                super::tests::input(vec![Operation::SkillCreate {
                    skill: skill.clone(),
                }]),
            )
        })
        .unwrap();
        mutate_account_record(directory.path(), "owner", |profile, metadata| {
            decide_proposal(profile, metadata, create.input.id, ProposalStatus::Accepted)
        })
        .unwrap();
        let pending = mutate_account_record(directory.path(), "owner", |profile, metadata| {
            stage_proposal(
                profile,
                metadata,
                super::tests::input(vec![Operation::MemoryAppend {
                    content: "Keep pending fixture".into(),
                }]),
            )
        })
        .unwrap();
        let next_files = BTreeMap::from([
            ("references/a.md".into(), "\"".repeat(64_000)),
            ("references/b.md".into(), "\"".repeat(64_000)),
        ]);
        let update = mutate_account_record(directory.path(), "owner", |profile, metadata| {
            stage_proposal(
                profile,
                metadata,
                super::tests::input(vec![Operation::SkillUpdate {
                    id: skill.id,
                    before_name: skill.name.clone(),
                    before_instructions: skill.instructions.clone(),
                    before_activation: None,
                    before_support_files: skill.support_files.clone(),
                    name: skill.name.clone(),
                    instructions: skill.instructions.clone(),
                    activation: None,
                    support_files: Some(next_files.clone()),
                }]),
            )
        })
        .unwrap();
        mutate_account_record(directory.path(), "owner", |profile, metadata| {
            decide_proposal(profile, metadata, update.input.id, ProposalStatus::Accepted)
        })
        .unwrap();
        let mut current_files = next_files;
        for index in 0..3 {
            let content = if index % 2 == 0 { "\\" } else { "\"" };
            let updated = BTreeMap::from([
                ("references/a.md".into(), content.repeat(64_000)),
                ("references/b.md".into(), content.repeat(64_000)),
            ]);
            let proposal = mutate_account_record(directory.path(), "owner", |profile, metadata| {
                stage_proposal(
                    profile,
                    metadata,
                    super::tests::input(vec![Operation::SkillUpdate {
                        id: skill.id,
                        before_name: skill.name.clone(),
                        before_instructions: skill.instructions.clone(),
                        before_activation: None,
                        before_support_files: current_files.clone(),
                        name: skill.name.clone(),
                        instructions: skill.instructions.clone(),
                        activation: None,
                        support_files: Some(updated.clone()),
                    }]),
                )
            })
            .unwrap();
            mutate_account_record(directory.path(), "owner", |profile, metadata| {
                decide_proposal(
                    profile,
                    metadata,
                    proposal.input.id,
                    ProposalStatus::Accepted,
                )
            })
            .unwrap();
            current_files = updated;
        }
        let remove = mutate_account_record(directory.path(), "owner", |profile, metadata| {
            stage_proposal(
                profile,
                metadata,
                super::tests::input(vec![Operation::SkillRemove {
                    id: skill.id,
                    before_name: skill.name,
                    before_instructions: skill.instructions,
                    before_activation: None,
                    before_support_files: current_files,
                }]),
            )
        })
        .unwrap();
        mutate_account_record(directory.path(), "owner", |profile, metadata| {
            decide_proposal(profile, metadata, remove.input.id, ProposalStatus::Accepted)
        })
        .unwrap();
        let (profile, proposals) =
            mutate_account_record(directory.path(), "owner", |profile, metadata| {
                Ok((profile.clone(), read_proposals(metadata)?))
            })
            .unwrap();
        assert!(profile.skills.is_empty());
        assert_eq!(
            proposals
                .iter()
                .find(|proposal| proposal.input.id == pending.input.id)
                .unwrap()
                .status,
            ProposalStatus::Pending
        );
        assert_eq!(
            proposals
                .iter()
                .find(|proposal| proposal.input.id == remove.input.id)
                .unwrap()
                .status,
            ProposalStatus::Accepted
        );
        assert!(!proposals
            .iter()
            .any(|proposal| proposal.input.id == create.input.id));
        let bytes = std::fs::metadata(crate::workspace::account_profile_path(
            directory.path(),
            "owner",
        ))
        .unwrap()
        .len();
        assert!(bytes <= KNOWLEDGE_RECORD_BYTES as u64);
    }

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
                            activation: None,
                            support_files: Default::default(),
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

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_http_preserves_saved_provider_and_distinguishes_omitted_and_empty_skill_files(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: directory.path().into(),
            jwt_secret: "default-package-test".into(),
            ..Default::default()
        };
        let app = crate::app(AppState::new_with_external_auth(config, None).unwrap());
        let token = crate::auth::issue_access_token("default-package-test", "owner", "owner");
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", directory.path().to_str().unwrap())
            .finish();
        let profile_url = format!("/api/workspace/profile?{query}");
        let skill_id = Uuid::new_v4();
        let provider = "v4-profile:chat:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002";
        let original = json!({"defaultAgent":provider,"selection":{"model":"fixture","reasoning":""},"memory":"","skills":[{"id":skill_id,"name":"Review","instructions":"Before","supportFiles":{"references/guide.md":"Keep"}}]});
        assert_eq!(
            request(
                app.clone(),
                "PUT",
                &profile_url,
                Some(&token),
                original.clone()
            )
            .await,
            (StatusCode::OK, original.clone())
        );
        let mut instructions = "Before";
        for replacement in [None, Some(json!({}))] {
            let id = Uuid::new_v4();
            let next = if replacement.is_none() {
                "After omitted"
            } else {
                "After empty"
            };
            let mut operation = json!({"kind":"skillUpdate","id":skill_id,"beforeName":"Review","beforeInstructions":instructions,"beforeSupportFiles":{"references/guide.md":"Keep"},"name":"Review","instructions":next});
            if let Some(files) = &replacement {
                operation["supportFiles"] = files.clone();
            }
            let suggestion = json!({"id":id,"title":"Update review","reason":"Synthetic fixture","operations":[operation]});
            let staged = request(
                app.clone(),
                "POST",
                &format!("/api/workspace/proposals?{query}"),
                Some(&token),
                suggestion,
            )
            .await;
            assert_eq!(staged.0, StatusCode::OK);
            assert_eq!(
                staged.1["proposal"]["operations"][0].get("supportFiles"),
                replacement.as_ref()
            );
            assert_eq!(
                request(
                    app.clone(),
                    "POST",
                    &format!("/api/workspace/proposals/{id}/accept?{query}"),
                    Some(&token),
                    Value::Null
                )
                .await
                .0,
                StatusCode::OK
            );
            let saved = request(app.clone(), "GET", &profile_url, Some(&token), Value::Null).await;
            let expected_files = replacement
                .clone()
                .unwrap_or_else(|| json!({"references/guide.md":"Keep"}));
            assert_eq!(saved.0, StatusCode::OK);
            assert_eq!(saved.1["defaultAgent"], provider);
            assert_eq!(saved.1["selection"], original["selection"]);
            assert_eq!(saved.1["skills"][0]["instructions"], next);
            assert_eq!(
                saved.1["skills"][0]
                    .get("supportFiles")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                expected_files
            );
            instructions = next;
        }
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

    #[tokio::test]
    async fn profile_routes_preserve_on_demand_and_reject_legacy_downgrades() {
        let directory = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: directory.path().into(),
            jwt_secret: "activation-fixture".into(),
            ..Default::default()
        };
        let app = crate::app(AppState::new_with_external_auth(config, None).unwrap());
        let owner = crate::auth::issue_access_token("activation-fixture", "owner-one", "one");
        let other = crate::auth::issue_access_token("activation-fixture", "owner-two", "two");
        let workspace = tempfile::tempdir().unwrap();
        let workspace_url = format!(
            "/api/workspace/profile?path={}",
            url::form_urlencoded::byte_serialize(workspace.path().to_string_lossy().as_bytes())
                .collect::<String>()
        );
        let skill = json!({"id":Uuid::new_v4(),"name":"Review","instructions":"Check", "activation":"onDemand", "supportFiles":{"refs/a.md":"Keep"}});
        let profile =
            json!({"memory":"Keep", "skills":[skill], "defaultAgent":"", "selection":null});
        for url in ["/api/account/knowledge", workspace_url.as_str()] {
            assert_eq!(
                request(app.clone(), "PUT", url, Some(&owner), profile.clone())
                    .await
                    .0,
                StatusCode::OK
            );
            assert_eq!(
                request(app.clone(), "GET", url, Some(&owner), Value::Null)
                    .await
                    .1,
                profile
            );
            assert_eq!(
                request(app.clone(), "GET", url, Some(&other), Value::Null)
                    .await
                    .1["skills"],
                json!([])
            );
            let mut old_client = profile.clone();
            old_client["skills"][0]
                .as_object_mut()
                .unwrap()
                .remove("activation");
            assert_eq!(
                request(app.clone(), "PUT", url, Some(&owner), old_client)
                    .await
                    .0,
                StatusCode::CONFLICT
            );
            assert_eq!(
                request(app.clone(), "GET", url, Some(&owner), Value::Null)
                    .await
                    .1,
                profile
            );
        }
    }

    #[tokio::test]
    async fn account_knowledge_routes_require_auth_and_review_is_owner_isolated() {
        let directory = tempfile::tempdir().unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: directory.path().into(),
            jwt_secret: "account-knowledge-fixture".into(),
            ..Default::default()
        };
        let app = crate::app(AppState::new_with_external_auth(config, None).unwrap());
        let owner =
            crate::auth::issue_access_token("account-knowledge-fixture", "owner-one", "one");
        let other =
            crate::auth::issue_access_token("account-knowledge-fixture", "owner-two", "two");
        let base = "/api/account/knowledge";
        assert_eq!(
            request(app.clone(), "GET", base, None, Value::Null).await.0,
            StatusCode::UNAUTHORIZED
        );
        let id = Uuid::new_v4();
        let input = json!({"id":id,"title":"Own skill","reason":"Synthetic fixture","operations":[{"kind":"memoryAppend","content":"Fixture account memory"},{"kind":"skillCreate","skill":{"id":Uuid::new_v4(),"name":"Review","instructions":"Check fixture.","supportFiles":{"scripts/check.py":"print(42)\n"}}}]});
        let staged = request(
            app.clone(),
            "POST",
            "/api/account/knowledge/proposals",
            Some(&owner),
            input,
        )
        .await;
        assert_eq!(
            (staged.0, staged.1["proposal"]["status"].clone()),
            (StatusCode::OK, json!("pending"))
        );
        assert_eq!(
            request(app.clone(), "GET", base, Some(&owner), Value::Null)
                .await
                .1["memory"],
            ""
        );
        assert_eq!(
            request(
                app.clone(),
                "GET",
                "/api/account/knowledge/proposals",
                Some(&other),
                Value::Null
            )
            .await
            .1,
            json!({"proposals":[]})
        );
        let accept = format!("/api/account/knowledge/proposals/{id}/accept");
        assert_eq!(
            request(app.clone(), "POST", &accept, Some(&other), Value::Null)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        let accepted = request(app.clone(), "POST", &accept, Some(&owner), Value::Null).await;
        assert_eq!(
            (
                accepted.0,
                accepted.1["profile"]["memory"].clone(),
                accepted.1["profile"]["skills"][0]["supportFiles"]["scripts/check.py"].clone()
            ),
            (
                StatusCode::OK,
                json!("Fixture account memory"),
                json!("print(42)\n")
            )
        );
        assert_eq!(
            request(app.clone(), "GET", base, Some(&other), Value::Null)
                .await
                .1["memory"],
            ""
        );
        let mut manual = accepted.1["profile"].clone();
        manual["memory"] = json!("Manual account edit");
        assert_eq!(
            request(app.clone(), "PUT", base, Some(&owner), manual)
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            request(
                app,
                "GET",
                "/api/account/knowledge/proposals",
                Some(&owner),
                Value::Null
            )
            .await
            .1["proposals"][0]["status"],
            "accepted"
        );
    }
}
