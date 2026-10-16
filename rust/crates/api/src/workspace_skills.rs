use crate::{auth::AuthenticatedUser, state::AppState, workspace::profile_path, ApiError};
use axum::{
    extract::{Query, State},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct InstalledSkill {
    id: String,
    provider: String,
    scope: String,
    name: String,
    path: String,
    instructions: String,
}
#[derive(Debug, Serialize)]
struct SkillsResult {
    skills: Vec<InstalledSkill>,
    warnings: Vec<String>,
}
#[derive(Deserialize)]
struct SkillsQuery {
    path: String,
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/workspace/skills", axum::routing::get(list))
}

fn scan_roots(roots: &[(PathBuf, &str, &str)]) -> SkillsResult {
    let mut result = SkillsResult {
        skills: Vec::new(),
        warnings: Vec::new(),
    };
    let mut seen = HashSet::new();
    let mut entries_left = 2000usize;
    let mut bytes_left = 500_000usize;
    for (root, provider, scope) in roots {
        let Ok(root_metadata) = std::fs::symlink_metadata(root) else {
            continue;
        };
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            continue;
        }
        let Ok(canonical_root) = std::fs::canonicalize(root) else {
            continue;
        };
        if !seen.insert(canonical_root.clone()) {
            continue;
        }
        let mut pending = vec![(canonical_root.clone(), 0usize)];
        while let Some((directory, depth)) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(&directory) else {
                result
                    .warnings
                    .push(format!("Unable to read {} skills directory", provider));
                continue;
            };
            let mut entries: Vec<_> = entries
                .take(entries_left.saturating_add(1))
                .filter_map(Result::ok)
                .collect();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                if entries_left == 0 || bytes_left == 0 || result.skills.len() >= 100 {
                    result.warnings.push(
                        "Skill discovery reached its scan limit; some skills were omitted.".into(),
                    );
                    return result;
                }
                entries_left -= 1;
                let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
                    continue;
                };
                if metadata.file_type().is_symlink() {
                    continue;
                }
                let Ok(path) = std::fs::canonicalize(entry.path()) else {
                    continue;
                };
                if !path.starts_with(&canonical_root) {
                    continue;
                }
                if metadata.is_dir() {
                    if depth < 5 {
                        pending.push((path, depth + 1));
                    } else {
                        result.warnings.push(format!(
                            "Skipped deeply nested {} skill directory",
                            provider
                        ));
                    }
                    continue;
                }
                if entry.file_name() != "SKILL.md" || !metadata.is_file() {
                    continue;
                }
                if metadata.len() > 24_000 || metadata.len() as usize > bytes_left {
                    result
                        .warnings
                        .push(format!("Skipped oversized skill: {}", path.display()));
                    continue;
                }
                let Ok(file) = std::fs::File::open(&path) else {
                    continue;
                };
                let mut content = Vec::new();
                if file.take(24_001).read_to_end(&mut content).is_err() || content.len() > 24_000 {
                    continue;
                }
                bytes_left = bytes_left.saturating_sub(content.len());
                let Ok(instructions) = String::from_utf8(content) else {
                    continue;
                };
                if instructions.trim().is_empty() || instructions.chars().count() > 6000 {
                    result.warnings.push(format!(
                        "Skipped skill beyond the editable context limit: {}",
                        path.display()
                    ));
                    continue;
                }
                let name = path
                    .parent()
                    .and_then(Path::file_name)
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                let id = hex::encode(Sha256::digest(
                    format!("{provider}:{scope}:{}", path.display()).as_bytes(),
                ));
                result.skills.push(InstalledSkill {
                    id,
                    provider: (*provider).into(),
                    scope: (*scope).into(),
                    name,
                    path: path.to_string_lossy().into_owned(),
                    instructions,
                });
            }
        }
    }
    result.skills.sort_by(|left, right| {
        (&left.provider, &left.scope, &left.name, &left.path).cmp(&(
            &right.provider,
            &right.scope,
            &right.name,
            &right.path,
        ))
    });
    result
}

fn skill_roots(workspace: &Path) -> Vec<(PathBuf, &'static str, &'static str)> {
    let mut roots = vec![
        (workspace.join(".agents/skills"), "codex", "project"),
        (workspace.join(".claude/skills"), "claude", "project"),
    ];
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    for (provider, variable, fallback) in [
        ("codex", "CODEX_HOME", ".codex"),
        ("claude", "CLAUDE_CONFIG_DIR", ".claude"),
        ("hermes", "HERMES_HOME", ".hermes"),
    ] {
        let directory = std::env::var_os(variable)
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| home.join(fallback)));
        if let Some(directory) = directory.filter(|path| path.is_absolute()) {
            roots.push((directory.join("skills"), provider, "host"));
        }
    }
    if let Some(home) = home {
        roots.push((home.join(".agents/skills"), "codex", "host"));
    }
    roots.retain(|(root, _, scope)| {
        *scope != "project"
            || std::fs::canonicalize(root).is_ok_and(|root| root.starts_with(workspace))
    });
    roots
}

