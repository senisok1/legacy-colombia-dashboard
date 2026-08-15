#!/bin/bash
# Double-click this file to create the tables the new CRM database needs.
# Safe to double-click more than once — it skips anything already set up.

cd "$(dirname "$0")"

echo "=========================================="
echo " Setting Up Legacy Colombia CRM Database"
echo "=========================================="
echo ""

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js isn't installed yet — see the setup steps for 'Start Dashboard.command' first."
  read -p "Press Enter to close this window..."
  exit 1
fi

if [ ! -f ".env.local" ]; then
  echo "Missing .env.local. In Terminal, run this once first:"
  echo "  npx --yes vercel env pull .env.local --environment=preview"
  echo ""
  read -p "Press Enter to close this window..."
  exit 1
fi

npm run db:migrate

echo ""
echo "=========================================="
echo " Done!"
echo "=========================================="
echo ""
echo "Next: double-click 'Create My Login.command' to set up your personal"
echo "email + password for the dashboard."
echo ""
read -p "Press Enter to close this window..."
