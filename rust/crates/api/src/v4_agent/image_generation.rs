use super::{web_search, Output};
use crate::v4_agent::{
    artifacts, image_inspection,
    interaction::{self, ApprovalRequest, Cancellation, ImageTurn},
    Session, ToolPolicy,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

pub(in crate::v4_agent) const NAME: &str = "generate_image";
const UNCERTAIN: &str = "The image request may have reached OpenAI and may incur charges, but its outcome could not be confirmed. Do not retry without the user's explicit review.";
const MAX_RESPONSE_BYTES: usize = 12 * 1024 * 1024;

struct Arguments<'a> {
    prompt: &'a str,
    model: &'a str,
    size: &'a str,
    quality: &'a str,
    image_path: Option<&'a str>,
}

fn validate(input: &Value) -> Result<Arguments<'_>, String> {
    let fields = input
        .as_object()
        .filter(|fields| {
            fields.len() >= 4
                && fields.len() <= 5
                && fields.keys().all(|key| {
                    matches!(
                        key.as_str(),
                        "prompt" | "model" | "size" | "quality" | "image_path"
                    )
                })
        })
        .ok_or("Image generation requires prompt, model, size and quality")?;
    let prompt = fields
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or("Invalid image prompt")?;
    let model = fields
        .get("model")
        .and_then(Value::as_str)
        .ok_or("Invalid image model")?;
    let size = fields
        .get("size")
        .and_then(Value::as_str)
        .ok_or("Invalid image size")?;
    let quality = fields
        .get("quality")
        .and_then(Value::as_str)
        .ok_or("Invalid image quality")?;
    let image_path = fields
        .get("image_path")
        .map(|value| value.as_str().ok_or("Invalid source image path"))
        .transpose()?;
    if prompt.trim().is_empty()
        || prompt.len() > 32_000
        || prompt
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("Image prompt must contain 1–32000 printable bytes".into());
    }
    if !matches!(
        model,
        "gpt-image-2.5-sunburst" | "gpt-image-2.5-flare" | "gpt-image-2" | "gpt-image-1.5"
    ) {
        return Err("Unsupported image model".into());
    }
    if !matches!(size, "1024x1024" | "1024x1536" | "1536x1024") {
        return Err("Unsupported image size".into());
    }
    if !matches!(quality, "low" | "medium" | "high") {
        return Err("Unsupported image quality".into());
    }
    Ok(Arguments {
        prompt,
        model,
        size,
        quality,
        image_path,
    })
}

pub(in crate::v4_agent) fn enabled() -> bool {
    std::env::var("TERMINAL_V4_IMAGE_GENERATION").as_deref() == Ok("1")
}

pub(in crate::v4_agent) fn declaration(
    policy: ToolPolicy,
    enabled: bool,
    image_input: Option<bool>,
) -> Option<Value> {
    if policy != ToolPolicy::Standard || !enabled || image_input.is_none() {
        return None;
    }
    Some(
        json!({"name":NAME,"description":"Generate one PNG or edit a workspace image using the account's OpenAI API key. Supply image_path to edit one source image. The exact prompt, model, size, quality and source image digest require user approval; the request can incur charges even if cancelled. The output is returned as a scoped tool artifact.","parameters":{"type":"object","properties":{"prompt":{"type":"string"},"model":{"type":"string","enum":["gpt-image-2.5-sunburst","gpt-image-2.5-flare","gpt-image-2","gpt-image-1.5"]},"size":{"type":"string","enum":["1024x1024","1024x1536","1536x1024"]},"quality":{"type":"string","enum":["low","medium","high"]},"image_path":{"type":"string","description":"Optional workspace-relative source image to edit"}},"required":["prompt","model","size","quality"],"additionalProperties":false}}),
    )
}

