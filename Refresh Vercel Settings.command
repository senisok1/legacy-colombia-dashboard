#!/bin/bash
# Double-click this to re-download your project's settings from Vercel
# (including the database connection info) into .env.local. Safe to run
# any time — this never changes anything on Vercel, only refreshes the
# local copy.

cd "$(dirname "$0")"

echo "=========================================="
echo " Refreshing Vercel Settings"
echo "=========================================="
echo ""

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js isn't installed yet — see the setup steps for 'Start Dashboard.command' first."
  read -p "Press Enter to close this window..."
  exit 1
fi

npx --yes vercel env pull .env.local --environment=preview

echo ""
echo "=========================================="
echo " Done! Now double-click 'Set Up Database.command' again."
echo "=========================================="
echo ""
read -p "Press Enter to close this window..."
