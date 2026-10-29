use super::*;

const OWNER: &str = "synthetic-browser-owner";
const SESSION: &str = "synthetic-v4-browser-session";

async fn ready_registry<T>(mut read: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let result = read();
        if result
            .as_ref()
            .err()
            .is_some_and(|error| error == "Browser session is changing; request the action again")
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        } else {
            return result;
        }
    }
}
async fn fixture_review(
    data: &Path,
    owner: &str,
    name: &str,
    input: &Value,
) -> Result<Review, String> {
    ready_registry(|| approval_review(data, owner, name, input)).await
}
async fn fixture_dispatch(
    integrations: &mut Integrations,
    data: &Path,
    workspace: &Path,
    name: &str,
    input: &Value,
    review: Option<&Review>,
) -> Result<Output, String> {
    let owned_review = if review.is_none() {
        Some(fixture_review(data, OWNER, name, input).await?)
    } else {
        None
    };
    let review = review.or(owned_review.as_ref());
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let result = integrations
            .dispatch_reviewed(data, OWNER, workspace, SESSION, name, input, true, review)
            .await;
        if result
            .as_ref()
            .err()
            .is_some_and(|error| error == "Browser session is changing; request the action again")
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        } else {
            return result;
        }
    }
}

fn enable(data: &Path, owner: &str) {
    browser::save_config(
        data,
        owner,
        &browser::BrowserConfig {
            enabled: true,
            allowed_origins: vec!["https://example.test".into()],
            ..Default::default()
        },
    )
    .unwrap();
}

#[tokio::test]
async fn shared_review_captures_the_browser_target_and_binds_each_identity_field() {
    let data = tempfile::tempdir().unwrap();
    enable(data.path(), OWNER);
    let _registration = crate::workspace_browser::register_shared_test_host(data.path());
    let input = json!({"url":"https://example.test/reviewed"});
    let review = fixture_review(data.path(), OWNER, "browser_navigate", &input)
        .await
        .unwrap();
    let target = ready_registry(|| {
        crate::workspace_browser::review_target(data.path(), OWNER, "browser_navigate", &input)
    })
    .await
    .unwrap();
    assert_eq!(review.shared_target.as_ref(), Some(&target));
    let config = browser::load_config(data.path(), OWNER).unwrap();
    let configuration = browser_review_config(data.path(), OWNER, &config, true, Some(&target));
    check_review(
        Some(&review),
        "browser_navigate",
        &input,
        configuration.clone(),
    )
    .unwrap();
    for (field, value) in [
        ("sessionId", json!(uuid::Uuid::new_v4())),
        ("tabId", json!("different-tab")),
        ("documentId", json!("different-document")),
        ("generation", json!(1)),
        ("url", json!("https://example.test/unreviewed")),
    ] {
        let mut changed = configuration.clone();
        changed["target"][field] = value;
        let error = check_review(Some(&review), "browser_navigate", &input, changed).unwrap_err();
        assert!(
            error.contains("changed"),
            "Unbound browser target field: {field}"
        );
    }
}

#[tokio::test]
async fn shared_review_rejects_session_active_tab_document_and_control_changes() {
    for change in ["session", "activeTab", "document", "control", "url"] {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        enable(data.path(), OWNER);
        let _registration = crate::workspace_browser::register_shared_test_host(data.path());
        let mut state = json!({
            "tabs":[
                {"id":"reviewed-tab","documentId":"reviewed-document","url":"https://example.test/reviewed"},
                {"id":"other-tab","documentId":"other-document","url":"https://example.test/other"}
            ],
            "activeTabId":"reviewed-tab"
        });
        let fixture = crate::workspace_browser::register_shared_test_session(
            data.path(),
            OWNER,
            state.clone(),
        )
        .await;
        let input = json!({"ref":"e1"});
        let review = fixture_review(data.path(), OWNER, "browser_click", &input)
            .await
            .unwrap();
        match change {
            "session" => fixture.replace_session().await,
            "activeTab" => state["activeTabId"] = json!("other-tab"),
            "document" => state["tabs"][0]["documentId"] = json!("new-document"),
            "control" => fixture.bump_generation(),
            "url" => state["tabs"][0]["url"] = json!("https://example.test/unreviewed"),
            _ => unreachable!(),
        }
        if matches!(change, "activeTab" | "document" | "url") {
            fixture.set_state(state);
        }
        let mut integrations = Integrations::default();
        let error = fixture_dispatch(
            &mut integrations,
            data.path(),
            workspace.path(),
            "browser_click",
            &input,
            Some(&review),
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("changed"), "{change}: {error}");
        assert!(integrations.browser.is_none() && integrations.shared_browser.is_none());
    }
}

