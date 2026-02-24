#!/bin/bash
# Restart the terminal-v4 backend with minimal downtime

set -e

cd ~/terminal-v4/backend

echo "Building backend..."
npm run build

echo "Restarting service via systemd..."
sudo systemctl restart terminal-v4.service

# Wait for server to be ready with retries
MAX_HEALTH_WAIT=15
HEALTH_WAITED=0
echo "Waiting for server to be ready..."
while [ $HEALTH_WAITED -lt $MAX_HEALTH_WAIT ]; do
  sleep 1
  HEALTH_WAITED=$((HEALTH_WAITED + 1))
  if curl -sk https://localhost:3020/api/health 2>/dev/null | grep -q "ok" || curl -s http://localhost:3020/api/health 2>/dev/null | grep -q "ok"; then
    echo "Server restarted successfully! (took ${HEALTH_WAITED}s)"
    exit 0
  fi
  echo "  Health check attempt $HEALTH_WAITED/$MAX_HEALTH_WAIT..."
done

echo "ERROR: Server failed to start after ${MAX_HEALTH_WAIT}s"
echo "Last 30 lines of log:"
sudo journalctl -u terminal-v4.service -n 30 --no-pager
exit 1
