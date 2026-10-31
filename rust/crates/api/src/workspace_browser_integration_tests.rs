use super::*;

#[tokio::test]
async fn embedded_worker_lists_images_from_the_reviewed_document() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut request = [0; 4096];
                let _ = stream.read(&mut request).await;
                let body = r#"<img src="/asset.png?fixture=1" alt="Chart"><img src="data:image/png;base64,AA==" alt="Inline">"#;
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    let mut worker = Worker::launch().await.unwrap();
    worker
        .call(json!({"type":"navigate","url":origin,"human":true}))
        .await
        .unwrap();
    let target = worker.call(json!({"type":"target"})).await.unwrap();
    let result = worker.call(json!({"type":"agent","name":"browser_get_images","input":{},"target":target,"allowedOrigins":[origin],"label":"synthetic-image-test","humanReading":true})).await.unwrap();
    assert_eq!(
        result,
        json!({"images":[
        {"url":format!("{origin}/asset.png?fixture=1"),"alt":"Chart","inline":false},
        {"url":null,"alt":"Inline","inline":true}
    ],"truncated":false})
    );
    worker.close().await.unwrap();
    server.abort();
}

async fn fixture_review_target(
    data: &FsPath,
    owner: &str,
    name: &str,
    input: &Value,
) -> ReviewTarget {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match review_target(data, owner, name, input) {
                Ok(target) => return target,
                Err(error) if error == "Browser session is changing; request the action again" => {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                Err(error) => panic!("Synthetic browser target unavailable: {error}"),
            }
        }
    })
    .await
    .expect("Synthetic target registry must become available")
}

pub(super) async fn pipe_fixture() -> Entry {
    pipe_fixture_state(json!({"tabs":[],"activeTabId":null})).await
}

