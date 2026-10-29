use serde::Deserialize;
use std::path::{Component, Path, PathBuf};

const PLAYWRIGHT_VERSION: &str = "1.64.1";
const NODE_VERSION: &str = "22.23.1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    platform: String,
    arch: String,
    node_version: String,
    playwright_version: String,
    chromium_revision: String,
    chromium_version: String,
    node: String,
    chromium: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BrowserRuntime {
    pub root: PathBuf,
    pub node: PathBuf,
    pub chromium: PathBuf,
}

pub(crate) fn resolve() -> Result<BrowserRuntime, String> {
    let explicit = std::env::var_os("TERMINAL_V4_BROWSER_RUNTIME_DIR").map(PathBuf::from);
    let runtime_root = std::env::var_os("TERMINAL_V4_RUNTIME_ROOT").map(PathBuf::from);
    let executable = std::env::current_exe().ok();
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    resolve_from(
        explicit.as_deref(),
        runtime_root.as_deref(),
        executable.as_deref(),
        &checkout,
    )
}

fn resolve_from(
    explicit: Option<&Path>,
    runtime_root: Option<&Path>,
    executable: Option<&Path>,
    checkout: &Path,
) -> Result<BrowserRuntime, String> {
    if let Some(root) = explicit {
        return validate(root)
            .map_err(|error| format!("Invalid explicit TERMINAL_V4_BROWSER_RUNTIME_DIR: {error}"));
    }
    let mut candidates = Vec::new();
    if let Some(root) = runtime_root {
        candidates.push(root.join("browser-runtime"));
    }
    if let Some(directory) = executable.and_then(Path::parent) {
        candidates.push(directory.join("browser-runtime"));
    }
    candidates.push(checkout.join(".runtime/browser"));
    for root in candidates {
        if root.try_exists().map_err(|error| {
            format!("Cannot inspect browser runtime {}: {error}", root.display())
        })? {
            return validate(&root);
        }
    }
    Err("App-owned browser runtime is missing. Run `npm run browser:install` in the checkout, or reinstall the desktop app with its browser-runtime resources.".into())
}

fn read_json(file: &Path) -> Result<serde_json::Value, String> {
    let bytes =
        std::fs::read(file).map_err(|error| format!("Cannot read {}: {error}", file.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid JSON at {}: {error}", file.display()))
}

fn owned_file(root: &Path, relative: &str, executable: bool) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains(['\\', ':'])
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("Invalid browser runtime relative path: {relative}"));
    }
    let file = root
        .join(path)
        .canonicalize()
        .map_err(|error| format!("Missing browser runtime file {relative}: {error}"))?;
    if !file.starts_with(root) || !file.is_file() {
        return Err(format!(
            "Browser runtime file is outside its root or not a file: {relative}"
        ));
    }
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "Browser runtime file is not executable: {relative}"
            ));
        }
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(file)
}

