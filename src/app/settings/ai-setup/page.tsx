import Link from "next/link";

// In-app rendering of docs/AI_FEATURES_SETUP.md (2026-08-05) — step-by-step
// instructions for a new organization to (a) add their own Anthropic key and
// (b) connect their own WhatsApp Business API, so AI features (guest-reply
// approvals, translation, bill-photo extraction, etc.) can run on their own
// account instead of the shared platform default. Kept as a plain static
// page (no markdown renderer dependency) since the content changes rarely
// and this app has no other in-app docs/help surface yet — linked from the
// Settings page's "AI (Claude)" and "WhatsApp" sections so a new tenant
// finds it without needing repo access to docs/AI_FEATURES_SETUP.md.

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold mt-8 mb-2">{children}</h2>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-black/70 dark:text-white/70 leading-relaxed mb-3">{children}</p>;
}

function OL({ children }: { children: React.ReactNode }) {
  return <ol className="list-decimal list-outside pl-5 space-y-2 text-sm text-black/70 dark:text-white/70 mb-4">{children}</ol>;
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10 text-[13px]">{children}</code>
  );
}

function Quote({ children }: { children: React.ReactNode }) {
  return (
    <blockquote className="border-l-2 border-black/15 dark:border-white/20 pl-3 text-sm text-black/60 dark:text-white/60 italic my-2">
      {children}
    </blockquote>
  );
}