#[tokio::test]
async fn keyboard_review_binds_exact_key_ref_and_shared_target() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    enable(data.path(), OWNER);
    let _registration = crate::workspace_browser::register_shared_test_host(data.path());
    let fixture = crate::workspace_browser::register_shared_test_session(data.path(), OWNER, json!({"tabs":[{"id":"reviewed-tab","documentId":"reviewed-document","url":"https://example.test/reviewed"}],"activeTabId":"reviewed-tab"})).await;
    let reference = format!("e{}_1", uuid::Uuid::new_v4().simple());
    let input = json!({"ref":reference,"key":"Control+Enter"});
    let review = fixture_review(data.path(), OWNER, "browser_press", &input)
        .await
        .unwrap();
    assert!(review.description.contains("Control+Enter"));
    assert!(review.description.contains(reference.as_str()));
    assert!(fixture_review(
        data.path(),
        OWNER,
        "browser_press",
        &json!({"ref":reference,"key":"Control+Control+Enter"})
    )
    .await
    .is_err());
    let mut integrations = Integrations::default();
    let altered = json!({"ref":reference,"key":"Enter"});
    let error = fixture_dispatch(
        &mut integrations,
        data.path(),
        workspace.path(),
        "browser_press",
        &altered,
        Some(&review),
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("changed"), "{error}");
    fixture.bump_generation();
    let error = fixture_dispatch(
        &mut integrations,
        data.path(),
        workspace.path(),
        "browser_press",
        &input,
        Some(&review),
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("changed"));
    assert!(integrations.browser.is_none() && integrations.shared_browser.is_none());
}

#[tokio::test]
async fn shared_review_without_session_cannot_apply_to_a_new_session() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    enable(data.path(), OWNER);
    let _registration = crate::workspace_browser::register_shared_test_host(data.path());
    let input = json!({});
    let review = fixture_review(data.path(), OWNER, "browser_close", &input)
        .await
        .unwrap();
    let _fixture = crate::workspace_browser::register_shared_test_session(
        data.path(),
        OWNER,
        json!({"tabs":[],"activeTabId":null}),
    )
    .await;
    let mut integrations = Integrations::default();
    let error = fixture_dispatch(
        &mut integrations,
        data.path(),
        workspace.path(),
        "browser_close",
        &input,
        Some(&review),
    )
    .await
    .err()
    .unwrap();
    assert!(error.contains("changed"), "{error}");
    assert!(integrations.browser.is_none() && integrations.shared_browser.is_none());
}

#[tokio::test]
async fn browser_review_cannot_cross_account_or_data_root_with_identical_settings() {
    let data = tempfile::tempdir().unwrap();
    let other_data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let other_owner = "other-synthetic-browser-owner";
    enable(data.path(), OWNER);
    enable(data.path(), other_owner);
    enable(other_data.path(), OWNER);
    let input = json!({});
    for shared in [false, true] {
        let _registration =
            shared.then(|| crate::workspace_browser::register_shared_test_host(data.path()));
        let _other_registration =
            shared.then(|| crate::workspace_browser::register_shared_test_host(other_data.path()));
        let review = fixture_review(data.path(), OWNER, "browser_close", &input)
            .await
            .unwrap();
        for (target_data, target_owner) in [(data.path(), other_owner), (other_data.path(), OWNER)]
        {
            let mut integrations = Integrations::default();
            let result = integrations
                .dispatch_reviewed(
                    target_data,
                    target_owner,
                    workspace.path(),
                    SESSION,
                    "browser_close",
                    &input,
                    true,
                    Some(&review),
                )
                .await;
            assert!(
                result.err().is_some_and(|error| error.contains("changed")),
                "An approval must be scoped to the exact account and data root"
            );
            assert!(integrations.browser.is_none() && integrations.shared_browser.is_none());
        }
    }
}

