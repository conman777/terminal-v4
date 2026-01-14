#!/bin/bash
# Restart the terminal-v4 backend with minimal downtime

set -e

cd ~/terminal-v4/backend

# Load environment variables
set -a
source .env 2>/dev/null || true
set +a

echo "Building backend..."
npm run build

# Function to find PID using port 3020
get_pid_on_port() {
  lsof -t -i:3020 2>/dev/null || true
}

# Function to check if port is free
port_is_free() {
  ! lsof -i:3020 > /dev/null 2>&1
}

echo "Stopping server gracefully..."

# First try graceful shutdown via pkill
pkill -f "node.*dist/index.js" 2>/dev/null || true

# Wait for process to exit
MAX_WAIT=10
WAITED=0
while ! port_is_free; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "Warning: Server didn't stop gracefully, force killing..."
    PID=$(get_pid_on_port)
    if [ -n "$PID" ]; then
      kill -9 $PID 2>/dev/null || true
    fi
    pkill -9 -f "node.*dist/index.js" 2>/dev/null || true
    sleep 2
    break
  fi
  echo "Waiting for server to stop... ($WAITED/$MAX_WAIT)"
  sleep 1
  WAITED=$((WAITED + 1))
done

# Final check that port is free
if ! port_is_free; then
  echo "ERROR: Port 3020 is still in use after force kill!"
  echo "Process using port:"
  lsof -i:3020 || true
  exit 1
fi

echo "Port 3020 is free, starting server..."
nohup npm start > /tmp/backend.log 2>&1 &

# Wait for server to be ready with retries
MAX_HEALTH_WAIT=15
HEALTH_WAITED=0
echo "Waiting for server to be ready..."
while [ $HEALTH_WAITED -lt $MAX_HEALTH_WAIT ]; do
  sleep 1
  HEALTH_WAITED=$((HEALTH_WAITED + 1))
  if curl -s http://localhost:3020/api/health 2>/dev/null | grep -q "ok"; then
    echo "Server restarted successfully! (took ${HEALTH_WAITED}s)"
    exit 0
  fi
  echo "  Health check attempt $HEALTH_WAITED/$MAX_HEALTH_WAIT..."
done

echo "ERROR: Server failed to start after ${MAX_HEALTH_WAIT}s"
echo "Last 30 lines of log:"
tail -30 /tmp/backend.log
exit 1
