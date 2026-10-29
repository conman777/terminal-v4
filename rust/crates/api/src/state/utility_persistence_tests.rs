use super::*;

fn fixture(path: &Path) -> (AppState, AuthenticatedUser) {
    let state = AppState::new(AppConfig {
        data_dir: path.into(),
        ..AppConfig::default()
    })
    .unwrap();
    let user = AuthenticatedUser {
        user_id: "utility-fixture".into(),
        username: "synthetic".into(),
    };
    (state, user)
}

#[test]
fn deleted_seed_stays_deleted_after_reload_and_restart() {
    let data = tempfile::tempdir().unwrap();
    let (state, user) = fixture(data.path());
    let seed = state.list_bookmarks(&user).unwrap().remove(0);
    assert!(state.delete_bookmark(&user, &seed.id).unwrap());
    assert!(state.list_bookmarks(&user).unwrap().is_empty());
    drop(state);
    let (state, user) = fixture(data.path());
    assert!(state.list_bookmarks(&user).unwrap().is_empty());
}

#[test]
fn repurposed_seed_stays_alone_after_restart() {
    let data = tempfile::tempdir().unwrap();
    let (state, user) = fixture(data.path());
    let seed = state.list_bookmarks(&user).unwrap().remove(0);
    state
        .update_bookmark(
            &user,
            &seed.id,
            BookmarkUpdate {
                command: Some("echo synthetic-safe".into()),
                ..BookmarkUpdate::default()
            },
        )
        .unwrap();
    drop(state);
    let (state, user) = fixture(data.path());
    let bookmarks = state.list_bookmarks(&user).unwrap();
    assert_eq!(
        bookmarks
            .iter()
            .map(|bookmark| (&bookmark.id, bookmark.command.as_str()))
            .collect::<Vec<_>>(),
        vec![(&seed.id, "echo synthetic-safe")]
    );
}

#[test]
fn corrupt_collections_return_errors_without_changing_original_bytes() {
    for name in ["notes.json", "bookmarks.json"] {
        let data = tempfile::tempdir().unwrap();
        let (state, user) = fixture(data.path());
        let path = state.user_data_dir(&user.user_id).unwrap().join(name);
        let original = br#"[{"syntheticRecovery":"valuable text""#;
        fs::write(&path, original).unwrap();
        if name == "notes.json" {
            assert!(state.list_notes(&user).is_err());
            assert!(state
                .create_note(&user, "new".into(), "fresh".into(), "test".into())
                .is_err());
            assert!(state
                .update_note(&user, "missing", NoteUpdate::default())
                .is_err());
            assert!(state.delete_note(&user, "missing").is_err());
        } else {
            assert!(state.list_bookmarks(&user).is_err());
            assert!(state
                .create_bookmark(&user, "new".into(), "echo safe".into(), "test".into())
                .is_err());
            assert!(state
                .update_bookmark(&user, "missing", BookmarkUpdate::default())
                .is_err());
            assert!(state.delete_bookmark(&user, "missing").is_err());
        }
        assert_eq!(fs::read(path).unwrap(), original);
    }
}

#[test]
fn unreadable_collection_is_an_error() {
    let data = tempfile::tempdir().unwrap();
    let (state, user) = fixture(data.path());
    fs::create_dir(state.notes_path(&user.user_id).unwrap()).unwrap();
    assert!(state.list_notes(&user).is_err());
    assert!(state
        .create_note(&user, "new".into(), "fresh".into(), "test".into())
        .is_err());
}

#[test]
fn notes_roundtrip_after_restart() {
    let data = tempfile::tempdir().unwrap();
    let (state, user) = fixture(data.path());
    let note = state
        .create_note(
            &user,
            "fixture".into(),
            "synthetic preserved text".into(),
            "test".into(),
        )
        .unwrap();
    drop(state);
    let (state, user) = fixture(data.path());
    assert_eq!(
        state
            .list_notes(&user)
            .unwrap()
            .iter()
            .map(|note| (&note.id, note.content.as_str()))
            .collect::<Vec<_>>(),
        vec![(&note.id, "synthetic preserved text")]
    );
}

#[test]
fn atomic_write_preserves_old_open_file_and_cleans_temporary_files() {
    use std::io::Read;
    let data = tempfile::tempdir().unwrap();
    let path = data.path().join("fixture.json");
    fs::write(&path, b"[1]").unwrap();
    let mut old = fs::File::open(&path).unwrap();
    write_json_file(&path, &vec![2]).unwrap();
    let mut bytes = String::new();
    old.read_to_string(&mut bytes).unwrap();
    assert_eq!(bytes, "[1]");
    assert_eq!(read_json_file::<Vec<i32>>(&path).unwrap(), vec![2]);
    assert_eq!(fs::read_dir(data.path()).unwrap().count(), 1);
}
