#!/bin/bash
# Double-click this file to start the Legacy Colombia dashboard.
# You do not need to know how to code to use this — just double-click it.

cd "$(dirname "$0")"

echo "======================================"
echo " Legacy Colombia Dashboard — starting"
echo "======================================"
echo ""

# Check that Node.js is installed
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js isn't installed on this Mac yet."
  echo ""
  echo "One-time setup needed:"
  echo "  1. Go to https://nodejs.org"
  echo "  2. Click the big 'Get Node.js' button and download it for Mac"
  echo "  3. Open the downloaded file and click through the installer"
  echo "  4. Come back and double-click this file again"
  echo ""
  read -p "Press Enter to close this window..."
  exit 1
fi

# First run only: install the app's dependencies (takes a minute or two)
if [ ! -d "node_modules" ]; then
  echo "First time setup — this takes a minute or two, please wait..."
  echo ""
  npm install
  echo ""
  echo "Setup complete!"
  echo ""
fi

# Open the dashboard in your browser automatically once it's ready
( sleep 4 && open "http://localhost:3000" ) &

echo "Starting the dashboard... your browser will open automatically in a few seconds."
echo "To stop the dashboard later, just close this window."
echo ""

npm run dev
