#!/bin/bash
# Restart the terminal-v4 backend with minimal downtime

cd ~/terminal-v4/backend

# Load environment variables
set -a
source .env 2>/dev/null
set +a

echo "Building backend..."
npm run build

echo "Restarting server..."
pkill -f "node.*dist/index.js" 2>/dev/null
nohup npm start > /tmp/backend.log 2>&1 &

sleep 2
if curl -s http://localhost:3020/api/health | grep -q "ok"; then
  echo "Server restarted successfully!"
else
  echo "Warning: Server may not have started correctly. Check /tmp/backend.log"
fi
