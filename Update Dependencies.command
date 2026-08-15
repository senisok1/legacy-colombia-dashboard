#!/bin/bash
# Double-click this file whenever Claude adds new packages to the project
# (you'll be told when that happens). It just installs them — no typing
# needed, safe to run any time.

cd "$(dirname "$0")"

echo "=========================================="
echo " Updating Legacy Colombia Dashboard Packages"
echo "=========================================="
echo ""

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js isn't installed yet — see the setup steps for 'Start Dashboard.command' first."
  read -p "Press Enter to close this window..."
  exit 1
fi

npm install

echo ""
echo "=========================================="
echo " Done! You can close this window and use"
echo " 'Start Dashboard.command' or the other"
echo " .command files normally now."
echo "=========================================="
echo ""
read -p "Press Enter to close this window..."
