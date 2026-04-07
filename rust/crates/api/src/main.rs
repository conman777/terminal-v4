use terminal_v4_api::{app, ApiState};
use terminal_v4_core::AppConfig;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("terminal_v4_api=info")),
        )
        .init();

    let config = AppConfig::from_env();
    let state = ApiState::new(config.clone())?;
    state
        .terminal_manager()
        .recover_orphaned_tmux_sessions()
        .await;
    let listener = tokio::net::TcpListener::bind(config.bind_addr()).await?;

    tracing::info!(address = %config.bind_addr(), "Rust API listening");

    axum::serve(listener, app(state)).await?;

    Ok(())
}
