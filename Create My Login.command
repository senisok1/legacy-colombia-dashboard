#!/bin/bash
# Double-click this file to create your personal email + password login for
# the dashboard. It will ask you for an email and password right here —
# nothing to type in code, and your password won't show on screen as you
# type it. Safe to run again later to change your password.

cd "$(dirname "$0")"

echo "=========================================="
echo " Create Your Legacy Colombia CRM Login"
echo "=========================================="
echo ""

if [ ! -f ".env.local" ]; then
  echo "Missing .env.local — double-click 'Set Up Database.command' first."
  echo ""
  read -p "Press Enter to close this window..."
  exit 1
fi

read -p "Your email address: " CRM_EMAIL
read -s -p "Choose a password (hidden as you type): " CRM_PASSWORD
echo ""
read -p "Your name (optional — press Enter to skip): " CRM_NAME

if [ -z "$CRM_EMAIL" ] || [ -z "$CRM_PASSWORD" ]; then
  echo ""
  echo "Email and password are both required. Nothing was created."
  read -p "Press Enter to close this window..."
  exit 1
fi

node scripts/seed-user.mjs "$CRM_EMAIL" "$CRM_PASSWORD" "$CRM_NAME" CEO

echo ""
echo "=========================================="
echo " Done!"
echo "=========================================="
echo ""
echo "You'll be able to log in with that email + password at the /login"
echo "page once the dashboard is redeployed. Tell Claude you've done this"
echo "and it'll take care of the redeploy."
echo ""
read -p "Press Enter to close this window..."