#[tokio::test]
async fn browser_review_cannot_switch_between_shared_and_standalone_targets() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    enable(data.path(), OWNER);
    let input = json!({});
    let standalone_review = fixture_review(data.path(), OWNER, "browser_close", &input)
        .await
        .unwrap();
    let registration = crate::workspace_browser::register_shared_test_host(data.path());
    let shared_review = fixture_review(data.path(), OWNER, "browser_close", &input)
        .await
        .unwrap();
    assert!(standalone_review.description.contains("isolated"));
    assert!(shared_review.description.contains("shared with the human"));
    let mut integrations = Integrations::default();
    let result = fixture_dispatch(
        &mut integrations,
        data.path(),
        workspace.path(),
        "browser_close",
        &input,
        Some(&standalone_review),
    )
    .await;
    assert!(result.err().unwrap().contains("changed"));
    assert!(integrations.browser.is_none() && integrations.shared_browser.is_none());

    drop(registration);
    let result = fixture_dispatch(
        &mut integrations,
        data.path(),
        workspace.path(),
        "browser_close",
        &input,
        Some(&shared_review),
    )
    .await;
    assert!(result.err().unwrap().contains("changed"));
    assert!(integrations.browser.is_none() && integrations.shared_browser.is_none());
}

#[tokio::test]
async fn shared_dispatch_close_uses_broker_and_stop_releases_only_its_agent_scope() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    enable(data.path(), OWNER);
    let _registration = crate::workspace_browser::register_shared_test_host(data.path());
    let definitions = definitions(data.path(), OWNER).unwrap();
    for name in ["browser_open", "browser_tabs", "browser_close"] {
        let tool = definitions
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap();
        assert!(tool["description"].as_str().unwrap().contains("human"));
    }
    let mut integrations = Integrations::default();
    let output = fixture_dispatch(
        &mut integrations,
        data.path(),
        workspace.path(),
        "browser_close",
        &json!({}),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&output.text).unwrap(),
        json!({"closed":false})
    );
    assert!(output.images.is_empty() && !output.error);
    assert!(integrations.browser.is_none());
    let retained = integrations.shared_browser.as_ref().unwrap();
    assert_eq!(
        (
            retained.data.as_path(),
            retained.owner.as_str(),
            retained.label.as_str()
        ),
        (data.path(), OWNER, SESSION)
    );
    integrations.close().await.unwrap();
    assert!(integrations.shared_browser.is_none() && integrations.browser.is_none());
    integrations.close().await.unwrap();
}

#[tokio::test]
async fn shared_dispatch_failure_never_creates_a_standalone_client_and_keeps_cleanup_scope() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    enable(data.path(), OWNER);
    let _registration = crate::workspace_browser::register_shared_test_host(data.path());
    let mut integrations = Integrations::default();
    let result = fixture_dispatch(
        &mut integrations,
        data.path(),
        workspace.path(),
        "browser_navigate",
        &json!({"url":"https://example.test"}),
        None,
    )
    .await;
    assert!(result.err().unwrap().contains("Open the shared browser"));
    assert!(integrations.browser.is_none());
    let retained = integrations.shared_browser.as_ref().unwrap();
    assert_eq!(
        (
            retained.data.as_path(),
            retained.owner.as_str(),
            retained.label.as_str()
        ),
        (data.path(), OWNER, SESSION)
    );
    integrations.close().await.unwrap();
    assert!(integrations.shared_browser.is_none());
}

