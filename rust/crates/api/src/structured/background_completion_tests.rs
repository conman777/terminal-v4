use super::*;
use crate::v4_agent::background_process::{BackgroundRequest, BackgroundScope};
use crate::v4_agent::interaction::Cancellation;
use std::time::Duration;

struct Fixture {
    _root: tempfile::TempDir,
    manager: StructuredSessionManager,
    background: Arc<BackgroundProcesses>,
    workspace: PathBuf,
}

async fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().canonicalize().unwrap();
    let manager = StructuredSessionManager::new(AppConfig {
        data_dir: workspace.join("data"),
        ..Default::default()
    });
    let background = Arc::new(BackgroundProcesses::create(&workspace.join("ledger")).unwrap());
    manager
        .bind_background_processes(background.clone())
        .unwrap();
    Fixture {
        _root: root,
        manager,
        background,
        workspace,
    }
}

impl Fixture {
    async fn session(&self, owner: &str) -> (String, Option<uuid::Uuid>) {
        let session = self
            .manager
            .create_session(
                owner,
                self.workspace.to_str().unwrap(),
                Some("claude"),
                None,
                None,
            )
            .await
            .unwrap();
        let owned = self
            .manager
            .owned_session_internal(owner, &session.id)
            .await
            .unwrap()
            .unwrap();
        let incarnation = owned
            .state
            .lock()
            .await
            .session_incarnation
            .map(|value| value.0);
        (session.id, incarnation)
    }

    async fn finished_command(
        &self,
        owner: &str,
        session: &str,
        incarnation: Option<uuid::Uuid>,
        action: &str,
        command: &str,
    ) -> BackgroundScope {
        let request = BackgroundRequest {
            interactive: false,
            scope: BackgroundScope {
                owner: owner.into(),
                session: session.into(),
                workspace: self.workspace.clone(),
                incarnation,
            },
            authorization_generation: None,
            action_id: action.into(),
            command: command.into(),
            timeout: Duration::from_secs(20),
        };
        self.background
            .start_for_actor(
                request.clone(),
                &request,
                &Cancellation::default(),
                i64::MAX,
                |command| {
                    command
                        .spawn()
                        .map_err(|_| "Cannot start background process".to_string())
                },
            )
            .await
            .unwrap();
        self.background
            .wait(
                &request.scope,
                action,
                Duration::from_secs(10),
                &Cancellation::default(),
            )
            .await
            .unwrap();
        request.scope
    }

    async fn notices(&self, owner: &str, session: &str) -> Vec<String> {
        self.manager
            .get_session(owner, session)
            .await
            .unwrap()
            .unwrap()
            .events
            .into_iter()
            .filter_map(|event| match event {
                StructuredSessionEvent::MessageCompleted {
                    message_id: Some(id),
                    content,
                    role,
                    ..
                } if id.starts_with(NOTICE_ID_PREFIX) && role == "system" => Some(content),
                _ => None,
            })
            .collect()
    }
}

#[tokio::test]
async fn a_completion_becomes_one_metadata_only_notice_for_the_owning_session() {
    let fixture = fixture().await;
    let (session, incarnation) = fixture.session("owner").await;
    fixture
        .finished_command(
            "owner",
            &session,
            incarnation,
            "act-1",
            "printf SECRET-TOKEN; exit 3",
        )
        .await;
    assert_eq!(
        fixture.manager.deliver_background_completions().await,
        Ok(1)
    );
    assert_eq!(
        fixture.notices("owner", &session).await,
        vec!["Background command act-1 exited with code 3. Its output is not included; output release is currently unavailable.".to_string()]
    );
    assert_eq!(
        fixture.manager.deliver_background_completions().await,
        Ok(0)
    );
    assert_eq!(fixture.notices("owner", &session).await.len(), 1);
    assert_eq!(fixture.background.pending_completions().unwrap(), vec![]);
}

#[tokio::test]
async fn concurrent_consumers_deliver_each_completion_exactly_once() {
    let fixture = fixture().await;
    let (session, incarnation) = fixture.session("owner").await;
    for action in ["a", "b", "c"] {
        fixture
            .finished_command("owner", &session, incarnation, action, "exit 0")
            .await;
    }
    let results = tokio::join!(
        fixture.manager.deliver_background_completions(),
        fixture.manager.deliver_background_completions(),
        fixture.manager.deliver_background_completions(),
    );
    let total = results.0.unwrap() + results.1.unwrap() + results.2.unwrap();
    assert_eq!(total, 3);
    let mut notices = fixture.notices("owner", &session).await;
    notices.sort();
    assert_eq!(notices.len(), 3);
    assert_eq!(fixture.background.pending_completions().unwrap(), vec![]);
}

