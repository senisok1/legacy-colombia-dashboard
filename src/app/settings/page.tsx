"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Theme } from "@/lib/themes";

// Phase 2 onboarding/settings screen: lets a signed-in user store their own
// organization's OwnerRez/WhatsApp/PriceLabs credentials (encrypted — see
// lib/credentials.ts). Kept deliberately plain (no property lookup/test
// connection button yet) since, as of Phase 2, these values aren't wired
// into the live dashboard reads yet — that's Phase 3. This screen exists so
// a new org has somewhere to put their credentials as soon as they're
// allowed to sign up, without a rebuild once Phase 3 lands.
type Field = { key: string; label: string; placeholder?: string; type?: string };

const SECTIONS: { title: string; description?: string; fields: Field[] }[] = [
  {
    title: "OwnerRez",
    fields: [
      { key: "ownerrez_email", label: "Account email" },
      { key: "ownerrez_token", label: "Personal Access Token", type: "password" },
      { key: "ownerrez_property_name", label: "Property name (as it appears in OwnerRez)" },
      { key: "ownerrez_oauth_client_id", label: "OAuth Client ID (for messaging)" },
      { key: "ownerrez_oauth_client_secret", label: "OAuth Client Secret", type: "password" },
    ],
  },
  {
    title: "WhatsApp (Meta Cloud API)",
    fields: [
      { key: "whatsapp_access_token", label: "System User access token", type: "password" },
      { key: "whatsapp_phone_number_id", label: "Phone Number ID" },
      { key: "whatsapp_business_account_id", label: "Business Account ID" },
      { key: "whatsapp_recipient_number", label: "Your WhatsApp number (E.164, no +)" },
    ],
  },
  {
    title: "AI (Claude)",
    description:
      "Every AI feature — guest reply drafting, translation, review responses, rate recommendations, the website chat widget, and more — runs on this key. Leave it blank and you'll automatically use the shared platform key; add your own from console.anthropic.com to run AI features on your own Anthropic account and billing instead.",
    fields: [{ key: "anthropic_api_key", label: "Anthropic API key (starts with sk-ant-)", type: "password" }],
  },
  {
    title: "PriceLabs (optional)",
    fields: [
      { key: "pricelabs_api_key", label: "API key", type: "password" },
      { key: "pricelabs_listing_id", label: "Listing ID" },
    ],
  },
];

