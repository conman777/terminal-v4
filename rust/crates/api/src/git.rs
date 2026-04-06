use std::time::Duration;
use terminal_v4_core::ThreadGitStats;
use tokio::process::Command;

/// Parse `git diff --stat` output to extract insertion/deletion counts.
///
/// Matches patterns like:
///   " 2 files changed, 400 insertions(+), 11 deletions(-)"
///   " 1 file changed, 7 insertions(+)"
///   " 1 file changed, 2 deletions(-)"
pub fn parse_git_diff_stat(output: &str) -> Option<ThreadGitStats> {
    let mut lines_added: i64 = 0;
    let mut lines_removed: i64 = 0;
    let mut found = false;

    for line in output.lines() {
        // Match insertions
        if let Some(count) = extract_stat(line, "insertion") {
            lines_added = count;
            found = true;
        }
        // Match deletions
        if let Some(count) = extract_stat(line, "deletion") {
            lines_removed = count;
            found = true;
        }
    }

    if found {
        Some(ThreadGitStats {
            lines_added,
            lines_removed,
        })
    } else {
        None
    }
}

/// Extract a numeric count preceding a keyword like "insertion" or "deletion".
fn extract_stat(line: &str, keyword: &str) -> Option<i64> {
    let idx = line.find(keyword)?;
    let before = line[..idx].trim_end();
    let parts: Vec<&str> = before.split_whitespace().collect();
    let count_str = parts.last()?;
    // The count is separated by comma or whitespace, strip commas
    let cleaned = count_str.trim_matches(',');
    cleaned.parse::<i64>().ok()
}

/// Run `git diff --stat HEAD` in the given directory. Falls back to `git diff --stat`
/// if HEAD is not available (e.g. in a fresh repo with no commits).
pub async fn get_git_diff_stats(cwd: &str) -> Option<ThreadGitStats> {
    let output = run_git_command(cwd, &["diff", "--stat", "HEAD"], 10).await;
    if let Some(ref text) = output {
        if let Some(stats) = parse_git_diff_stat(text) {
            return Some(stats);
        }
    }

    // Fallback: unstaged diff without HEAD
    let output = run_git_command(cwd, &["diff", "--stat"], 10).await?;
    parse_git_diff_stat(&output)
}

/// Run `git checkout <branch>` with a 15-second timeout.
pub async fn git_checkout(cwd: &str, branch: &str) -> Result<String, String> {
    let trimmed = branch.trim();
    if trimmed.is_empty() {
        return Err("Branch name is required".to_string());
    }

    let output = Command::new("git")
        .args(["checkout", trimmed])
        .current_dir(cwd)
        .output();

    let result = tokio::time::timeout(Duration::from_secs(15), output)
        .await
        .map_err(|_| "git checkout timed out after 15 seconds".to_string())?
        .map_err(|e| format!("Failed to run git checkout: {e}"))?;

    if result.status.success() {
        Ok(String::from_utf8_lossy(&result.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr);
        Err(format!("git checkout failed: {stderr}"))
    }
}

/// List git branches and detect the current branch.
pub async fn list_git_branches(cwd: &str) -> Option<GitBranchInfo> {
    let current = run_git_command(cwd, &["branch", "--show-current"], 5).await?;
    let current_branch = current.trim();
    let current_branch = if current_branch.is_empty() {
        None
    } else {
        Some(current_branch.to_string())
    };

    let branch_output = run_git_command(cwd, &["branch", "--format=%(refname:short)"], 5).await?;
    let branches: Vec<String> = branch_output
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    Some(GitBranchInfo {
        current_branch,
        branches,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub current_branch: Option<String>,
    pub branches: Vec<String>,
}

async fn run_git_command(cwd: &str, args: &[&str], timeout_secs: u64) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output();

    let result = tokio::time::timeout(Duration::from_secs(timeout_secs), output)
        .await
        .ok()?
        .ok()?;

    if result.status.success() {
        Some(String::from_utf8_lossy(&result.stdout).to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_both_insertions_and_deletions() {
        let output = " 2 files changed, 400 insertions(+), 11 deletions(-)";
        let stats = parse_git_diff_stat(output).expect("should parse");
        assert_eq!(
            stats,
            ThreadGitStats {
                lines_added: 400,
                lines_removed: 11
            }
        );
    }

    #[test]
    fn parse_insertions_only() {
        let output = " 1 file changed, 7 insertions(+)";
        let stats = parse_git_diff_stat(output).expect("should parse");
        assert_eq!(
            stats,
            ThreadGitStats {
                lines_added: 7,
                lines_removed: 0
            }
        );
    }

    #[test]
    fn parse_deletions_only() {
        let output = " 1 file changed, 2 deletions(-)";
        let stats = parse_git_diff_stat(output).expect("should parse");
        assert_eq!(
            stats,
            ThreadGitStats {
                lines_added: 0,
                lines_removed: 2
            }
        );
    }

    #[test]
    fn parse_singular_insertion() {
        let output = " 1 file changed, 1 insertion(+)";
        let stats = parse_git_diff_stat(output).expect("should parse");
        assert_eq!(
            stats,
            ThreadGitStats {
                lines_added: 1,
                lines_removed: 0
            }
        );
    }

    #[test]
    fn parse_empty_output_returns_none() {
        assert!(parse_git_diff_stat("").is_none());
    }

    #[test]
    fn parse_no_match_returns_none() {
        assert!(parse_git_diff_stat("nothing here").is_none());
    }

    #[test]
    fn parse_multiline_stat_output() {
        let output = " src/lib.rs | 42 +++++++++---\n src/main.rs | 5 ++\n 2 files changed, 39 insertions(+), 8 deletions(-)";
        let stats = parse_git_diff_stat(output).expect("should parse");
        assert_eq!(
            stats,
            ThreadGitStats {
                lines_added: 39,
                lines_removed: 8
            }
        );
    }
}