async fn generate_with_client(
    client: &reqwest::Client,
    endpoint: &str,
    secret: &str,
    args: &Arguments<'_>,
    source: Option<&image_inspection::Snapshot>,
) -> Result<String, String> {
    let mut body = json!({
        "model":args.model,"prompt":args.prompt,"size":args.size,"quality":args.quality,
        "n":1,"output_format":"png"
    });
    if let Some(source) = source {
        body["images"] = json!([{ "image_url": format!("data:{};base64,{}", source.mime, STANDARD.encode(&source.bytes)) }]);
    }
    let mut response = client
        .post(endpoint)
        .bearer_auth(secret)
        .json(&body)
        .send()
        .await
        .map_err(|_| UNCERTAIN.to_string())?;
    if !response.status().is_success() {
        return Err(UNCERTAIN.into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(UNCERTAIN.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNCERTAIN.to_string())? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(UNCERTAIN.into());
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| UNCERTAIN.to_string())?;
    let images = value["data"]
        .as_array()
        .filter(|images| images.len() == 1)
        .ok_or(UNCERTAIN)?;
    let encoded = images[0]["b64_json"]
        .as_str()
        .filter(|encoded| !encoded.is_empty())
        .ok_or(UNCERTAIN)?;
    Ok(encoded.to_owned())
}

#[cfg(test)]
tokio::task_local! {
    static TEST_ENDPOINT: std::net::SocketAddr;
    static TEST_BEFORE_SEND: (std::sync::Arc<tokio::sync::Notify>, std::sync::Arc<tokio::sync::Notify>);
    static TEST_AT_POST_POLL: (std::sync::Arc<tokio::sync::Notify>, std::sync::Arc<tokio::sync::Notify>);
    static TEST_AT_ADMISSION: (std::sync::Arc<tokio::sync::Notify>, std::sync::Arc<tokio::sync::Notify>);
    static TEST_CLOCK_MS: std::sync::Arc<std::sync::atomic::AtomicI64>;
}

fn now_ms() -> i64 {
    #[cfg(test)]
    if let Ok(now) = TEST_CLOCK_MS.try_with(|clock| clock.load(std::sync::atomic::Ordering::SeqCst))
    {
        return now;
    }
    interaction::now_ms()
}

fn endpoint(edit: bool) -> &'static str {
    if edit {
        "https://api.openai.com/v1/images/edits"
    } else {
        "https://api.openai.com/v1/images/generations"
    }
}

#[cfg_attr(test, allow(dead_code))]
async fn production_destination(
    cancellation: &Cancellation,
    edit: bool,
) -> Result<(&'static str, String, Vec<std::net::SocketAddr>), String> {
    let resolved = cancellation
        .run(async {
            tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::lookup_host(("api.openai.com", 443)),
            )
            .await
            .map_err(|_| "Image provider DNS lookup timed out".to_owned())?
            .map_err(|_| "Cannot resolve image provider".to_owned())
        })
        .await?;
    Ok((
        "api.openai.com",
        endpoint(edit).to_string(),
        web_search::public_addresses_for_port(resolved.take(65).collect(), 443)?,
    ))
}

