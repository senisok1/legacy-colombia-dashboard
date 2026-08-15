"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

// Phase 2 onboarding wizard — the guided, "very simple" first-run experience
// for a brand-new signup, replacing a cold drop onto the flat /settings page.
// Reachable right after /api/signup, and also directly at /onboarding any
// time (e.g. if someone wants to revisit it from Settings).
//
// Same caveat as /settings and /signup: saving credentials here doesn't yet
// change what data this organization's dashboard shows — that's Phase 3.
// This wizard is fully functional (it really does save real, encrypted,
// per-org credentials) and is safe to use today; it's just that the payoff
// (their OWN OwnerRez data appearing) lands once Phase 3 ships.

type Step = "welcome" | "ownerrez" | "whatsapp" | "done";

async function saveCredential(key: string, value: string) {
  if (!value.trim()) return;
  await fetch("/api/settings/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("welcome");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // OwnerRez fields
  const [orEmail, setOrEmail] = useState("");
  const [orToken, setOrToken] = useState("");
  const [orPropertyName, setOrPropertyName] = useState("");

  // WhatsApp fields (optional)
  const [waToken, setWaToken] = useState("");
  const [waPhoneId, setWaPhoneId] = useState("");
  const [waBusinessId, setWaBusinessId] = useState("");
  const [waNumber, setWaNumber] = useState("");

  async function handleOwnerRezNext() {
    if (!orEmail.trim() || !orToken.trim() || !orPropertyName.trim()) {
      setError("Fill in all three fields to continue.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await Promise.all([
        saveCredential("ownerrez_email", orEmail),
        saveCredential("ownerrez_token", orToken),
        saveCredential("ownerrez_property_name", orPropertyName),
      ]);
      setStep("whatsapp");
    } catch {
      setError("Couldn't save that — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleWhatsAppNext() {
    const anyFilled = waToken.trim() || waPhoneId.trim() || waBusinessId.trim() || waNumber.trim();
    if (anyFilled) {
      setSaving(true);
      setError("");
      try {
        await Promise.all([
          saveCredential("whatsapp_access_token", waToken),
          saveCredential("whatsapp_phone_number_id", waPhoneId),
          saveCredential("whatsapp_business_account_id", waBusinessId),
          saveCredential("whatsapp_recipient_number", waNumber),
        ]);
      } catch {
        setError("Couldn't save that — check your connection and try again.");
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    setStep("done");
  }

  return (
    <div className="min-h-[calc(100vh-1px)] flex items-center justify-center px-4">
      <div className="w-full max-w-lg rounded-xl border border-black/10 dark:border-white/10 p-8 bg-white dark:bg-white/5">
        <StepIndicator step={step} />

        {step === "welcome" && (
          <div className="space-y-4">
            <h1 className="text-xl font-semibold">Welcome — let&apos;s get you set up</h1>
            <p className="text-sm text-black/60 dark:text-white/60">
              Two quick steps: connect your OwnerRez account, then (optionally) WhatsApp for guest messaging. Takes
              about 2 minutes. You can always change these later in Settings.
            </p>
            <button
              onClick={() => setStep("ownerrez")}
              className="w-full text-sm px-3 py-2 rounded-md bg-black text-white dark:bg-white dark:text-black"
            >
              Get started
            </button>
          </div>
        )}

        {step === "ownerrez" && (
          <div className="space-y-4">
            <div>
              <h1 className="text-lg font-semibold">Step 1 — Connect OwnerRez</h1>
              <p className="text-sm text-black/50 dark:text-white/50 mt-1">
                This is what lets us pull in your real bookings, guests, and revenue.
              </p>
            </div>

            <Field label="OwnerRez account email" value={orEmail} onChange={setOrEmail} />

            <Field label="Personal Access Token" value={orToken} onChange={setOrToken} type="password" />
            <HelpText>
              In OwnerRez, go to <strong>Settings → Developer / API Settings → Personal Access Tokens</strong> and
              create a new token. Paste it here.
            </HelpText>

            <Field
              label="Property name (as it appears in OwnerRez)"
              value={orPropertyName}
              onChange={setOrPropertyName}
            />
            <HelpText>Must match the property name shown on your OwnerRez dashboard — we&apos;ll find it for you.</HelpText>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <button
              onClick={handleOwnerRezNext}
              disabled={saving}
              className="w-full text-sm px-3 py-2 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
            >
              {saving ? "Saving…" : "Continue"}
            </button>
          </div>
        )}

        {step === "whatsapp" && (
          <div className="space-y-4">
            <div>
              <h1 className="text-lg font-semibold">Step 2 — Connect WhatsApp (optional)</h1>
              <p className="text-sm text-black/50 dark:text-white/50 mt-1">
                Lets the AI draft and send guest replies over WhatsApp for your approval. You can skip this and set
                it up later.
              </p>
            </div>

            <Field label="System User access token" value={waToken} onChange={setWaToken} type="password" />
            <Field label="Phone Number ID" value={waPhoneId} onChange={setWaPhoneId} />
            <Field label="Business Account ID" value={waBusinessId} onChange={setWaBusinessId} />
            <Field label="Your WhatsApp number (E.164, no +)" value={waNumber} onChange={setWaNumber} />
            <HelpText>
              Find all four in <strong>Meta for Developers → your app → WhatsApp → API Setup</strong>. First time
              setting this up?{" "}
              <Link href="/settings/ai-setup" className="underline" target="_blank">
                Full step-by-step guide
              </Link>
              .
            </HelpText>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <div className="flex gap-2">
              <button
                onClick={() => setStep("done")}
                className="flex-1 text-sm px-3 py-2 rounded-md border border-black/15 dark:border-white/20 text-black/60 dark:text-white/60"
              >
                Skip for now
              </button>
              <button
                onClick={handleWhatsAppNext}
                disabled={saving}
                className="flex-1 text-sm px-3 py-2 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
              >
                {saving ? "Saving…" : "Continue"}
              </button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="space-y-4 text-center">
            <h1 className="text-xl font-semibold">You&apos;re all set</h1>
            <p className="text-sm text-black/60 dark:text-white/60">
              Your account is ready. You can always add or update credentials later from Settings.
            </p>
            <button
              onClick={() => {
                router.push("/dashboard");
                router.refresh();
              }}
              className="w-full text-sm px-3 py-2 rounded-md bg-black text-white dark:bg-white dark:text-black"
            >
              Go to my dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const steps: Step[] = ["welcome", "ownerrez", "whatsapp", "done"];
  const idx = steps.indexOf(step);
  return (
    <div className="flex gap-1.5 mb-6">
      {steps.map((s, i) => (
        <div
          key={s}
          className={`h-1 flex-1 rounded-full ${
            i <= idx ? "bg-black dark:bg-white" : "bg-black/10 dark:bg-white/10"
          }`}
        />
      ))}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-black/60 dark:text-white/60 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
      />
    </div>
  );
}

function HelpText({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-black/40 dark:text-white/40 -mt-2">{children}</p>;
}