export default function SettingsPage() {
  const router = useRouter();
  const [storedKeys, setStoredKeys] = useState<Set<string>>(new Set());
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [themes, setThemes] = useState<Theme[]>([]);
  const [currentTheme, setCurrentTheme] = useState<string>("indigo");
  const [savingTheme, setSavingTheme] = useState<string | null>(null);
  const [currencies, setCurrencies] = useState<string[]>([]);
  const [currentCurrency, setCurrentCurrency] = useState<string | null>(null);
  const [savingCurrency, setSavingCurrency] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/settings/credentials");
    if (res.ok) {
      const data = (await res.json()) as { storedKeys: string[] };
      setStoredKeys(new Set(data.storedKeys));
    }
  }

  async function refreshTheme() {
    const res = await fetch("/api/settings/theme");
    if (res.ok) {
      const data = (await res.json()) as { themes: Theme[]; current: string };
      setThemes(data.themes);
      setCurrentTheme(data.current);
    }
  }

  async function refreshCurrency() {
    const res = await fetch("/api/settings/currency");
    if (res.ok) {
      const data = (await res.json()) as { currencies: string[]; current: string | null };
      setCurrencies(data.currencies);
      setCurrentCurrency(data.current);
    }
  }

  useEffect(() => {
    refresh();
    refreshTheme();
    refreshCurrency();
  }, []);

  // Saves the chosen color scheme, then router.refresh() so the root
  // layout (a Server Component that reads the org's theme straight from
  // the DB — see app/layout.tsx) re-renders with the new data-theme
  // attribute, without a full page reload.
  async function chooseTheme(themeId: string) {
    if (themeId === currentTheme || savingTheme) return;
    setSavingTheme(themeId);
    const res = await fetch("/api/settings/theme", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: themeId }),
    });
    setSavingTheme(null);
    if (res.ok) {
      setCurrentTheme(themeId);
      router.refresh();
    }
  }

  // Turns the USD/<currency> display toggle on (choosing a currency), or off
  // (passing null — "None"). Same router.refresh() pattern as chooseTheme:
  // the root layout reads the org's secondaryCurrency straight from the DB
  // to feed CurrencyProvider, so a full page reload isn't needed for the
  // NavBar toggle to appear/disappear immediately.
  async function chooseCurrency(currency: string | null) {
    if (currency === currentCurrency || savingCurrency) return;
    setSavingCurrency(currency ?? "none");
    const res = await fetch("/api/settings/currency", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currency }),
    });
    setSavingCurrency(null);
    if (res.ok) {
      setCurrentCurrency(currency);
      router.refresh();
    }
  }

  async function save(key: string) {
    const value = values[key];
    if (!value?.trim()) return;
    setSaving(key);
    setError("");
    const res = await fetch("/api/settings/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    setSaving(null);
    if (res.ok) {
      setValues((v) => ({ ...v, [key]: "" }));
      refresh();
    } else {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error || "Couldn't save that — try again.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8 space-y-8">
      <div>
        <h1 className="text-lg font-semibold">Connect your accounts</h1>
        <p className="text-sm text-black/50 dark:text-white/50 mt-1">
          Stored encrypted, scoped to your organization only.
        </p>
        <p className="text-sm mt-2">
          <Link href="/settings/ai-setup" className="text-[var(--accent)] hover:underline">
            Full step-by-step guide: connecting your own Claude key + WhatsApp for AI guest-reply approvals →
          </Link>
        </p>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-black/70 dark:text-white/70">Appearance</h2>
          <p className="text-xs text-black/50 dark:text-white/50 mt-0.5">
            Pick your dashboard&apos;s color scheme — only affects your organization.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {themes.map((theme) => {
            const active = theme.id === currentTheme;
            return (
              <button
                key={theme.id}
                onClick={() => chooseTheme(theme.id)}
                disabled={savingTheme !== null}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors disabled:opacity-50 ${
                  active
                    ? "border-[var(--accent)] bg-[var(--accent)]/10"
                    : "border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                <span
                  className="w-3.5 h-3.5 rounded-full border border-black/10 dark:border-white/20"
                  style={{ backgroundColor: theme.swatch }}
                  aria-hidden
                />
                {theme.label}
                {savingTheme === theme.id && <span className="text-xs text-black/40 dark:text-white/40">Saving…</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-black/70 dark:text-white/70">Currency</h2>
          <p className="text-xs text-black/50 dark:text-white/50 mt-0.5">
            Turn on a live USD/&lt;currency&gt; display toggle across your whole dashboard — a NavBar switch lets you
            view every dollar figure converted at a live exchange rate. Nothing stored ever changes; this only
            affects how amounts are displayed. Off by default.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => chooseCurrency(null)}
            disabled={savingCurrency !== null}
            className={`rounded-md border px-3 py-2 text-sm transition-colors disabled:opacity-50 ${
              currentCurrency === null
                ? "border-[var(--accent)] bg-[var(--accent)]/10"
                : "border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            None
            {savingCurrency === "none" && <span className="text-xs text-black/40 dark:text-white/40 ml-1">Saving…</span>}
          </button>
          {currencies.map((currency) => {
            const active = currency === currentCurrency;
            return (
              <button
                key={currency}
                onClick={() => chooseCurrency(currency)}
                disabled={savingCurrency !== null}
                className={`rounded-md border px-3 py-2 text-sm transition-colors disabled:opacity-50 ${
                  active
                    ? "border-[var(--accent)] bg-[var(--accent)]/10"
                    : "border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                USD / {currency}
                {savingCurrency === currency && <span className="text-xs text-black/40 dark:text-white/40 ml-1">Saving…</span>}
              </button>
            );
          })}
        </div>
      </div>

      {SECTIONS.map((section) => (
        <div key={section.title} className="space-y-3">
          <div>
            <h2 className="text-sm font-medium text-black/70 dark:text-white/70">{section.title}</h2>
            {section.description && (
              <p className="text-xs text-black/50 dark:text-white/50 mt-0.5">{section.description}</p>
            )}
          </div>
          <div className="space-y-2">
            {section.fields.map((field) => {
              const isStored = storedKeys.has(field.key);
              return (
                <div key={field.key} className="flex items-center gap-2">
                  <input
                    type={field.type || "text"}
                    value={values[field.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    placeholder={field.label}
                    className="flex-1 rounded-md border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
                  />
                  <button
                    onClick={() => save(field.key)}
                    disabled={saving === field.key || !values[field.key]?.trim()}
                    className="text-sm px-3 py-2 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40 whitespace-nowrap"
                  >
                    {saving === field.key ? "Saving…" : isStored ? "Update" : "Save"}
                  </button>
                  {isStored && <span className="text-xs text-green-600 dark:text-green-400 whitespace-nowrap">Connected</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
