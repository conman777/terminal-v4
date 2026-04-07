use std::time::Duration;

const GROQ_API_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL: &str = "whisper-large-v3";

/// Check transcription service health.
pub async fn health_check(provider: Option<&str>) -> Result<TranscribeHealth, String> {
    let local_available = local_whisper_url().is_some();
    let groq_available = std::env::var("GROQ_API_KEY").is_ok();

    match provider {
        Some("local") => {
            if !local_available {
                return Ok(TranscribeHealth {
                    available: false,
                    provider: "local".to_string(),
                    message: "WHISPER_SERVER_URL not set".to_string(),
                });
            }
            let url = local_whisper_url().unwrap();
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .map_err(|e| e.to_string())?;
            let reachable = client.get(&url).send().await.is_ok();
            Ok(TranscribeHealth {
                available: reachable,
                provider: "local".to_string(),
                message: if reachable {
                    "OK".to_string()
                } else {
                    "Unreachable".to_string()
                },
            })
        }
        Some("groq") | None => Ok(TranscribeHealth {
            available: groq_available,
            provider: "groq".to_string(),
            message: if groq_available {
                "OK".to_string()
            } else {
                "GROQ_API_KEY not set".to_string()
            },
        }),
        Some(other) => Err(format!("Unknown provider: {other}")),
    }
}

/// Transcribe audio data using Groq API or local Whisper.
pub async fn transcribe(
    audio_data: Vec<u8>,
    filename: &str,
    api_key: Option<&str>,
) -> Result<TranscribeResult, String> {
    // Try local Whisper first
    if let Some(url) = local_whisper_url() {
        match transcribe_local(&url, audio_data.clone(), filename).await {
            Ok(result) => return Ok(result),
            Err(_) => {} // Fall through to Groq
        }
    }

    // Groq API
    let key = api_key
        .map(|k| k.to_string())
        .or_else(|| std::env::var("GROQ_API_KEY").ok())
        .ok_or("No API key available for transcription")?;

    transcribe_groq(&key, audio_data, filename).await
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
