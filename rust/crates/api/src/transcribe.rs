use std::time::Duration;

const GROQ_API_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL: &str = "whisper-large-v3";

struct TranscribeConfig {
    local_url: Option<String>,
    groq_key: Option<String>,
}

impl TranscribeConfig {
    fn from_environment(api_key: Option<&str>) -> Self {
        Self {
            local_url: local_whisper_url(),
            groq_key: api_key
                .filter(|key| !key.trim().is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    std::env::var("GROQ_API_KEY")
                        .ok()
                        .filter(|key| !key.trim().is_empty())
                }),
        }
    }

    async fn health_check(&self, provider: Option<&str>) -> Result<TranscribeHealth, String> {
        if !matches!(provider, None | Some("local" | "groq")) {
            return Err(format!("Unknown provider: {}", provider.unwrap()));
        }
        if provider != Some("groq") {
            if let Some(url) = &self.local_url {
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(3))
                    .build()
                    .map_err(|error| error.to_string())?;
                let reachable = client
                    .get(url)
                    .send()
                    .await
                    .is_ok_and(|response| response.status().is_success());
                if reachable || provider == Some("local") {
                    return Ok(TranscribeHealth {
                        available: reachable,
                        provider: "local".into(),
                        message: if reachable {
                            "OK"
                        } else {
                            "Local Whisper server not available"
                        }
                        .into(),
                    });
                }
            } else if provider == Some("local") {
                return Ok(TranscribeHealth {
                    available: false,
                    provider: "local".into(),
                    message: "Local Whisper server not available".into(),
                });
            }
        }
        Ok(TranscribeHealth {
            available: self.groq_key.is_some(),
            provider: "groq".into(),
            message: if self.groq_key.is_some() {
                "OK"
            } else {
                "No Groq API key configured"
            }
            .into(),
        })
    }

    async fn transcribe(
        &self,
        audio_data: Vec<u8>,
        filename: &str,
        provider: Option<&str>,
    ) -> Result<TranscribeResult, String> {
        if !matches!(provider, None | Some("local" | "groq")) {
            return Err(format!("Unknown provider: {}", provider.unwrap()));
        }
        if provider != Some("groq") {
            if let Some(url) = &self.local_url {
                let local_result = transcribe_local(url, audio_data.clone(), filename).await;
                match local_result {
                    Ok(result) => return Ok(result),
                    Err(error) if provider == Some("local") => return Err(error),
                    Err(_) => {}
                }
            } else if provider == Some("local") {
                return Err("Local Whisper server not available".into());
            }
        }
        let key = self
            .groq_key
            .as_deref()
            .ok_or("No Groq API key configured")?;
        transcribe_groq(key, audio_data, filename).await
    }
}

/// Check the configured provider without transmitting audio.
pub async fn health_check(
    provider: Option<&str>,
    api_key: Option<&str>,
) -> Result<TranscribeHealth, String> {
    TranscribeConfig::from_environment(api_key)
        .health_check(provider)
        .await
}

/// Explicit providers never fall back; the default prefers local Whisper, then Groq.
pub async fn transcribe(
    audio_data: Vec<u8>,
    filename: &str,
    api_key: Option<&str>,
    provider: Option<&str>,
) -> Result<TranscribeResult, String> {
    TranscribeConfig::from_environment(api_key)
        .transcribe(audio_data, filename, provider)
        .await
}

async fn transcribe_local(
    base_url: &str,
    audio_data: Vec<u8>,
    filename: &str,
) -> Result<TranscribeResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Client error: {e}"))?;

    let part = reqwest::multipart::Part::bytes(audio_data)
        .file_name(filename.to_string())
        .mime_str("audio/webm")
        .map_err(|e| format!("MIME error: {e}"))?;

    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "json");

    let response = client
        .post(format!("{base_url}/inference"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Local transcription failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Local whisper returned {}", response.status()));
    }

    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let text = body["text"].as_str().unwrap_or("").to_string();

    Ok(TranscribeResult {
        text,
        provider: "local".to_string(),
    })
}

