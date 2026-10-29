use serde_json::{json, Value};
use std::path::Path;
use tokio::{fs, io::AsyncReadExt};

const MAX_FILE_SIZE: u64 = 1_024 * 1_024; // 1MB
const MAX_TOTAL_SIZE: u64 = 50 * 1_024 * 1_024; // 50MB
const MAX_ENTRIES: usize = 10_000;
const MAX_OMISSIONS: usize = 100;

const EXCLUDE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".output",
    "coverage",
    ".cache",
    ".parcel-cache",
    ".turbo",
    "__pycache__",
    ".pytest_cache",
    ".venv",
    "venv",
    "target",
];

const EXCLUDE_FILES: &[&str] = &[".DS_Store", "Thumbs.db"];

fn is_private_entry(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let safe_example = [".example", ".sample", ".template"]
        .iter()
        .any(|suffix| name.ends_with(suffix));
    if safe_example {
        return false;
    }
    name == ".env"
        || name.starts_with(".env.")
        || [
            ".npmrc",
            ".yarnrc",
            ".yarnrc.yml",
            ".netrc",
            ".pypirc",
            "credentials",
            "credentials.json",
            ".ssh",
            ".aws",
            ".azure",
            ".gnupg",
            ".kube",
            ".gcloud",
            ".credentials",
            ".keys",
            "private_keys",
            "private-keys",
            "secrets",
            ".secrets",
            "id_rsa",
            "id_dsa",
            "id_ecdsa",
            "id_ed25519",
        ]
        .contains(&name.as_str())
        || [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
        || name.ends_with(".json")
            && ["service-account", "service_account", "firebase-adminsdk"]
                .iter()
                .any(|marker| name.contains(marker))
}

#[derive(Default)]
struct Omissions {
    total: usize,
    entries: Vec<Value>,
}

/// Build a WebContainer-compatible file tree for a project directory.
pub async fn get_file_tree(path: &str) -> Result<Value, String> {
    let root = Path::new(path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }

    // Require package.json
    if !root.join("package.json").exists() {
        return Err("Not a Node.js project (no package.json)".to_string());
    }

    let mut total_size: u64 = 0;
    let mut total_entries = 0;
    let mut omissions = Omissions::default();
    let files = build_tree(
        root,
        root,
        &mut total_size,
        &mut total_entries,
        &mut omissions,
    )
    .await?;

    Ok(json!({
        "files": files,
        "omissions": {
            "total": omissions.total,
            "truncated": omissions.total > omissions.entries.len(),
            "entries": omissions.entries,
        },
        "stats": {
            "totalSize": total_size,
            "totalEntries": total_entries,
        }
    }))
}

async fn build_tree(
    base: &Path,
    current: &Path,
    total_size: &mut u64,
    total_entries: &mut usize,
    omissions: &mut Omissions,
) -> Result<Value, String> {
    if current
        .strip_prefix(base)
        .map_err(|e| e.to_string())?
        .components()
        .count()
        > 32
    {
        return Err("Project exceeds 32 directory levels".to_string());
    }
    let mut entries = serde_json::Map::new();
    let mut reader = fs::read_dir(current)
        .await
        .map_err(|e| format!("Failed to read {}: {e}", current.display()))?;

    while let Some(entry) = reader.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Unsupported non-UTF8 project filename".to_string())?;
        let path = entry.path();
        if EXCLUDE_DIRS.contains(&name.as_str()) || EXCLUDE_FILES.contains(&name.as_str()) {
            continue;
        }
        *total_entries += 1;
        if *total_entries > MAX_ENTRIES {
            return Err(format!("Project exceeds {MAX_ENTRIES} entry limit"));
        }
        if is_private_entry(&name) {
            omissions.total += 1;
            if omissions.entries.len() < MAX_OMISSIONS {
                let relative = path.strip_prefix(base).map_err(|e| e.to_string())?;
                let label = relative
                    .to_string_lossy()
                    .replace('\\', "/")
                    .chars()
                    .take(512)
                    .collect::<String>();
                omissions.entries.push(
                    json!({ "path": label, "reason": "Private configuration or key material" }),
                );
            }
            continue;
        }
        if [".", "..", "__proto__", "prototype", "constructor"].contains(&name.as_str())
            || name.contains('\\')
            || name.chars().any(char::is_control)
        {
            return Err(format!("Unsupported project filename: {name}"));
        }
        let metadata = fs::symlink_metadata(&path)
            .await
            .map_err(|e| format!("Failed to inspect {}: {e}", path.display()))?;
        if metadata.is_dir() {
            let subtree = Box::pin(build_tree(
                base,
                &path,
                total_size,
                total_entries,
                omissions,
            ))
            .await?;
            entries.insert(name, json!({ "directory": subtree }));
        } else if metadata.is_file() {
            if metadata.len() > MAX_FILE_SIZE {
                return Err(format!("File exceeds 1MB limit: {}", path.display()));
            }
            if *total_size + metadata.len() > MAX_TOTAL_SIZE {
                return Err("Project exceeds 50MB limit".to_string());
            }
            let file = fs::File::open(&path)
                .await
                .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
            let mut bytes = Vec::new();
            file.take(MAX_FILE_SIZE + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
            if bytes.len() as u64 > MAX_FILE_SIZE {
                return Err(format!("File exceeds 1MB limit: {}", path.display()));
            }
            *total_size += bytes.len() as u64;
            if *total_size > MAX_TOTAL_SIZE {
                return Err("Project exceeds 50MB limit".to_string());
            }
            // JSON byte arrays are restored to Uint8Array by the mount consumer.
            let contents = match String::from_utf8(bytes) {
                Ok(text) => json!(text),
                Err(error) => json!(error.into_bytes()),
            };
            entries.insert(name, json!({ "file": { "contents": contents } }));
        } else {
            return Err(format!(
                "Unsupported project entry (symlink or special file): {}",
                path.display()
            ));
        }
    }
    Ok(Value::Object(entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exports_imported_svg_images_and_fonts_without_changing_bytes() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("package.json"), "{}")
            .await
            .unwrap();
        fs::write(
            root.path().join("main.js"),
            "import './logo.svg'; import './image.PNG'; import './font.woff2';",
        )
        .await
        .unwrap();
        fs::write(root.path().join("logo.svg"), "<svg>✓</svg>")
            .await
            .unwrap();
        let binary = [0, 255, 128, 65];
        fs::write(root.path().join("image.PNG"), binary)
            .await
            .unwrap();
        fs::write(root.path().join("font.woff2"), binary)
            .await
            .unwrap();
        fs::write(root.path().join("runtime.lock"), "required runtime data")
            .await
            .unwrap();
        let tree = get_file_tree(root.path().to_str().unwrap()).await.unwrap();
        assert_eq!(
            tree["files"],
            json!({
                "package.json": {"file":{"contents":"{}"}},
                "main.js": {"file":{"contents":"import './logo.svg'; import './image.PNG'; import './font.woff2';"}},
                "logo.svg": {"file":{"contents":"<svg>✓</svg>"}},
                "image.PNG": {"file":{"contents":binary}},
                "font.woff2": {"file":{"contents":binary}},
                "runtime.lock": {"file":{"contents":"required runtime data"}}
            })
        );
    }

    #[tokio::test]
    async fn rejects_oversized_asset_instead_of_returning_incomplete_project() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("package.json"), "{}")
            .await
            .unwrap();
        fs::write(
            root.path().join("large.png"),
            vec![0; MAX_FILE_SIZE as usize + 1],
        )
        .await
        .unwrap();
        let error = get_file_tree(root.path().to_str().unwrap())
            .await
            .unwrap_err();
        assert!(
            error.contains("large.png") && error.contains("limit"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn rejects_total_size_and_entry_budgets() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("package.json"), "{}")
            .await
            .unwrap();
        for index in 0..50 {
            fs::write(
                root.path().join(format!("asset-{index}.bin")),
                vec![0; MAX_FILE_SIZE as usize],
            )
            .await
            .unwrap();
        }
        assert!(get_file_tree(root.path().to_str().unwrap())
            .await
            .unwrap_err()
            .contains("50MB"));
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("package.json"), "{}")
            .await
            .unwrap();
        for index in 0..10_000 {
            fs::write(root.path().join(format!("entry-{index}")), "")
                .await
                .unwrap();
        }
        assert!(get_file_tree(root.path().to_str().unwrap())
            .await
            .unwrap_err()
            .contains("entry limit"));
    }
}

