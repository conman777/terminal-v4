//! Opens a workspace folder in a desktop editor on the host, like T3 Code's "Open in Cursor".
use crate::{auth::AuthenticatedUser, state::AppState, ApiError};
use axum::{routing::get, routing::post, Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub(crate) struct Editor {
    pub id: &'static str,
    pub label: &'static str,
    mac_app: &'static str,
    command: &'static str,
}

const EDITORS: [Editor; 3] = [
    Editor {
        id: "cursor",
        label: "Cursor",
        mac_app: "Cursor",
        command: "cursor",
    },
    Editor {
        id: "vscode",
        label: "VS Code",
        mac_app: "Visual Studio Code",
        command: "code",
    },
    Editor {
        id: "zed",
        label: "Zed",
        mac_app: "Zed",
        command: "zed",
    },
];

/// Editors present on this host: app bundles on macOS, commands on PATH elsewhere.
pub(crate) fn installed_editors(
    app_roots: &[PathBuf],
    path_dirs: &[PathBuf],
) -> Vec<&'static Editor> {
    EDITORS
        .iter()
        .filter(|editor| {
            if cfg!(target_os = "macos") {
                app_roots
                    .iter()
                    .any(|root| root.join(format!("{}.app", editor.mac_app)).is_dir())
            } else {
                path_dirs
                    .iter()
                    .any(|dir| dir.join(editor.command).is_file())
            }
        })
        .collect()
}

pub(crate) fn launch_command(editor: &Editor, folder: &Path) -> (String, Vec<String>) {
    let folder = folder.to_string_lossy().into_owned();
    if cfg!(target_os = "macos") {
        (
            "open".into(),
            vec!["-a".into(), editor.mac_app.into(), folder],
        )
    } else {
        (editor.command.into(), vec![folder])
    }
}

fn host_app_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    roots
}

fn host_path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default()
}

async fn editors_route(Extension(_user): Extension<AuthenticatedUser>) -> Json<Value> {
    let editors: Vec<Value> = installed_editors(&host_app_roots(), &host_path_dirs())
        .into_iter()
        .map(|editor| json!({ "id": editor.id, "label": editor.label }))
        .collect();
    Json(json!({ "editors": editors }))
}

#[derive(Deserialize)]
struct OpenInput {
    editor: String,
    path: String,
}

async fn open_route(
    Extension(_user): Extension<AuthenticatedUser>,
    Json(input): Json<OpenInput>,
) -> Result<Json<Value>, ApiError> {
    let folder = Path::new(&input.path);
    if input.path.len() > 4096 || !folder.is_absolute() || !folder.is_dir() {
        return Err(ApiError::bad_request(
            "An existing absolute folder is required",
        ));
    }
    let editor = installed_editors(&host_app_roots(), &host_path_dirs())
        .into_iter()
        .find(|editor| editor.id == input.editor)
        .ok_or_else(|| ApiError::bad_request("That editor is not installed on this host"))?;
    let (program, args) = launch_command(editor, folder);
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| ApiError::internal(format!("Could not open {}: {error}", editor.label)))?;
    Ok(Json(json!({ "opened": true, "editor": editor.id })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/system/editors", get(editors_route))
        .route("/api/system/open-in-editor", post(open_route))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_only_editors_installed_on_this_host() {
        let apps = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        std::fs::create_dir(apps.path().join("Cursor.app")).unwrap();
        std::fs::write(bin.path().join("cursor"), "").unwrap();
        let found: Vec<_> = installed_editors(&[apps.path().into()], &[bin.path().into()])
            .into_iter()
            .map(|editor| editor.id)
            .collect();
        assert_eq!(found, ["cursor"]);
    }

    #[test]
    fn opens_the_folder_without_a_shell() {
        let (program, args) = launch_command(&EDITORS[0], Path::new("/work/my project"));
        if cfg!(target_os = "macos") {
            assert_eq!(
                (program.as_str(), args),
                (
                    "open",
                    vec!["-a".into(), "Cursor".into(), "/work/my project".into()]
                )
            );
        } else {
            assert_eq!(
                (program.as_str(), args),
                ("cursor", vec!["/work/my project".to_string()])
            );
        }
    }
}
