#!/bin/bash
# Double-click this to print a SAFE, password-hidden breakdown of your
# database connection settings, to help Claude figure out why the database
# setup is failing. Nothing sensitive is shown.

cd "$(dirname "$0")"
echo "=========================================="
echo " Diagnosing Database Connection"
echo "=========================================="
node scripts/diagnose-db.mjs
echo ""
echo "=========================================="
read -p "Press Enter to close this window..."
