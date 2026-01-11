#!/bin/bash
# Restart the terminal-v4 backend with minimal downtime

cd ~/terminal-v4/backend

# Load environment variables
set -a
source .env 2>/dev/null
set +a

echo "Building backend..."
npm run build

echo "Stopping server gracefully..."
pkill -f "node.*dist/index.js" 2>/dev/null

# Wait for process to actually exit (graceful shutdown needs time to save sessions)
MAX_WAIT=10
WAITED=0
while pgrep -f "node.*dist/index.js" > /dev/null; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "Warning: Server didn't stop gracefully, force killing..."
    pkill -9 -f "node.*dist/index.js" 2>/dev/null
    sleep 1
    break
  fi
  echo "Waiting for server to stop... ($WAITED/$MAX_WAIT)"
  sleep 1
  WAITED=$((WAITED + 1))
done

echo "Starting server..."
nohup npm start > /tmp/backend.log 2>&1 &

sleep 2
if curl -s http://localhost:3020/api/health | grep -q "ok"; then
  echo "Server restarted successfully!"
else
  echo "Warning: Server may not have started correctly. Check /tmp/backend.log"
fi