async fn transcribe_groq(
    api_key: &str,
    audio_data: Vec<u8>,
    filename: &str,
) -> Result<TranscribeResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Client error: {e}"))?;

    let part = reqwest::multipart::Part::bytes(audio_data)
        .file_name(filename.to_string())
        .mime_str("audio/webm")
        .map_err(|e| format!("MIME error: {e}"))?;

    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", GROQ_MODEL)
        .text("response_format", "json");

    let response = client
        .post(GROQ_API_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Groq API failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Groq API returned {status}: {body}"));
    }

    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let text = body["text"].as_str().unwrap_or("").to_string();

    Ok(TranscribeResult {
        text,
        provider: "groq".to_string(),
    })
}

fn local_whisper_url() -> Option<String> {
    std::env::var("WHISPER_SERVER_URL")
        .ok()
        .filter(|v| !v.is_empty())
}

#[derive(Debug, serde::Serialize)]
pub struct TranscribeHealth {
    pub available: bool,
    pub provider: String,
    pub message: String,
}

#[derive(Debug, serde::Serialize)]
pub struct TranscribeResult {
    pub text: String,
    pub provider: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        routing::{get, post},
        Json, Router,
    };
    use axum_extra::extract::Multipart;
    use serde_json::json;

    async fn local_fixture(fail: bool) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route("/", get(|| async { "OK" })).route(
            "/inference",
            post(move |mut multipart: Multipart| async move {
                if fail {
                    return Err(axum::http::StatusCode::SERVICE_UNAVAILABLE);
                }
                let field = multipart.next_field().await.unwrap().unwrap();
                assert_eq!(field.name(), Some("file"));
                assert_eq!(field.file_name(), Some("fixture.webm"));
                assert_eq!(field.bytes().await.unwrap(), "synthetic-audio");
                Ok(Json(json!({ "text": "Synthetic transcript" })))
            }),
        );
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (format!("http://{address}"), task)
    }

    #[tokio::test]
    async fn default_provider_uses_available_local_whisper_without_a_groq_key() {
        let (url, task) = local_fixture(false).await;
        let config = TranscribeConfig {
            local_url: Some(url),
            groq_key: None,
        };
        let health = config.health_check(None).await.unwrap();
        assert!(health.available);
        assert_eq!(health.provider, "local");
        let result = config
            .transcribe(b"synthetic-audio".to_vec(), "fixture.webm", None)
            .await
            .unwrap();
        assert_eq!(result.text, "Synthetic transcript");
        assert_eq!(result.provider, "local");
        task.abort();
    }

    #[tokio::test]
    async fn explicit_groq_never_silently_uses_local_provider() {
        let (url, task) = local_fixture(false).await;
        let config = TranscribeConfig {
            local_url: Some(url),
            groq_key: None,
        };
        assert!(!config.health_check(Some("groq")).await.unwrap().available);
        let error = config
            .transcribe(b"synthetic-audio".to_vec(), "fixture.webm", Some("groq"))
            .await
            .unwrap_err();
        assert_eq!(error, "No Groq API key configured");
        task.abort();
    }

    #[tokio::test]
    async fn explicit_local_failure_does_not_send_audio_to_groq() {
        let (url, task) = local_fixture(true).await;
        let config = TranscribeConfig {
            local_url: Some(url),
            groq_key: Some("synthetic-key-never-sent".into()),
        };
        let error = config
            .transcribe(b"synthetic-audio".to_vec(), "fixture.webm", Some("local"))
            .await
            .unwrap_err();
        assert!(error.contains("503"), "{error}");
        task.abort();
    }

    #[tokio::test]
    async fn saved_key_enables_groq_health_without_contacting_provider() {
        let config = TranscribeConfig {
            local_url: None,
            groq_key: Some("synthetic-saved-key".into()),
        };
        let health = config.health_check(Some("groq")).await.unwrap();
        assert!(health.available);
        assert_eq!(health.provider, "groq");
    }

    #[tokio::test]
    async fn rejects_unknown_provider_before_transcription() {
        let config = TranscribeConfig {
            local_url: None,
            groq_key: None,
        };
        assert!(config
            .health_check(Some("unknown"))
            .await
            .unwrap_err()
            .contains("Unknown provider"));
        assert!(config
            .transcribe(vec![], "fixture.webm", Some("unknown"))
            .await
            .unwrap_err()
            .contains("Unknown provider"));
    }
}
