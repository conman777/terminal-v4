#!/bin/bash
set -e
cd /home/conor/terminal-v4

echo "Building frontend..."
cd frontend && npm run build

echo "Building backend..."
cd ../backend && npm run build

echo "Restarting service..."
# Note: Requires passwordless sudo for systemctl restart terminal-v4
# Add this to /etc/sudoers.d/terminal-v4:
# conor ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart terminal-v4
sudo /usr/bin/systemctl restart terminal-v4

echo "Done! App updated."
