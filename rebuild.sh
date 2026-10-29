#!/bin/bash
set -euo pipefail
project_root="${REBUILD_PROJECT_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
cd -- "$project_root"

echo "Building frontend..."
npm run frontend:build

echo "Building Rust backend..."
cargo build --release -p terminal-v4-api --manifest-path rust/Cargo.toml

echo "Build complete. Restart the owning application or service to use the updated runtime."
