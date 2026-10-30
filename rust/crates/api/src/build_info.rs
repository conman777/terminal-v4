use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(crate) const COMMIT: &str = env!("TERMINAL_V4_BUILD_COMMIT_RESOLVED");
const DIRTY: &str = env!("TERMINAL_V4_BUILD_DIRTY");
const BUILT_AT_UNIX: &str = env!("TERMINAL_V4_BUILT_AT_UNIX");

pub(crate) fn frontend_assets(index_html: &str) -> Vec<String> {
    let reference = regex_lite::Regex::new(r#"\b(?:src|href)\s*=\s*"([^"]*)""#)
        .expect("static asset reference expression");
    let mut assets: Vec<String> = reference
        .captures_iter(index_html)
        .filter_map(|captures| {
            let value = &captures[1];
            let start = value.find("assets/")?;
            let tail = value[start..].split(['?', '#']).next()?;
            (tail.len() > "assets/".len()).then(|| tail.to_string())
        })
        .collect();
    assets.sort();
    assets.dedup();
    assets
}

pub(crate) fn manifest_hash(assets: &[String]) -> String {
    hex::encode(Sha256::digest(assets.join("\n").as_bytes()))
}

fn frontend_section(frontend_dir: &Path) -> Value {
    match std::fs::read_to_string(frontend_dir.join("index.html")) {
        Ok(html) => {
            let assets = frontend_assets(&html);
            json!({
                "available": true,
                "assets": assets,
                "manifestHash": manifest_hash(&assets),
            })
        }
        Err(_) => json!({"available": false, "assets": [], "manifestHash": null}),
    }
}

pub(crate) fn build_info(frontend_dir: &Path, worker_protocol: u64) -> Value {
    json!({
        "commit": COMMIT,
        "dirty": DIRTY == "true",
        "builtAtUnix": BUILT_AT_UNIX.parse::<u64>().unwrap_or(0),
        "apiVersion": env!("CARGO_PKG_VERSION"),
        "workerProtocol": worker_protocol,
        "frontend": frontend_section(frontend_dir),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const INDEX: &str = r#"<script type="module" crossorigin src="/assets/index-AbC.js"></script>
<link rel="modulepreload" href="/assets/vendor-xterm-Q1.js?v=1">
<link rel="stylesheet" href="/assets/index-DeF.css">
<link rel="icon" href="/favicon.svg">
<script src="/assets/index-AbC.js"></script>"#;

    #[test]
    fn frontend_assets_lists_sorted_unique_asset_paths_without_prefix_or_query() {
        assert_eq!(
            frontend_assets(INDEX),
            vec![
                "assets/index-AbC.js",
                "assets/index-DeF.css",
                "assets/vendor-xterm-Q1.js"
            ]
        );
    }

    #[test]
    fn frontend_assets_is_empty_without_asset_references() {
        assert_eq!(frontend_assets("<title>x</title>"), Vec::<String>::new());
    }

    #[test]
    fn manifest_hash_is_sha256_of_newline_joined_assets() {
        let assets = vec!["assets/a.js".to_string(), "assets/b.css".to_string()];
        assert_eq!(
            manifest_hash(&assets),
            hex::encode(Sha256::digest(b"assets/a.js\nassets/b.css"))
        );
    }

    #[test]
    fn build_info_reports_served_frontend_manifest_and_worker_protocol() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), INDEX).unwrap();
        let info = build_info(dir.path(), 7);
        assert_eq!(info["workerProtocol"], 7);
        assert_eq!(info["frontend"]["available"], true);
        assert_eq!(
            info["frontend"]["manifestHash"],
            manifest_hash(&frontend_assets(INDEX))
        );
        assert!(!info["commit"].as_str().unwrap().is_empty());
        assert!(info["builtAtUnix"].is_u64());
    }

    #[test]
    fn build_info_marks_frontend_unavailable_without_index_and_exposes_no_paths() {
        let dir = tempdir().unwrap();
        let info = build_info(&dir.path().join("missing"), 2);
        assert_eq!(
            info["frontend"],
            json!({"available": false, "assets": [], "manifestHash": null})
        );
        let text = info.to_string();
        assert!(!text.contains(dir.path().to_str().unwrap()));
        assert!(!text.contains("/Users/"));
    }
}