#[tokio::test]
async fn a_changed_incarnation_a_foreign_owner_and_a_missing_session_never_receive_a_notice() {
    let fixture = fixture().await;
    let (session, _) = fixture.session("owner").await;
    let (other_session, other_incarnation) = fixture.session("other").await;
    fixture
        .finished_command(
            "owner",
            &session,
            Some(uuid::Uuid::new_v4()),
            "stale-incarnation",
            "exit 0",
        )
        .await;
    fixture
        .finished_command(
            "owner",
            &other_session,
            other_incarnation,
            "foreign",
            "exit 0",
        )
        .await;
    fixture
        .finished_command(
            "owner",
            "no-such-session",
            Some(uuid::Uuid::new_v4()),
            "missing",
            "exit 0",
        )
        .await;
    fixture
        .finished_command("owner", &session, None, "unscoped", "exit 0")
        .await;
    assert_eq!(
        fixture.manager.deliver_background_completions().await,
        Ok(0)
    );
    assert_eq!(
        fixture.notices("owner", &session).await,
        Vec::<String>::new()
    );
    assert_eq!(
        fixture.notices("other", &other_session).await,
        Vec::<String>::new()
    );
    assert_eq!(fixture.background.pending_completions().unwrap(), vec![]);
}

#[tokio::test]
async fn a_closing_session_holds_its_notice_until_it_is_usable_again() {
    let fixture = fixture().await;
    let (session, incarnation) = fixture.session("owner").await;
    fixture
        .finished_command("owner", &session, incarnation, "held", "exit 0")
        .await;
    let owned = fixture
        .manager
        .owned_session_internal("owner", &session)
        .await
        .unwrap()
        .unwrap();
    owned.state.lock().await.retiring = true;
    assert_eq!(
        fixture.manager.deliver_background_completions().await,
        Ok(0)
    );
    assert_eq!(fixture.background.pending_completions().unwrap().len(), 1);
    owned.state.lock().await.retiring = false;
    assert_eq!(
        fixture.manager.deliver_background_completions().await,
        Ok(1)
    );
    assert_eq!(fixture.notices("owner", &session).await.len(), 1);
}

#[tokio::test]
async fn a_closed_background_session_holds_the_notice() {
    let fixture = fixture().await;
    let (session, incarnation) = fixture.session("owner").await;
    fixture
        .finished_command("owner", &session, incarnation, "closed", "exit 0")
        .await;
    fixture
        .background
        .cleanup_session("owner", &session)
        .await
        .unwrap();
    assert_eq!(
        fixture.manager.deliver_background_completions().await,
        Ok(0)
    );
    assert_eq!(fixture.notices("owner", &session).await.len(), 0);
    assert_eq!(fixture.background.pending_completions().unwrap().len(), 1);
}

#[tokio::test]
async fn deleting_a_session_discards_its_undelivered_notice() {
    let fixture = fixture().await;
    let (session, incarnation) = fixture.session("owner").await;
    fixture
        .finished_command("owner", &session, incarnation, "doomed", "exit 0")
        .await;
    fixture
        .manager
        .delete_session("owner", &session)
        .await
        .unwrap();
    assert_eq!(fixture.background.pending_completions().unwrap(), vec![]);
    assert_eq!(
        fixture.manager.deliver_background_completions().await,
        Ok(0)
    );
}

#[tokio::test]
async fn the_worker_is_off_until_commands_are_enabled_and_then_delivers_on_completion() {
    let fixture = fixture().await;
    let (session, incarnation) = fixture.session("owner").await;
    fixture
        .manager
        .start_background_completion_worker()
        .unwrap();
    fixture
        .finished_command("owner", &session, incarnation, "quiet", "exit 0")
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(fixture.notices("owner", &session).await.len(), 0);

    fixture.background.enable_commands();
    fixture
        .manager
        .start_background_completion_worker()
        .unwrap();
    fixture
        .finished_command("owner", &session, incarnation, "loud", "exit 0")
        .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.notices("owner", &session).await.len() < 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("worker did not deliver");
    fixture.background.shutdown().await.unwrap();
}