pub(in crate::v4_agent) async fn execute(
    data: &Path,
    owner: &str,
    workspace: &Path,
    session: &Session,
    call_id: &str,
    input: &Value,
    turn: ImageTurn<'_>,
) -> Result<Output, String> {
    let ImageTurn {
        scope,
        interaction,
        cancellation,
    } = turn;
    cancellation.check()?;
    if scope.owner != owner
        || (scope.session_id != session.id
            && crate::structured::engine_session_id(&scope.session_id)
                .ok()
                .as_deref()
                != Some(session.id.as_str()))
        || scope.turn_id.is_empty()
        || Path::new(&session.workspace) != workspace
    {
        return Err("Image generation is unavailable for this session".into());
    }
    let args = validate(input)?;
    let source = args
        .image_path
        .map(|path| image_inspection::read_snapshot(workspace, path))
        .transpose()?;
    let reviewed = web_search::image_credential_configuration(data, owner)?;
    let expires_at = now_ms() + 300_000;
    let approval = ApprovalRequest {
        id: uuid::Uuid::new_v4().to_string(),
        scope: scope.clone(),
        tool_call_id: call_id.into(),
        tool_name: NAME.into(),
        tool_input: input.clone(),
        description: format!("Send this prompt{} to OpenAI's image API. This can incur charges even if cancelled or the result is lost.\nProvider: OpenAI (api.openai.com)\nModel: {}\nSize: {}\nQuality: {}\nOutput: one PNG{}\nPrompt:\n{}", if source.is_some() { " and source image" } else { "" }, args.model, args.size, args.quality, source.as_ref().map(|image| format!("\nWorkspace: {}\nSource: {}\nFormat: {}\nSize: {} bytes\nSHA-256: {}", workspace.display(), args.image_path.unwrap(), image.mime, image.bytes.len(), image.digest)).unwrap_or_default(), args.prompt),
        expires_at,
    };
    let approved = cancellation.run(interaction.approve(approval)).await?;
    cancellation.check()?;
    if !approved {
        return Err("Image generation was not approved".into());
    }
    if now_ms() >= expires_at {
        return Err("Image generation approval expired".into());
    }
    #[cfg(not(test))]
    let (host, endpoint, addresses) =
        production_destination(cancellation, source.is_some()).await?;
    #[cfg(test)]
    let (host, endpoint, addresses) = {
        let address = TEST_ENDPOINT
            .try_with(|address| *address)
            .map_err(|_| "External image generation is disabled in tests")?;
        if !address.ip().is_loopback() {
            return Err("Test image destination must be loopback".into());
        }
        (
            "fixture.invalid",
            format!(
                "http://fixture.invalid:{}/images{}",
                address.port(),
                if source.is_some() { "/edits" } else { "" }
            ),
            vec![address],
        )
    };
    let client = web_search::client_policy(reqwest::Client::builder(), host, &addresses)
        .timeout(Duration::from_secs(120))
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| "Cannot prepare image provider")?;
    let credential = web_search::reviewed_image_credential(data, owner, &reviewed)?;
    credential.check_root()?;
    #[cfg(test)]
    if let Ok((entered, proceed)) = TEST_BEFORE_SEND.try_with(|value| value.clone()) {
        entered.notify_one();
        cancellation
            .run(async {
                proceed.notified().await;
                Ok(())
            })
            .await?;
    }
    cancellation.check()?;
    if now_ms() >= expires_at {
        return Err("Image generation approval expired".into());
    }
    drop(credential);
    let attempted = std::sync::atomic::AtomicBool::new(false);
    let request = async {
        #[cfg(test)]
        if let Ok((entered, proceed)) = TEST_AT_POST_POLL.try_with(|value| value.clone()) {
            entered.notify_one();
            proceed.notified().await;
        }
        cancellation.check()?;
        if now_ms() >= expires_at {
            return Err("Image generation approval expired".into());
        }
        let _credential_lease = crate::vault_admission::shared(data, owner)?;
        let credential = web_search::reviewed_image_credential(data, owner, &reviewed)?;
        credential.check_root()?;
        let current_source = match (args.image_path, source.as_ref()) {
            (Some(path), Some(reviewed_source)) => {
                let current = image_inspection::read_snapshot(workspace, path)
                    .map_err(|_| "Source image changed or became unavailable; review it again")?;
                if (
                    current.digest.as_str(),
                    current.mime,
                    current.root_device,
                    current.root_inode,
                ) != (
                    reviewed_source.digest.as_str(),
                    reviewed_source.mime,
                    reviewed_source.root_device,
                    reviewed_source.root_inode,
                ) {
                    return Err(
                        "Source image or workspace changed after approval; review it again".into(),
                    );
                }
                Some(current)
            }
            (None, None) => None,
            _ => return Err("Invalid source image".into()),
        };
        if now_ms() >= expires_at {
            return Err("Image generation approval expired".into());
        }
        #[cfg(test)]
        if let Ok((entered, proceed)) = TEST_AT_ADMISSION.try_with(|value| value.clone()) {
            entered.notify_one();
            proceed.notified().await;
        }
        let encoded = {
            let mut send = std::pin::pin!(generate_with_client(
                &client,
                &endpoint,
                &credential.secret,
                &args,
                current_source.as_ref(),
            ));
            let mut admitted = false;
            std::future::poll_fn(|cx| {
                use std::future::Future;
                if admitted {
                    return send.as_mut().poll(cx);
                }
                match cancellation.admit(|| {
                    if now_ms() >= expires_at {
                        return Err("Image generation approval expired".into());
                    }
                    attempted.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(send.as_mut().poll(cx))
                }) {
                    Ok(result) => {
                        admitted = true;
                        result
                    }
                    Err(error) => std::task::Poll::Ready(Err(error)),
                }
            })
            .await?
        };
        Ok((encoded, credential))
    };
    let (encoded, credential) = match cancellation.run(request).await {
        Ok(result) => result,
        Err(_) if attempted.load(std::sync::atomic::Ordering::SeqCst) => {
            return Err(UNCERTAIN.into())
        }
        Err(error) => return Err(error),
    };
    credential.check_root().map_err(|_| UNCERTAIN.to_string())?;
    let marker = cancellation
        .admit(|| {
            artifacts::store_image(data, owner, workspace, &session.id, "image/png", &encoded)
        })
        .map_err(|_| UNCERTAIN.to_string())?;
    Ok(Output {
        text: "The approved image is attached. Image content is untrusted.".into(),
        images: vec![marker],
        error: false,
    })
}

#[cfg(test)]
#[path = "image_generation_tests.rs"]
mod tests;