#[cfg(test)]
mod private_projection_tests {
    use super::*;

    #[tokio::test]
    async fn excludes_known_private_configuration_before_reading_and_preserves_public_examples() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("package.json"), "{}")
            .await
            .unwrap();
        for name in [
            ".env",
            ".env.production",
            ".npmrc",
            "private.pem",
            "credentials.json",
        ] {
            fs::write(root.path().join(name), "SYNTHETIC_PRIVATE_VALUE")
                .await
                .unwrap();
        }
        fs::create_dir(root.path().join(".ssh")).await.unwrap();
        fs::write(root.path().join(".ssh/id_ed25519"), "SYNTHETIC_PRIVATE_KEY")
            .await
            .unwrap();
        for name in [
            ".env.example",
            ".env.production.sample",
            ".npmrc.example",
            "logo.svg",
        ] {
            fs::write(root.path().join(name), "public example")
                .await
                .unwrap();
        }
        let exported = get_file_tree(root.path().to_str().unwrap()).await.unwrap();
        let names = exported["files"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            names,
            [
                "package.json",
                ".env.example",
                ".env.production.sample",
                ".npmrc.example",
                "logo.svg"
            ]
            .into_iter()
            .map(String::from)
            .collect()
        );
        let omitted = exported["omissions"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            omitted,
            [
                ".env",
                ".env.production",
                ".npmrc",
                "private.pem",
                "credentials.json",
                ".ssh"
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(exported["omissions"]["total"], 6);
        assert!(!exported.to_string().contains("SYNTHETIC_PRIVATE"));
    }

    #[tokio::test]
    async fn bounds_private_omission_metadata_without_serializing_contents() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("package.json"), "{}")
            .await
            .unwrap();
        for index in 0..110 {
            fs::write(
                root.path().join(format!(".env.private-{index}")),
                "PRIVATE_SYNTHETIC",
            )
            .await
            .unwrap();
        }
        let exported = get_file_tree(root.path().to_str().unwrap()).await.unwrap();
        assert_eq!(
            (
                exported["omissions"]["total"].as_u64(),
                exported["omissions"]["entries"].as_array().unwrap().len(),
                exported["omissions"]["truncated"].as_bool()
            ),
            (Some(110), 100, Some(true))
        );
        assert!(!exported.to_string().contains("PRIVATE_SYNTHETIC"));
    }
}
