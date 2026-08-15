#!/bin/bash
# Double-click this file to publish your dashboard to a real website address
# (using Vercel, a free hosting service). You do not need to know how to code.

cd "$(dirname "$0")"

echo "=========================================="
echo " Publishing Legacy Colombia Dashboard"
echo "=========================================="
echo ""

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js isn't installed yet — see the setup steps for 'Start Dashboard.command' first."
  read -p "Press Enter to close this window..."
  exit 1
fi

echo "Checking you're logged into Vercel (the hosting service — think of it"
echo "like the landlord for your website)..."
echo ""

# whoami exits non-zero if not logged in yet — only run the interactive
# login flow in that case, so re-publishing doesn't force a fresh login
# every single time (and doesn't need you to sit here pressing Enter).
if ! npx --yes vercel whoami >/dev/null 2>&1; then
  echo "Not logged in yet. This may open your web browser and ask you to log"
  echo "in or sign up for a free Vercel account. If a browser tab opens, just"
  echo "follow what it says there, then come back to this window."
  echo ""
  echo "If instead you see a list of login options right here in this window,"
  echo "use the arrow keys to pick 'Continue with Email', press Enter, type"
  echo "your email address, press Enter, then check your email and click the"
  echo "confirmation link Vercel sends you."
  echo ""
  npx --yes vercel login
fi

echo ""
echo "Logged in. Setting up your project on Vercel..."
echo ""

# Only needs to actually create/link the project once — if it's already
# linked from a previous run, this is a harmless no-op.
if [ ! -f ".vercel/project.json" ]; then
  npx --yes vercel link --yes --project legacy-colombia-dashboard
fi

echo ""
echo "Now publishing your dashboard — this takes a minute..."
echo ""

npx --yes vercel --prod --yes

echo ""
echo "=========================================="
echo " Done!"
echo "=========================================="
echo ""
echo "Look above for a line starting with https:// — that's your live"
echo "website link. Save it somewhere (Notes app, bookmark it, etc.)."
echo ""
echo "IMPORTANT NEXT STEP: your dashboard is live but not password-protected"
echo "yet, and it's still showing demo data. Tell Claude 'I published it,"
echo "what's next' and it'll walk you through adding your OwnerRez info and"
echo "a login password on the Vercel website (just filling in a form, no"
echo "coding)."
echo ""
read -p "Press Enter to close this window..."