async fn pipe_fixture_state(state: Value) -> Entry {
    let runtime = crate::browser_runtime::resolve().unwrap();
    let mut command = Command::new(runtime.node);
    command.env("V4_PIPE_FIXTURE_STATE", state.to_string());
    command.arg("-e").arg(r#"
      const readline=require('node:readline');
      let keyboardRelease=null;
      const fixture=JSON.parse(process.env.V4_PIPE_FIXTURE_STATE);
      const send=(id,value)=>process.stdout.write(JSON.stringify({id,ok:true,value,state:{tabs:[],activeTabId:null,keyboardRelease}})+'\n');
      send(0,{}); let queue=Promise.resolve(), pressCompleted=false;
      readline.createInterface({input:process.stdin}).on('line',line=>{queue=queue.then(async()=>{
        const {id,command}=JSON.parse(line);
        if(command.type==='slow') await new Promise(r=>setTimeout(r,150));
        if(command.name==='browser_press') { await new Promise(r=>setTimeout(r,150)); pressCompleted=true; keyboardRelease=fixture.keyboardRelease || null; }
        if(command.name==='browser_press' && fixture.missingState) { process.stdout.write(JSON.stringify({id,ok:false,error:'fixture response',state:null})+'\n'); return; }
        if(command.type==='settle') keyboardRelease=null;
        send(id,command.type==='slow'?{marker:'cancelled-result'}:command.type==='control'?{pressCompleted}:JSON.parse(process.env.V4_PIPE_FIXTURE_STATE));
      });});
    "#).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().unwrap();
    #[cfg(unix)]
    let tree = crate::process_tree::ProcessTree::attach_new_process_group(&child).unwrap();
    #[cfg(not(unix))]
    let tree = crate::process_tree::ProcessTree::attach(&child).unwrap();
    let mut worker = Worker {
        input: child.stdin.take().unwrap(),
        output: BufReader::new(child.stdout.take().unwrap()),
        child,
        tree,
        touched: Instant::now(),
        closed: false,
        sequence: 0,
        pending_output: Vec::new(),
        last_state: Value::Null,
    };
    worker.read(0).await.unwrap();
    Entry {
        id: Uuid::new_v4(),
        worker: Arc::new(Mutex::new(worker)),
        control: Arc::new(StdMutex::new(BrowserControl::Available)),
        last_state: Arc::new(StdMutex::new(json!({"tabs":[],"activeTabId":null}))),
        generation: Arc::new(AtomicU64::new(0)),
        keyboard_inflight: Arc::new(AtomicBool::new(false)),
        keyboard_lease: Arc::new(StdMutex::new(None)),
    }
}

#[tokio::test]
async fn cancelled_exchange_cannot_be_consumed_by_next_request() {
    let entry = pipe_fixture().await;
    let operation = {
        let entry = entry.clone();
        tokio::spawn(async move { entry.call(json!({"type":"slow"}), Caller::Observer).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    operation.abort();
    let next = entry
        .call(json!({"type":"state"}), Caller::Observer)
        .await
        .unwrap();
    assert_eq!(next, json!({"tabs":[],"activeTabId":null}));
    assert_eq!(entry.worker.lock().await.sequence, 2);
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn revoked_approved_action_waiting_for_worker_has_no_effect() {
    let entry = pipe_fixture().await;
    let held = entry.worker.lock().await;
    let active = Arc::new(AtomicBool::new(true));
    let caller = Caller::Agent {
        label: "queued-fixture".into(),
        read: false,
        generation: 0,
        permit: ActionPermit {
            active: vec![active.clone()],
            ..Default::default()
        },
        configuration: None,
    };
    let operation = {
        let entry = entry.clone();
        tokio::spawn(async move { entry.call(json!({"type":"slow"}), caller).await })
    };
    tokio::task::yield_now().await;
    active.store(false, Ordering::SeqCst);
    drop(held);
    assert!(operation
        .await
        .unwrap()
        .unwrap_err()
        .message
        .contains("cancelled"));
    assert_eq!(entry.worker.lock().await.sequence, 0);
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn abandoned_v4_action_waiting_for_worker_has_no_effect() {
    let entry = pipe_fixture().await;
    let held = entry.worker.lock().await;
    let caller = Caller::Agent {
        label: "abandoned-fixture".into(),
        read: false,
        generation: 0,
        permit: ActionPermit::default(),
        configuration: None,
    };
    let operation = {
        let entry = entry.clone();
        tokio::spawn(async move { entry.call(json!({"type":"slow"}), caller).await })
    };
    tokio::task::yield_now().await;
    operation.abort();
    let _ = operation.await;
    drop(held);
    assert_eq!(
        entry
            .call(json!({"type":"state"}), Caller::Observer)
            .await
            .unwrap(),
        json!({"tabs":[],"activeTabId":null})
    );
    assert_eq!(entry.worker.lock().await.sequence, 1);
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_key_action_waiting_for_worker_cannot_claim_control_or_send() {
    let entry = pipe_fixture().await;
    let held = entry.worker.lock().await;
    let cancellation = crate::v4_agent::interaction::Cancellation::default();
    let caller = Caller::Agent {
        label: "key-fixture".into(),
        read: false,
        generation: 0,
        permit: ActionPermit::default(),
        configuration: None,
    };
    let operation = {
        let entry = entry.clone();
        let cancel = cancellation.clone();
        tokio::spawn(async move {
            entry
                .call_press(
                    json!({"type":"agent","name":"browser_press"}),
                    caller,
                    cancel,
                )
                .await
        })
    };
    tokio::task::yield_now().await;
    cancellation.cancel();
    let result = tokio::time::timeout(Duration::from_secs(1), operation)
        .await
        .expect("Cancellation should not wait for the worker")
        .unwrap();
    assert!(result.is_err());
    drop(held);
    assert_eq!(entry.worker.lock().await.sequence, 0);
    assert!(matches!(
        *entry.control.lock().unwrap(),
        BrowserControl::Available
    ));
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn abandoned_key_action_waiting_for_worker_cannot_claim_control_or_send() {
    let entry = pipe_fixture().await;
    let held = entry.worker.lock().await;
    let caller = Caller::Agent {
        label: "key-fixture".into(),
        read: false,
        generation: 0,
        permit: ActionPermit::default(),
        configuration: None,
    };
    let operation = {
        let entry = entry.clone();
        tokio::spawn(async move {
            entry
                .call_press(
                    json!({"type":"agent","name":"browser_press"}),
                    caller,
                    crate::v4_agent::interaction::Cancellation::default(),
                )
                .await
        })
    };
    tokio::task::yield_now().await;
    operation.abort();
    let _ = operation.await;
    drop(held);
    entry
        .call(json!({"type":"state"}), Caller::Observer)
        .await
        .unwrap();
    assert_eq!(entry.worker.lock().await.sequence, 1);
    assert!(matches!(
        *entry.control.lock().unwrap(),
        BrowserControl::Available
    ));
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn human_takeover_before_keyboard_admission_prevents_input() {
    let entry = pipe_fixture().await;
    let held = entry.worker.lock().await;
    let caller = Caller::Agent {
        label: "key-fixture".into(),
        read: false,
        generation: 0,
        permit: ActionPermit::default(),
        configuration: None,
    };
    let operation = {
        let entry = entry.clone();
        tokio::spawn(async move {
            entry
                .call_press(
                    json!({"type":"agent","name":"browser_press"}),
                    caller,
                    crate::v4_agent::interaction::Cancellation::default(),
                )
                .await
        })
    };
    tokio::task::yield_now().await;
    {
        let mut control = entry.control.lock().unwrap();
        *control = BrowserControl::Human;
        entry.generation.fetch_add(1, Ordering::SeqCst);
    }
    drop(held);
    assert!(operation.await.unwrap().is_err());
    assert_eq!(entry.worker.lock().await.sequence, 0);
    assert!(matches!(
        *entry.control.lock().unwrap(),
        BrowserControl::Human
    ));
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn human_takeover_waits_for_admitted_keyboard_exchange_without_modal() {
    let entry = pipe_fixture().await;
    let caller = Caller::Agent {
        label: "key-fixture".into(),
        read: false,
        generation: 0,
        permit: ActionPermit::default(),
        configuration: None,
    };
    let operation = {
        let entry = entry.clone();
        tokio::spawn(async move {
            entry
                .call_press(
                    json!({"type":"agent","name":"browser_press"}),
                    caller,
                    crate::v4_agent::interaction::Cancellation::default(),
                )
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if matches!(*entry.control.lock().unwrap(), BrowserControl::Agent(_)) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let generation = {
        let mut control = entry.control.lock().unwrap();
        *control = BrowserControl::Human;
        entry.generation.fetch_add(1, Ordering::SeqCst) + 1
    };
    let takeover = entry
        .call(
            json!({"type":"control","owner":"human","human":true}),
            Caller::Human(generation),
        )
        .await
        .unwrap();
    assert_eq!(takeover, json!({"pressCompleted":true}));
    operation.await.unwrap().unwrap();
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn pending_takeover_allows_dialog_only_and_waits_for_confirmed_release() {
    let entry = pipe_fixture().await;
    *entry.control.lock().unwrap() = BrowserControl::HumanPending;
    assert!(entry.human_input(false).is_err());
    assert!(entry.human_input(true).is_ok());
    for release in [json!("pending"), json!("unconfirmed")] {
        let state = json!({"keyboardRelease":release});
        entry.settle_takeover(&state).unwrap();
        let state = entry.decorate(state).unwrap();
        assert_eq!(state["control"]["owner"], "human_pending");
    }
    let state = json!({"keyboardRelease":null});
    entry.settle_takeover(&state).unwrap();
    let state = entry.decorate(state).unwrap();
    assert_eq!(state["control"]["owner"], "human");
    assert!(entry.human_input(false).is_ok());
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn ordinary_takeover_accepts_legacy_worker_without_keyboard_release_field() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::new(terminal_v4_core::AppConfig {
        data_dir: directory.path().into(),
        ..Default::default()
    })
    .unwrap();
    let user = AuthenticatedUser {
        user_id: "legacy-browser".into(),
        username: "legacy-browser".into(),
    };
    let entry = pipe_fixture().await;
    *entry.control.lock().unwrap() = BrowserControl::Agent("fixture-agent".into());
    let key = owner(&state, &user);
    SESSIONS.lock().await.insert(key.clone(), entry.clone());
    let result = command(
        State(state),
        Extension(user),
        Path(entry.id),
        Json(json!({"type":"control","owner":"human"})),
    )
    .await
    .unwrap();
    assert!(result.0.get("keyboardRelease").is_none());
    assert_eq!(result.0["control"]["owner"], "human");
    assert!(entry.human_input(false).is_ok());
    SESSIONS.lock().await.remove(&key);
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn settings_changed_while_approved_action_is_queued_prevent_execution() {
    let directory = tempfile::tempdir().unwrap();
    let owner = (
        directory.path().to_path_buf(),
        "settings-fixture".to_owned(),
    );
    let config = crate::v4_agent::browser::BrowserConfig {
        enabled: true,
        ..Default::default()
    };
    crate::v4_agent::browser::save_config(&owner.0, &owner.1, &config).unwrap();
    let caller = Caller::Agent {
        label: "settings-fixture".into(),
        read: false,
        generation: 0,
        permit: ActionPermit::default(),
        configuration: Some((owner.clone(), serde_json::to_vec(&config).unwrap())),
    };
    let entry = pipe_fixture().await;
    let held = entry.worker.lock().await;
    let operation = {
        let entry = entry.clone();
        tokio::spawn(async move { entry.call(json!({"type":"slow"}), caller).await })
    };
    tokio::task::yield_now().await;
    crate::v4_agent::browser::save_config(
        &owner.0,
        &owner.1,
        &crate::v4_agent::browser::BrowserConfig::default(),
    )
    .unwrap();
    drop(held);
    assert!(operation
        .await
        .unwrap()
        .unwrap_err()
        .message
        .contains("settings changed"));
    assert_eq!(entry.worker.lock().await.sequence, 0);
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn pending_keyboard_release_keeps_reviewed_settings_locked_until_settled() {
    let directory = tempfile::tempdir().unwrap();
    let owner = (directory.path().to_path_buf(), "pending-key".to_owned());
    let config = crate::v4_agent::browser::BrowserConfig {
        enabled: true,
        ..Default::default()
    };
    crate::v4_agent::browser::save_config(&owner.0, &owner.1, &config).unwrap();
    let entry = pipe_fixture_state(json!({"keyboardRelease":"pending"})).await;
    let caller = Caller::Agent {
        label: "key-fixture".into(),
        read: false,
        generation: 0,
        permit: ActionPermit::default(),
        configuration: Some((owner.clone(), serde_json::to_vec(&config).unwrap())),
    };
    entry
        .call_press(
            json!({"type":"agent","name":"browser_press"}),
            caller,
            crate::v4_agent::interaction::Cancellation::default(),
        )
        .await
        .unwrap();
    assert!(
        crate::v4_agent::browser::save_config(&owner.0, &owner.1, &Default::default()).is_err()
    );
    crate::v4_agent::browser::save_config(&owner.0, "other-owner", &Default::default()).unwrap();
    entry
        .call(json!({"type":"settle"}), Caller::Observer)
        .await
        .unwrap();
    crate::v4_agent::browser::save_config(&owner.0, &owner.1, &Default::default()).unwrap();
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_keyboard_caller_keeps_settings_locked_until_release() {
    let directory = tempfile::tempdir().unwrap();
    let owner = (directory.path().to_path_buf(), "cancelled-key".to_owned());
    let config = crate::v4_agent::browser::BrowserConfig {
        enabled: true,
        ..Default::default()
    };
    crate::v4_agent::browser::save_config(&owner.0, &owner.1, &config).unwrap();
    let entry = pipe_fixture_state(json!({"keyboardRelease":"pending"})).await;
    let caller = Caller::Agent {
        label: "key-fixture".into(),
        read: false,
        generation: 0,
        permit: ActionPermit::default(),
        configuration: Some((owner.clone(), serde_json::to_vec(&config).unwrap())),
    };
    let cancellation = crate::v4_agent::interaction::Cancellation::default();
    let operation = {
        let entry = entry.clone();
        let cancellation = cancellation.clone();
        tokio::spawn(async move {
            entry
                .call_press(
                    json!({"type":"agent","name":"browser_press"}),
                    caller,
                    cancellation,
                )
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while !entry.keyboard_inflight.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    cancellation.cancel();
    assert!(operation.await.unwrap().is_err());
    assert!(
        crate::v4_agent::browser::save_config(&owner.0, &owner.1, &Default::default()).is_err()
    );
    entry
        .call(json!({"type":"settle"}), Caller::Observer)
        .await
        .unwrap();
    crate::v4_agent::browser::save_config(&owner.0, &owner.1, &Default::default()).unwrap();
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test]
async fn missing_keyboard_state_keeps_settings_locked_until_browser_close() {
    let directory = tempfile::tempdir().unwrap();
    let owner = (directory.path().to_path_buf(), "unknown-key".to_owned());
    let config = crate::v4_agent::browser::BrowserConfig {
        enabled: true,
        ..Default::default()
    };
    crate::v4_agent::browser::save_config(&owner.0, &owner.1, &config).unwrap();
    let entry = pipe_fixture_state(json!({"missingState":true})).await;
    let caller = Caller::Agent {
        label: "key-fixture".into(),
        read: false,
        generation: 0,
        permit: ActionPermit::default(),
        configuration: Some((owner.clone(), serde_json::to_vec(&config).unwrap())),
    };
    assert!(entry
        .call_press(
            json!({"type":"agent","name":"browser_press"}),
            caller,
            Default::default()
        )
        .await
        .is_err());
    assert!(
        crate::v4_agent::browser::save_config(&owner.0, &owner.1, &Default::default()).is_err()
    );
    close_selected(&owner, entry).await.unwrap();
    crate::v4_agent::browser::save_config(&owner.0, &owner.1, &Default::default()).unwrap();
}

#[tokio::test]
async fn reviewed_keyboard_rejects_settings_changed_before_admission() {
    let directory = tempfile::tempdir().unwrap();
    let owner = (directory.path().to_path_buf(), "key-settings".to_owned());
    let original = crate::v4_agent::browser::BrowserConfig {
        enabled: true,
        ..Default::default()
    };
    crate::v4_agent::browser::save_config(&owner.0, &owner.1, &original).unwrap();
    crate::v4_agent::browser::save_config(&owner.0, &owner.1, &Default::default()).unwrap();
    let entry = pipe_fixture().await;
    let caller = Caller::Agent {
        label: "key-settings".into(),
        read: false,
        generation: 0,
        permit: ActionPermit::default(),
        configuration: Some((owner, serde_json::to_vec(&original).unwrap())),
    };
    assert!(entry
        .call_press(
            json!({"type":"agent","name":"browser_press"}),
            caller,
            crate::v4_agent::interaction::Cancellation::default()
        )
        .await
        .unwrap_err()
        .message
        .contains("settings changed"));
    assert_eq!(entry.worker.lock().await.sequence, 0);
    entry.worker.lock().await.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn control_change_between_review_check_and_claim_cannot_rebind_approval() {
    let directory = tempfile::tempdir().unwrap();
    let key = (
        directory.path().to_path_buf(),
        "control-race-fixture".to_owned(),
    );
    crate::v4_agent::browser::save_config(
        &key.0,
        &key.1,
        &crate::v4_agent::browser::BrowserConfig {
            enabled: true,
            ..Default::default()
        },
    )
    .unwrap();
    let entry = pipe_fixture().await;
    SESSIONS.lock().await.insert(key.clone(), entry.clone());
    let input = json!({"url":"about:blank"});
    let reviewed = fixture_review_target(&key.0, &key.1, "browser_open", &input).await;
    let (ready, acquired) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    let controller = {
        let entry = entry.clone();
        std::thread::spawn(move || {
            let _held = entry.control.lock().unwrap();
            ready.send(()).unwrap();
            resume.recv().unwrap();
            entry.generation.fetch_add(1, Ordering::SeqCst);
        })
    };
    acquired.recv().unwrap();
    let operation = {
        let key = key.clone();
        tokio::spawn(async move {
            shared_agent_action_guarded(
                &key,
                "control-race-agent",
                "browser_open",
                &input,
                &[],
                &reviewed,
                ActionPermit::default(),
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    release.send(()).unwrap();
    controller.join().unwrap();
    let result = operation.await.unwrap();
    SESSIONS.lock().await.remove(&key);
    entry.worker.lock().await.close().await.unwrap();
    assert!(result.unwrap_err().contains("control changed"));
    assert_eq!(entry.worker.lock().await.sequence, 0);
}

#[tokio::test]
async fn cancelled_shared_dispatch_waiting_for_worker_does_not_claim_control() {
    let directory = tempfile::tempdir().unwrap();
    let key = (
        directory.path().to_path_buf(),
        "cancel-claim-fixture".to_owned(),
    );
    crate::v4_agent::browser::save_config(
        &key.0,
        &key.1,
        &crate::v4_agent::browser::BrowserConfig {
            enabled: true,
            ..Default::default()
        },
    )
    .unwrap();
    let entry = pipe_fixture().await;
    SESSIONS.lock().await.insert(key.clone(), entry.clone());
    let input = json!({"url":"about:blank"});
    let reviewed = fixture_review_target(&key.0, &key.1, "browser_open", &input).await;
    let held = entry.worker.lock().await;
    let operation = {
        let key = key.clone();
        tokio::spawn(async move {
            shared_agent_action_guarded(
                &key,
                "cancel-claim-agent",
                "browser_open",
                &input,
                &[],
                &reviewed,
                ActionPermit::default(),
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    operation.abort();
    let _ = operation.await;
    let available = matches!(*entry.control.lock().unwrap(), BrowserControl::Available);
    drop(held);
    entry
        .call(json!({"type":"state"}), Caller::Observer)
        .await
        .unwrap();
    let sequence = entry.worker.lock().await.sequence;
    SESSIONS.lock().await.remove(&key);
    entry.worker.lock().await.close().await.unwrap();
    assert!(
        available,
        "A cancelled queued dispatch must leave control available"
    );
    assert_eq!(sequence, 1);
}

#[tokio::test]
async fn native_lease_deadline_is_checked_after_waiting_for_worker() {
    let directory = tempfile::tempdir().unwrap();
    let key = (directory.path().to_path_buf(), "expiry-fixture".to_owned());
    crate::v4_agent::browser::save_config(
        &key.0,
        &key.1,
        &crate::v4_agent::browser::BrowserConfig {
            enabled: true,
            ..Default::default()
        },
    )
    .unwrap();
    let entry = pipe_fixture().await;
    SESSIONS.lock().await.insert(key.clone(), entry.clone());
    let input = json!({"url":"about:blank"});
    let reviewed = fixture_review_target(&key.0, &key.1, "browser_open", &input).await;
    let held = entry.worker.lock().await;
    let permit = ActionPermit {
        active: vec![Arc::new(AtomicBool::new(true))],
        expires: Some(Instant::now() + Duration::from_millis(100)),
    };
    let operation = {
        let key = key.clone();
        tokio::spawn(async move {
            shared_agent_action_guarded(
                &key,
                "expiry-agent",
                "browser_open",
                &input,
                &[],
                &reviewed,
                permit,
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    drop(held);
    let result = operation.await.unwrap();
    let available = matches!(*entry.control.lock().unwrap(), BrowserControl::Available);
    let sequence = entry.worker.lock().await.sequence;
    SESSIONS.lock().await.remove(&key);
    entry.worker.lock().await.close().await.unwrap();
    assert!(result.unwrap_err().contains("expired"));
    assert!(available);
    assert_eq!(sequence, 0);
}

#[tokio::test]
async fn release_keeps_ownership_until_scoped_worker_cleanup_succeeds() {
    let directory = tempfile::tempdir().unwrap();
    let key = (
        directory.path().to_path_buf(),
        "release-order-fixture".to_owned(),
    );
    let label = "release-order-agent";
    let entry = pipe_fixture().await;
    *entry.control.lock().unwrap() = BrowserControl::Agent(label.into());
    SESSIONS.lock().await.insert(key.clone(), entry.clone());
    let held = entry.worker.lock().await;
    let operation = {
        let key = key.clone();
        tokio::spawn(async move { release_shared_agent(&key.0, &key.1, label).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    let retained_until_cleanup = matches!(&*entry.control.lock().unwrap(), BrowserControl::Agent(current) if current == label);
    drop(held);
    operation.await.unwrap().unwrap();
    let released_after_cleanup =
        matches!(*entry.control.lock().unwrap(), BrowserControl::Available);
    *entry.control.lock().unwrap() = BrowserControl::Agent(label.into());
    entry.worker.lock().await.closed = true;
    assert!(release_shared_agent(&key.0, &key.1, label).await.is_err());
    let retained_on_failure = matches!(&*entry.control.lock().unwrap(), BrowserControl::Agent(current) if current == label);
    entry.worker.lock().await.closed = false;
    release_shared_agent(&key.0, &key.1, label).await.unwrap();
    assert!(matches!(
        *entry.control.lock().unwrap(),
        BrowserControl::Available
    ));
    assert_eq!(SESSIONS.lock().await[&key].id, entry.id);
    SESSIONS.lock().await.remove(&key);
    entry.worker.lock().await.close().await.unwrap();
    assert!(retained_until_cleanup);
    assert!(released_after_cleanup);
    assert!(retained_on_failure);
}

#[tokio::test]
async fn dialog_decisions_require_explicit_identity_before_worker_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::new(terminal_v4_core::AppConfig {
        data_dir: directory.path().into(),
        ..Default::default()
    })
    .unwrap();
    let user = AuthenticatedUser {
        user_id: "dialog-fixture".into(),
        username: "dialog-fixture".into(),
    };
    let key = owner(&state, &user);
    let entry = pipe_fixture().await;
    SESSIONS.lock().await.insert(key.clone(), entry.clone());
    let mut statuses = Vec::new();
    for input in [
        json!({"type":"dialog","accept":true}),
        json!({"type":"dialog","dialogId":"invalid","accept":false}),
    ] {
        statuses.push(
            command(
                State(state.clone()),
                Extension(user.clone()),
                Path(entry.id),
                Json(input),
            )
            .await
            .err()
            .map(|error| error.status),
        );
    }
    let sequence = entry.worker.lock().await.sequence;
    SESSIONS.lock().await.remove(&key);
    entry.worker.lock().await.close().await.unwrap();
    assert_eq!(statuses, vec![Some(axum::http::StatusCode::BAD_REQUEST); 2]);
    assert_eq!(sequence, 0);
}

#[tokio::test]
async fn agent_handoff_returns_current_dialog_instead_of_review_metadata_cache() {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::new(terminal_v4_core::AppConfig {
        data_dir: directory.path().into(),
        ..Default::default()
    })
    .unwrap();
    let user = AuthenticatedUser {
        user_id: "handoff-fixture".into(),
        username: "handoff-fixture".into(),
    };
    let dialog = json!({"id":Uuid::new_v4(),"tabId":"tab","type":"prompt","message":"Current prompt","defaultValue":"Current default"});
    let actual = json!({"tabs":[{"id":"tab","documentId":"document","url":"about:blank","title":"Current prompt"}],"activeTabId":"tab","dialog":dialog});
    let entry = pipe_fixture_state(actual).await;
    *entry.control.lock().unwrap() = BrowserControl::Human;
    let key = owner(&state, &user);
    SESSIONS.lock().await.insert(key.clone(), entry.clone());
    let result = command(
        State(state),
        Extension(user),
        Path(entry.id),
        Json(json!({"type":"control","owner":"agents"})),
    )
    .await
    .unwrap();
    let sequence = entry.worker.lock().await.sequence;
    SESSIONS.lock().await.remove(&key);
    entry.worker.lock().await.close().await.unwrap();
    assert_eq!(result.0["dialog"], dialog);
    assert_eq!(sequence, 1);
}

#[tokio::test]
#[ignore = "Requires the isolated bundled browser runtime and frontend dependencies"]
async fn real_ui_takeover_waits_for_modal_keyboard_release() {
    use axum::{
        response::Html,
        routing::{get, post},
    };
    let directory = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = terminal_v4_core::AppConfig {
        data_dir: directory.path().into(),
        port,
        ..Default::default()
    };
    let state = AppState::new(config.clone()).unwrap();
    let user = state
        .create_local_user_for_test("browser-modal-fixture", "Synthetic-Fixture-Password-1!")
        .unwrap();
    let token = crate::auth::issue_access_token(&config.jwt_secret, &user.id, &user.username);
    let origin = format!("http://127.0.0.1:{port}");
    crate::v4_agent::browser::save_config(
        directory.path(),
        &user.id,
        &crate::v4_agent::browser::BrowserConfig {
            enabled: true,
            allowed_origins: vec![origin.clone()],
            ..Default::default()
        },
    )
    .unwrap();
    register_host(&state);
    let data = directory.path().to_path_buf();
    let user_id = user.id.clone();
    let press = move || {
        let data = data.clone();
        let user_id = user_id.clone();
        async move {
            let run = async {
                let config = crate::v4_agent::browser::load_config(&data, &user_id)?;
                let target =
                    fixture_review_target(&data, &user_id, "browser_snapshot", &json!({})).await;
                let snapshot = shared_agent_action_reviewed(
                    &data,
                    &user_id,
                    "modal-test-agent",
                    "browser_snapshot",
                    &json!({}),
                    &config.allowed_origins,
                    &target,
                )
                .await?;
                let reference = snapshot["elements"]
                    .as_array()
                    .and_then(|items| items.iter().find(|item| item["name"] == "Target"))
                    .and_then(|item| item["ref"].as_str())
                    .ok_or("Synthetic target missing")?;
                let input = json!({"ref":reference,"key":"Enter"});
                let target = fixture_review_target(&data, &user_id, "browser_press", &input).await;
                shared_agent_press_reviewed(
                    &data,
                    &user_id,
                    "modal-test-agent",
                    &input,
                    &config.allowed_origins,
                    &target,
                    crate::v4_agent::interaction::Cancellation::default(),
                )
                .await
            }
            .await;
            Json(match run {
                Ok(value) => json!({"result":value}),
                Err(error) => json!({"error":error}),
            })
        }
    };
    let app = crate::app(state.clone())
        .route("/browser-takeover-fixture", get(|| async { Html(r#"<title>Takeover target</title><input aria-label="Target" onfocus="if(location.search){alert('Synthetic focus modal');document.title='FOCUS_DONE'}" onkeydown="document.title='KEY_DOWN';alert('Synthetic keyboard modal')" onkeyup="document.title='KEY_RELEASED'">"#) }))
        .route("/api/__test_browser_press", post(press));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let runtime = crate::browser_runtime::resolve().unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let vite_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let vite_port = vite_listener.local_addr().unwrap().port();
    drop(vite_listener);
    let mut vite = Command::new(&runtime.node)
        .arg(root.join("frontend/node_modules/vite/bin/vite.js"))
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &vite_port.to_string(),
            "--strictPort",
        ])
        .current_dir(root.join("frontend"))
        .env("TERMINAL_V4_API_PROXY_TARGET", &origin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        while tokio::net::TcpStream::connect(("127.0.0.1", vite_port))
            .await
            .is_err()
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("Vite fixture did not start");
    let output = tokio::time::timeout(
        Duration::from_secs(90),
        Command::new(&runtime.node)
            .arg(root.join("scripts/workspace-browser-takeover-test.cjs"))
            .env("TERMINAL_V4_BROWSER_RUNTIME_DIR", &runtime.root)
            .env(
                "TERMINAL_V4_BROWSER_TEST_UI",
                format!("http://127.0.0.1:{vite_port}"),
            )
            .env(
                "TERMINAL_V4_BROWSER_TEST_SITE",
                format!("{origin}/browser-takeover-fixture"),
            )
            .env("TERMINAL_V4_BROWSER_TEST_APP_TOKEN", token)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    close_owner(&state, &user.id).await;
    shutdown(&state).await;
    let _ = vite.kill().await;
    server.abort();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
#[ignore = "Requires provisioned bundled runtime and built frontend; launches only synthetic browser fixtures"]
async fn managed_shared_browser_mcp_and_real_workspace_ui() {
    let directory = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = terminal_v4_core::AppConfig {
        data_dir: directory.path().into(),
        port,
        ..Default::default()
    };
    let state = AppState::new(config.clone()).unwrap();
    let user = state
        .create_local_user_for_test("shared-browser-ui-fixture", "Synthetic-Fixture-Password-1!")
        .unwrap();
    let token = crate::auth::issue_access_token(&config.jwt_secret, &user.id, &user.username);
    let other = crate::auth::issue_access_token(
        &config.jwt_secret,
        "other-browser-fixture",
        "other-fixture",
    );
    let connection = agent_connection(&config, &user.id, "Coding agent fixture").unwrap();
    register_host(&state);
    let router = crate::app(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let runtime = crate::browser_runtime::resolve().unwrap();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let output = root.join("output/bundled-shared-browser-20261025");
    std::fs::create_dir_all(&output).unwrap();
    let result = Command::new(&runtime.node)
        .arg(root.join("scripts/workspace-browser-integration.cjs"))
        .current_dir(&root)
        .env("TERMINAL_V4_BROWSER_RUNTIME_DIR", &runtime.root)
        .env(
            "TERMINAL_V4_BROWSER_TEST_ORIGIN",
            format!("http://127.0.0.1:{port}"),
        )
        .env("TERMINAL_V4_BROWSER_TEST_APP_TOKEN", token)
        .env("TERMINAL_V4_BROWSER_TEST_OTHER_TOKEN", other)
        .env("TERMINAL_V4_BROWSER_TEST_MCP_TOKEN", &connection.token)
        .env(
            "TERMINAL_V4_BROWSER_TEST_USER",
            serde_json::to_string(&user).unwrap(),
        )
        .env("TERMINAL_V4_BROWSER_TEST_OUTPUT", output)
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    if result.status.success() {
        let config = crate::v4_agent::browser::load_config(directory.path(), &user.id).unwrap();
        let target =
            fixture_review_target(directory.path(), &user.id, "browser_snapshot", &json!({})).await;
        let snapshot = shared_agent_action_reviewed(
            directory.path(),
            &user.id,
            "V4 shared-manager fixture",
            "browser_snapshot",
            &json!({}),
            &config.allowed_origins,
            &target,
        )
        .await
        .unwrap();
        let name = snapshot["elements"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == "Name")
            .unwrap();
        assert_eq!(name["value"], "AGENT_RESUMED");
        let input = json!({"ref":name["ref"],"text":"V4_SHARED_MANAGER_OK"});
        let target =
            fixture_review_target(directory.path(), &user.id, "browser_type", &input).await;
        shared_agent_action_reviewed(
            directory.path(),
            &user.id,
            "V4 shared-manager fixture",
            "browser_type",
            &input,
            &config.allowed_origins,
            &target,
        )
        .await
        .unwrap();
        let target =
            fixture_review_target(directory.path(), &user.id, "browser_snapshot", &json!({})).await;
        let snapshot = shared_agent_action_reviewed(
            directory.path(),
            &user.id,
            "V4 shared-manager fixture",
            "browser_snapshot",
            &json!({}),
            &config.allowed_origins,
            &target,
        )
        .await
        .unwrap();
        assert!(snapshot["elements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["name"] == "Name" && row["value"] == "V4_SHARED_MANAGER_OK"));
        let input = json!({"ref":name["ref"],"key":"Home"});
        let target =
            fixture_review_target(directory.path(), &user.id, "browser_press", &input).await;
        let pressed = shared_agent_press_reviewed(
            directory.path(),
            &user.id,
            "V4 shared-manager fixture",
            &input,
            &config.allowed_origins,
            &target,
            crate::v4_agent::interaction::Cancellation::default(),
        )
        .await
        .unwrap();
        assert_eq!(pressed, json!({"pressed":"Home"}));
        let input = json!({"ref":name["ref"],"text":"PREFIX_","clear":false});
        let target =
            fixture_review_target(directory.path(), &user.id, "browser_type", &input).await;
        shared_agent_action_reviewed(
            directory.path(),
            &user.id,
            "V4 shared-manager fixture",
            "browser_type",
            &input,
            &config.allowed_origins,
            &target,
        )
        .await
        .unwrap();
        let target =
            fixture_review_target(directory.path(), &user.id, "browser_snapshot", &json!({})).await;
        let snapshot = shared_agent_action_reviewed(
            directory.path(),
            &user.id,
            "V4 shared-manager fixture",
            "browser_snapshot",
            &json!({}),
            &config.allowed_origins,
            &target,
        )
        .await
        .unwrap();
        assert!(snapshot["elements"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["name"] == "Name" && row["value"] == "PREFIX_V4_SHARED_MANAGER_OK"));
        release_shared_agent(directory.path(), &user.id, "V4 shared-manager fixture")
            .await
            .unwrap();
        eprintln!("PASS V4's reviewed shared-manager helper reads and types into the same retained human/MCP page");
    }
    close_owner(&state, &user.id).await;
    shutdown(&state).await;
    server.abort();
    assert!(
        result.status.success(),
        "Shared browser UI integration failed: {}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    eprintln!("{}", String::from_utf8_lossy(&result.stdout));
}