export default function AiSetupGuidePage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <Link href="/settings" className="text-xs text-black/50 dark:text-white/50 hover:underline">
        ← Back to Settings
      </Link>

      <h1 className="text-lg font-semibold mt-4">Setting up AI features for your organization</h1>
      <P>
        This covers the two things you can connect yourself to control your own AI features: your own{" "}
        <strong>Anthropic (Claude) API key</strong>, and your own <strong>WhatsApp Business API</strong> connection.
        Both are optional — every AI feature already works on the platform&apos;s shared Claude key. Do this if you
        want your own Anthropic billing, a higher usage cap, or your own WhatsApp number sending approval texts.
      </P>
      <P>
        Do OwnerRez first if you haven&apos;t already (Settings → OwnerRez) — every AI feature reads real
        booking/guest data from there, so nothing below is useful until that&apos;s connected.
      </P>

      <H2>What each thing unlocks</H2>
      <div className="overflow-x-auto mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-black/50 dark:text-white/50 border-b border-black/10 dark:border-white/10">
              <th className="py-2 pr-4 font-medium">Feature</th>
              <th className="py-2 pr-4 font-medium">Own Claude key?</th>
              <th className="py-2 pr-4 font-medium">Own WhatsApp?</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["AI-drafted guest replies (approved by text)", "No — shared key works", "Yes, to receive/approve drafts"],
              ["EN/ES (and other language) translation", "No — shared key works", "No"],
              ["AI review-response drafting (Reputation tab)", "No — shared key works", "No"],
              ["AI rate recommendations (Revenue Management)", "No — shared key works", "No"],
              ["AI lifecycle marketing message drafts", "No — shared key works", "No"],
              ["AI content/SEO drafts (Marketing tab)", "No — shared key works", "No"],
              ["Website AI chat widget", "No — shared key works", "Optional (human-escalation path)"],
              ["AI COO daily briefing", "No — shared key works", "No"],
              ["Bill/invoice photo extraction", "No — shared key works", "Yes, bills arrive as WhatsApp photos"],
            ].map((row) => (
              <tr key={row[0]} className="border-b border-black/5 dark:border-white/5 last:border-0 align-top">
                <td className="py-2 pr-4">{row[0]}</td>
                <td className="py-2 pr-4">{row[1]}</td>
                <td className="py-2 pr-4">{row[2]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <P>
        So: adding your own Claude key changes <em>whose account gets billed</em>, not <em>what works</em>. Adding
        your own WhatsApp connection is what actually turns on guest-reply approvals and bill-photo forwarding.
      </P>

      <H2>Step 1 — Add your own Anthropic (Claude) API key (optional)</H2>
      <OL>
        <li>
          Go to <Code>console.anthropic.com/settings/keys</Code> and sign in (or create an Anthropic account).
        </li>
        <li>
          Click <strong>Create Key</strong>, name it anything (e.g. &quot;CRM&quot;), and copy it — it starts with{" "}
          <Code>sk-ant-</Code>.
        </li>
        <li>Add a little prepaid credit (Anthropic Console → Billing) — $5–10 is plenty to start.</li>
        <li>
          In this CRM, go to <Link href="/settings" className="underline">Settings → AI (Claude)</Link>, paste the
          key into <strong>Anthropic API key</strong>, and click <strong>Save</strong>.
        </li>
      </OL>
      <P>
        That&apos;s it — every AI feature in the table above immediately starts running on your key and billing.
        Leave it blank at any time to fall back to the shared key again.
      </P>

      <H2>Step 2 — Set up WhatsApp Business API (optional, needed for guest-reply approvals)</H2>
      <P>
        This is Meta&apos;s setup process, not ours — about 15–20 minutes the first time. You&apos;ll end up with
        four values to paste into <Link href="/settings" className="underline">Settings → WhatsApp</Link>.
      </P>
      <OL>
        <li>
          Go to <Code>developers.facebook.com</Code> → <strong>My Apps</strong> → <strong>Create App</strong> →
          choose the <strong>Business</strong> app type → name it anything.
        </li>
        <li>
          On the app&apos;s dashboard, find <strong>WhatsApp</strong> in the product list and click{" "}
          <strong>Set up</strong>.
        </li>
        <li>
          On the WhatsApp <strong>API Setup</strong> page, note the <strong>Phone number ID</strong> and{" "}
          <strong>WhatsApp Business Account ID</strong> shown there — you&apos;ll need them below.
        </li>
        <li>
          Under <strong>From</strong>, either use the free test number Meta gives you, or click{" "}
          <strong>Add phone number</strong> to register a real number — a dedicated number is best, since this is
          the number that texts you every AI draft for approval.
        </li>
        <li>
          Generate a permanent access token (the free test number&apos;s default token expires in 24 hours — don&apos;t
          use that one):
          <ul className="list-disc list-outside pl-5 mt-2 space-y-1">
            <li>
              <strong>Business Settings</strong> (business.facebook.com/settings) → <strong>Users → System Users</strong>{" "}
              → <strong>Add</strong> → name it anything → role <strong>Admin</strong>.
            </li>
            <li>
              <strong>Add Assets</strong>, select your app under Apps, give it <strong>Full control</strong>.
            </li>
            <li>
              <strong>Generate New Token</strong>, select your app, check <Code>whatsapp_business_messaging</Code>{" "}
              and <Code>whatsapp_business_management</Code>, then <strong>Generate Token</strong>.
            </li>
          </ul>
        </li>
        <li>Copy the token immediately — Meta only shows it once.</li>
        <li>
          In this CRM, go to <Link href="/settings" className="underline">Settings → WhatsApp (Meta Cloud API)</Link>{" "}
          and paste in: the access token, Phone Number ID, Business Account ID, and your own WhatsApp number (E.164,
          no <Code>+</Code>) that should receive approval texts.
        </li>
        <li>
          Pick a <strong>Verify Token</strong> — any random string you make up. Contact us so we can set it on your
          organization to match, and use the same string in the next step.
        </li>
        <li>
          Back in the Meta app, go to <strong>WhatsApp → Configuration</strong>, click <strong>Edit</strong> next to
          Webhook, and set:
          <ul className="list-disc list-outside pl-5 mt-2 space-y-1">
            <li>
              <strong>Callback URL</strong>: <Code>https://&lt;your-crm-domain&gt;/api/whatsapp/webhook</Code>
            </li>
            <li>
              <strong>Verify token</strong>: the exact string from the previous step
            </li>
            <li>
              Click <strong>Verify and Save</strong>, then <strong>Manage</strong> and subscribe to the{" "}
              <Code>messages</Code> field.
            </li>
          </ul>
        </li>
        <li>Send a WhatsApp message to your new business number from your own phone to confirm the webhook fires.</li>
      </OL>
      <P>
        Once this is done, new guest messages will start texting you AI-drafted replies to approve, and any
        bill/invoice photo you forward to that number gets scanned into the Bill Pay tab automatically.
      </P>
      <P>
        <strong>Reply protocol</strong> for every AI approval text, whichever feature it&apos;s from:
      </P>
      <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-black/70 dark:text-white/70 mb-4">
        <li>
          <Code>YES</Code> — sends the drafted reply exactly as-is
        </li>
        <li>
          <Code>NO</Code> — discards it, nothing is sent
        </li>
        <li>
          <Code>EDIT: your text</Code> — sends your own text instead of the draft
        </li>
      </ul>
      <P>
        If more than one approval is waiting at once, swipe-to-reply on the specific WhatsApp message you&apos;re
        answering so it knows which one you mean.
      </P>

      <H2>Step 3 (optional, advanced) — Approve extra message templates</H2>
      <P>
        A couple of outbound, business-initiated WhatsApp messages (ones that open a brand-new conversation rather
        than replying inside a 24-hour guest window) require a Meta-preapproved template rather than free text —
        this is a WhatsApp platform rule. You only need these for the specific features below.
      </P>
      <OL>
        <li>
          <strong>Property-manager auto-notify on service requests</strong> — if a teammate should get pinged
          automatically whenever a guest asks about a paid add-on (chef, boat rental, etc.): create a{" "}
          <strong>Utility</strong>-category template named <Code>service_request_alert</Code> at{" "}
          <Code>business.facebook.com/latest/whatsapp_manager/message_templates</Code>, body text using Meta&apos;s{" "}
          <Code>{"{{1}}"}</Code>–<Code>{"{{4}}"}</Code> variables:
          <Quote>
            New service request at {"{{1}}"}. Guest: {"{{2}}"}, WhatsApp: {"{{3}}"}. They&apos;re asking about:{" "}
            {"{{4}}"}. Please reach out and coordinate.
          </Quote>
        </li>
        <li>
          <strong>Chat widget phone fallback</strong> — texting a website visitor&apos;s own phone if they leave
          before your reply is ready: create a <strong>Utility</strong> template named{" "}
          <Code>chat_widget_reply</Code> with <Code>{"{{1}}"}</Code>/<Code>{"{{2}}"}</Code> variables:
          <Quote>
            Hi {"{{1}}"}, thanks for reaching out! Here&apos;s the answer to your question: {"{{2}}"}
          </Quote>
        </li>
      </OL>
      <P>
        Submit either for review in Meta&apos;s template manager — usually approved within minutes to a couple
        hours. Let us know once approved so we can wire the template name into your organization&apos;s settings.
      </P>

      <H2>Troubleshooting</H2>
      <ul className="list-disc list-outside pl-5 space-y-2 text-sm text-black/70 dark:text-white/70 mb-8">
        <li>
          <strong>Not getting any WhatsApp texts at all</strong> — double check the four WhatsApp values in Settings
          are saved, and the webhook in Meta shows &quot;Active&quot; with a green dot under WhatsApp → Configuration.
        </li>
        <li>
          <strong>Translation/AI drafting says &quot;not configured&quot;</strong> — means neither your own key nor
          the shared platform key is reachable — let us know, this usually means the shared key ran out of credit.
        </li>
        <li>
          <strong>A WhatsApp reply of YES/NO/EDIT: didn&apos;t do anything</strong> — the approval it was answering
          may have expired or been superseded by a newer guest message — check the Messaging tab for the current
          state of that conversation.
        </li>
      </ul>
    </div>
  );
}
