$ErrorActionPreference = 'Stop'
$projectRoot = if ($env:REBUILD_PROJECT_ROOT) { $env:REBUILD_PROJECT_ROOT } else { $PSScriptRoot }
Push-Location -LiteralPath $projectRoot
try {
    npm run frontend:build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
    cargo build --release -p terminal-v4-api --manifest-path rust/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Rust backend build failed' }
    Write-Output 'Build complete. Restart the owning application or service to use the updated runtime.'
} finally {
    Pop-Location
}