async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(query): Query<SkillsQuery>,
) -> Result<
    (
        [(axum::http::header::HeaderName, &'static str); 1],
        Json<SkillsResult>,
    ),
    ApiError,
> {
    let directory = state.config().data_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        profile_path(&directory, &user.user_id, &query.path)?;
        let workspace = std::fs::canonicalize(&query.path)
            .map_err(|_| ApiError::bad_request("Workspace directory is unavailable"))?;
        Ok::<_, ApiError>(scan_roots(&skill_roots(&workspace)))
    })
    .await
    .map_err(|_| ApiError::internal("Unable to discover installed skills"))??;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "private, no-store")],
        Json(result),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installed_skills_are_bounded_read_only_context_with_scope_and_provenance() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("skills");
        let skill_dir = root.join("review");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let instructions = "---\nname: review\ndescription: Review changes\n---\nCheck errors.";
        std::fs::write(skill_dir.join("SKILL.md"), instructions).unwrap();
        std::fs::write(skill_dir.join("run.sh"), "do not run this").unwrap();
        let result = scan_roots(&[(root.clone(), "claude", "project")]);
        assert_eq!(
            result
                .skills
                .iter()
                .map(|skill| (
                    skill.provider.as_str(),
                    skill.scope.as_str(),
                    skill.name.as_str(),
                    skill.instructions.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![("claude", "project", "review", instructions)]
        );
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("run.sh")).unwrap(),
            "do not run this"
        );
        assert!(result.warnings.is_empty());
        assert_eq!(
            scan_roots(&[
                (root.clone(), "claude", "project"),
                (root, "claude", "project")
            ])
            .skills
            .len(),
            1
        );
    }
    #[test]
    fn oversized_and_non_utf8_skills_are_omitted_without_truncating_context() {
        let directory = tempfile::tempdir().unwrap();
        for (name, content) in [("large", vec![b'x'; 24001]), ("invalid", vec![255])] {
            let skill_dir = directory.path().join(name);
            std::fs::create_dir_all(&skill_dir).unwrap();
            std::fs::write(skill_dir.join("SKILL.md"), content).unwrap();
        }
        let result = scan_roots(&[(directory.path().into(), "codex", "project")]);
        assert!(result.skills.is_empty());
        assert_eq!(result.warnings.len(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_files_and_directories_cannot_escape_skill_roots() {
        let directory = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        std::fs::write(external.path().join("SKILL.md"), "External skill").unwrap();
        std::os::unix::fs::symlink(external.path(), directory.path().join("linked")).unwrap();
        std::os::unix::fs::symlink(
            external.path().join("SKILL.md"),
            directory.path().join("SKILL.md"),
        )
        .unwrap();
        assert!(scan_roots(&[(directory.path().into(), "codex", "project")])
            .skills
            .is_empty());
    }
}

#[cfg(test)]
mod route_tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    #[tokio::test]
    async fn installed_skill_route_requires_auth_and_reads_real_project_source() {
        let directory = tempfile::tempdir().unwrap();
        let skill_dir = directory.path().join(".claude/skills/project-review");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "Check errors in project changes.",
        )
        .unwrap();
        let config = terminal_v4_core::AppConfig {
            data_dir: directory.path().join("data"),
            jwt_secret: "skills-test-secret".into(),
            ..Default::default()
        };
        let state = AppState::new_with_external_auth(config, None).unwrap();
        let app = routes()
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state);
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", directory.path().to_str().unwrap())
            .finish();
        let uri = format!("/api/workspace/skills?{query}");
        let unauthorized = app
            .clone()
            .oneshot(Request::builder().uri(&uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let token = crate::auth::issue_access_token("skills-test-secret", "owner", "owner");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&uri)
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        let project_skill = payload["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|skill| skill["name"] == "project-review")
            .unwrap();
        assert_eq!(
            (
                project_skill["provider"].clone(),
                project_skill["scope"].clone(),
                project_skill["instructions"].clone()
            ),
            (
                serde_json::json!("claude"),
                serde_json::json!("project"),
                serde_json::json!("Check errors in project changes.")
            )
        );
        let invalid = app
            .oneshot(
                Request::builder()
                    .uri("/api/workspace/skills?path=relative")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    }
}
