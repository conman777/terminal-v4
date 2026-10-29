use super::*;
use async_trait::async_trait;

struct SyntheticExternalAuth(ExternalAuthUser);

#[async_trait]
impl ExternalAuthProvider for SyntheticExternalAuth {
    async fn get_user_by_identifier(
        &self,
        identifier: &str,
    ) -> Result<Option<ExternalAuthUser>, String> {
        Ok(
            (identifier == self.0.email || identifier == self.0.resolved_username())
                .then(|| self.0.clone()),
        )
    }
    async fn get_user_by_id(&self, id: &str) -> Result<Option<ExternalAuthUser>, String> {
        Ok((id == self.0.id).then(|| self.0.clone()))
    }
}

#[tokio::test]
async fn passkey_lookup_resolves_external_identity_without_exposing_mirror_username() {
    let data = tempfile::tempdir().unwrap();
    let external = ExternalAuthUser {
        id: Uuid::new_v4().to_string(),
        email: "passkey-fixture@example.invalid".into(),
        password_hash: "unused".into(),
        display_name: Some("passkey-fixture".into()),
        created_at: iso_timestamp(),
    };
    let state = AppState::new_with_external_auth(
        AppConfig {
            data_dir: data.path().into(),
            ..AppConfig::default()
        },
        Some(Arc::new(SyntheticExternalAuth(external.clone()))),
    )
    .unwrap();
    state
        .upsert_external_auth_mirror_user(&external.id)
        .unwrap();
    for identifier in [&external.email, &external.resolved_username()] {
        let actual = state
            .get_passkey_user_by_identifier(identifier)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            (actual.id, actual.username),
            (external.id.clone(), external.resolved_username())
        );
    }
    assert!(state
        .get_passkey_user_by_identifier("missing")
        .await
        .unwrap()
        .is_none());
    let mirror = external_auth_mirror_username(&external.id);
    assert!(state
        .get_passkey_user_by_identifier(&mirror)
        .await
        .unwrap()
        .is_none());
    let local = state
        .create_local_user_for_test(&external.resolved_username(), "synthetic-password")
        .unwrap();
    assert_eq!(
        state
            .get_passkey_user_by_identifier(&external.resolved_username())
            .await
            .unwrap()
            .unwrap()
            .id,
        local.id
    );
}