#[tokio::test]
async fn shared_dispatch_forbidden_origin_is_rejected_without_a_standalone_fallback() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    enable(data.path(), OWNER);
    let _registration = crate::workspace_browser::register_shared_test_host(data.path());
    let mut integrations = Integrations::default();
    let result = fixture_dispatch(
        &mut integrations,
        data.path(),
        workspace.path(),
        "browser_open",
        &json!({"url":"https://forbidden.example.test"}),
        None,
    )
    .await;
    assert!(result.err().unwrap().contains("origin is not allowed"));
    assert!(integrations.browser.is_none());
    assert!(integrations.shared_browser.is_some());
    integrations.close().await.unwrap();
    assert!(integrations.shared_browser.is_none());
}

#[test]
fn shared_browser_screenshot_contract_keeps_scoped_image_artifact_conversion() {
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC";
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let session = uuid::Uuid::new_v4().to_string();
    let output = external_output(
        data.path(),
        OWNER,
        workspace.path(),
        &session,
        json!({"mimeType":"image/png","format":"base64","data":PNG}),
        "browser_screenshot",
    )
    .unwrap();
    let value: Value = serde_json::from_str(&output.text).unwrap();
    assert_eq!(value["format"], "v4-artifact");
    assert_eq!(value["artifact"]["type"], "v4_image");
    assert_eq!(output.images, vec![value["artifact"].clone()]);
    assert!(value.get("data").is_none());
    assert!(!output.error);
}

#[tokio::test]
async fn shared_actions_preserve_exact_approval_configuration_and_enablement_gates() {
    let data = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    enable(data.path(), OWNER);
    let _registration = crate::workspace_browser::register_shared_test_host(data.path());
    let input = json!({"url":"https://example.test/reviewed"});
    let review = fixture_review(data.path(), OWNER, "browser_navigate", &input)
        .await
        .unwrap();
    let mut integrations = Integrations::default();
    let changed_input = json!({"url":"https://example.test/unreviewed"});
    let invalid_input = json!({"url":"https://example.test/reviewed","unexpected":true});
    for (name, arguments, approved, receipt, expected) in [
        ("browser_navigate", &input, false, Some(&review), "approval"),
        ("browser_navigate", &input, true, None, "changed"),
        (
            "browser_navigate",
            &changed_input,
            true,
            Some(&review),
            "changed",
        ),
        ("browser_open", &input, true, Some(&review), "changed"),
        (
            "browser_navigate",
            &invalid_input,
            true,
            Some(&review),
            "Unexpected",
        ),
    ] {
        let result = integrations
            .dispatch_reviewed(
                data.path(),
                OWNER,
                workspace.path(),
                SESSION,
                name,
                arguments,
                approved,
                receipt,
            )
            .await;
        let error = result.err().unwrap();
        assert!(
            error.contains(expected),
            "{name}: expected {expected}, got {error}"
        );
        assert!(integrations.browser.is_none() && integrations.shared_browser.is_none());
    }

    let mut config = browser::load_config(data.path(), OWNER).unwrap();
    config.allowed_origins = vec!["https://other.example.test".into()];
    browser::save_config(data.path(), OWNER, &config).unwrap();
    let result = fixture_dispatch(
        &mut integrations,
        data.path(),
        workspace.path(),
        "browser_navigate",
        &input,
        Some(&review),
    )
    .await;
    assert!(result.err().unwrap().contains("changed"));

    config.enabled = false;
    browser::save_config(data.path(), OWNER, &config).unwrap();
    let disabled_review = fixture_review(data.path(), OWNER, "browser_navigate", &input)
        .await
        .unwrap();
    let result = fixture_dispatch(
        &mut integrations,
        data.path(),
        workspace.path(),
        "browser_navigate",
        &input,
        Some(&disabled_review),
    )
    .await;
    assert!(result.err().unwrap().contains("unavailable"));
    assert!(integrations.browser.is_none() && integrations.shared_browser.is_none());
}
