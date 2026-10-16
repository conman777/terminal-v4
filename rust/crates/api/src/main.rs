use terminal_v4_api::{app, ApiState};
use terminal_v4_core::AppConfig;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|argument| argument == "agent")
    {
        let config = AppConfig::from_env();
        let exit_code = match terminal_v4_api::hermes_provider_bridge::run_agent_bridge(
            &config.data_dir,
            &arguments[1..],
        )
        .await
        {
            Ok(code) => code,
            Err(message) => {
                eprintln!("{message}");
                1
            }
        };
        std::process::exit(exit_code);
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("terminal_v4_api=info")),
        )
        .init();

    let config = AppConfig::from_env();
    config.validate_runtime()?;
    let state = ApiState::new(config.clone())?;
    state
        .terminal_manager()
        .recover_orphaned_tmux_sessions()
        .await;
    terminal_v4_api::workspace_tasks::start_worker(state.clone());
    let listener = tokio::net::TcpListener::bind(config.bind_addr()).await?;

    terminal_v4_api::start_services(&state);
    tracing::info!(address = %config.bind_addr(), "Rust API listening");

    let shutdown_state = state.clone();
    axum::serve(listener, app(state))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            terminal_v4_api::shutdown_services(&shutdown_state).await;
        })
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