fn validate(root: &Path) -> Result<BrowserRuntime, String> {
    if root.as_os_str().is_empty() {
        return Err("Browser runtime directory is empty".into());
    }
    let root = root.canonicalize().map_err(|error| {
        format!(
            "Invalid browser runtime directory {}: {error}",
            root.display()
        )
    })?;
    let manifest: Manifest = serde_json::from_value(read_json(&root.join("runtime.json"))?)
        .map_err(|error| format!("Invalid browser runtime manifest: {error}"))?;
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    if manifest.schema_version != 1
        || manifest.platform != platform
        || manifest.arch != arch
        || manifest.node_version != NODE_VERSION
        || manifest.playwright_version != PLAYWRIGHT_VERSION
    {
        return Err(format!("Incompatible browser runtime manifest at {} (expected {platform}/{arch}, Node {NODE_VERSION}, Playwright {PLAYWRIGHT_VERSION})", root.display()));
    }
    let node = owned_file(&root, &manifest.node, true)?;
    let chromium = owned_file(&root, &manifest.chromium, true)?;
    for name in ["playwright", "playwright-core"] {
        let package = read_json(&owned_file(
            &root,
            &format!("node_modules/{name}/package.json"),
            false,
        )?)?;
        if package["version"].as_str() != Some(PLAYWRIGHT_VERSION) {
            return Err(format!(
                "Expected {name}@{PLAYWRIGHT_VERSION} in browser runtime"
            ));
        }
        owned_file(&root, &format!("node_modules/{name}/index.js"), false)?;
    }
    let browsers = read_json(&owned_file(
        &root,
        "node_modules/playwright-core/browsers.json",
        false,
    )?)?;
    let descriptor = browsers["browsers"]
        .as_array()
        .and_then(|entries| entries.iter().find(|entry| entry["name"] == "chromium"))
        .ok_or("Missing pinned Chromium descriptor")?;
    if descriptor["revision"].as_str() != Some(&manifest.chromium_revision)
        || descriptor["browserVersion"].as_str() != Some(&manifest.chromium_version)
        || !manifest.chromium.starts_with(&format!(
            "browsers/chromium-{}/",
            manifest.chromium_revision
        ))
    {
        return Err("Browser runtime Chromium does not match pinned Playwright".into());
    }
    Ok(BrowserRuntime {
        root,
        node,
        chromium,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(root: &Path) -> BrowserRuntime {
        let node = root.join("node/bin/node");
        let chromium = root.join("browsers/chromium-1248/chrome");
        for file in [&node, &chromium] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "fixture").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        for name in ["playwright", "playwright-core"] {
            let package = root.join("node_modules").join(name);
            std::fs::create_dir_all(&package).unwrap();
            std::fs::write(package.join("package.json"), r#"{"version":"1.64.1"}"#).unwrap();
            std::fs::write(package.join("index.js"), "fixture").unwrap();
        }
        std::fs::write(root.join("node_modules/playwright-core/browsers.json"), r#"{"browsers":[{"name":"chromium","revision":"1248","browserVersion":"156.0.8078.4"}]}"#).unwrap();
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            other => other,
        };
        std::fs::write(root.join("runtime.json"), serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "platform": match std::env::consts::OS { "macos" => "darwin", "windows" => "win32", other => other },
            "arch": arch,
            "nodeVersion": "22.23.1",
            "playwrightVersion": "1.64.1",
            "chromiumRevision": "1248",
            "chromiumVersion": "156.0.8078.4",
            "node": "node/bin/node",
            "chromium": "browsers/chromium-1248/chrome"
        })).unwrap()).unwrap();
        BrowserRuntime {
            root: root.canonicalize().unwrap(),
            node: node.canonicalize().unwrap(),
            chromium: chromium.canonicalize().unwrap(),
        }
    }

    #[test]
    fn explicit_runtime_wins_and_invalid_explicit_never_falls_back() {
        let temp = tempfile::tempdir().unwrap();
        let checkout = temp.path().join("checkout");
        fixture(&checkout.join(".runtime/browser"));
        let explicit = temp.path().join("custom runtime");
        let expected = fixture(&explicit);
        assert_eq!(
            resolve_from(Some(&explicit), None, None, &checkout),
            Ok(expected)
        );
        assert!(
            resolve_from(Some(&temp.path().join("missing")), None, None, &checkout)
                .unwrap_err()
                .contains("explicit")
        );
        assert!(resolve_from(Some(Path::new("")), None, None, &checkout).is_err());
    }

    #[test]
    fn packaged_resources_then_executable_sibling_then_checkout_are_selected() {
        let temp = tempfile::tempdir().unwrap();
        let resources = temp.path().join("Resources");
        let executable = temp.path().join("bin/api");
        let checkout = temp.path().join("checkout");
        let dev = fixture(&checkout.join(".runtime/browser"));
        assert_eq!(resolve_from(None, None, None, &checkout), Ok(dev));
        let sibling = fixture(&temp.path().join("bin/browser-runtime"));
        assert_eq!(
            resolve_from(None, None, Some(&executable), &checkout),
            Ok(sibling)
        );
        let bundled = fixture(&resources.join("browser-runtime"));
        assert_eq!(
            resolve_from(None, Some(&resources), Some(&executable), &checkout),
            Ok(bundled)
        );
    }

    #[test]
    fn malformed_packaged_runtime_does_not_silently_use_checkout() {
        let temp = tempfile::tempdir().unwrap();
        fixture(&temp.path().join(".runtime/browser"));
        let resources = temp.path().join("Resources");
        std::fs::create_dir_all(resources.join("browser-runtime")).unwrap();
        assert!(resolve_from(None, Some(&resources), None, temp.path()).is_err());
    }

    #[test]
    fn incompatible_manifests_and_missing_packages_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        fixture(&root);
        let manifest_file = root.join("runtime.json");
        let original: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_file).unwrap()).unwrap();
        for (field, value) in [
            ("schemaVersion", json!(2)),
            ("platform", json!("wrong")),
            ("arch", json!("wrong")),
            ("nodeVersion", json!("1.0.0")),
            ("playwrightVersion", json!("1.0.0")),
            ("chromiumRevision", json!("9999")),
            ("chromiumVersion", json!("wrong")),
            ("node", json!("../outside")),
            ("node", json!("/absolute")),
            ("node", json!("C:\\node.exe")),
            ("chromium", json!("missing-browser")),
        ] {
            let mut manifest = original.clone();
            manifest[field] = value;
            std::fs::write(&manifest_file, serde_json::to_vec(&manifest).unwrap()).unwrap();
            assert!(
                resolve_from(Some(&root), None, None, temp.path()).is_err(),
                "accepted {field}"
            );
        }
        std::fs::write(&manifest_file, serde_json::to_vec(&original).unwrap()).unwrap();
        std::fs::remove_file(root.join("node_modules/playwright/index.js")).unwrap();
        assert!(resolve_from(Some(&root), None, None, temp.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn external_symlinks_and_nonexecutable_engines_are_rejected() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtime");
        let runtime = fixture(&root);
        std::fs::set_permissions(&runtime.chromium, std::fs::Permissions::from_mode(0o644))
            .unwrap();
        assert!(resolve_from(Some(&root), None, None, temp.path()).is_err());
        std::fs::set_permissions(&runtime.chromium, std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let outside = temp.path().join("external-node");
        std::fs::rename(&runtime.node, &outside).unwrap();
        symlink(outside, &runtime.node).unwrap();
        assert!(resolve_from(Some(&root), None, None, temp.path()).is_err());
    }

    #[test]
    fn missing_runtime_reports_install_instructions() {
        let temp = tempfile::tempdir().unwrap();
        let error = resolve_from(None, None, None, temp.path()).unwrap_err();
        assert!(error.contains("npm run browser:install"));
    }
}
