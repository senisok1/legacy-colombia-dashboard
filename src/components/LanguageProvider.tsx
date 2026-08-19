"use client";

import { createContext, useContext, useMemo } from "react";
import { t as translate, type Lang } from "@/lib/i18n";

// CRM UI localization (2026-08-19, Seni's ask — see lib/i18n.ts's header
// comment for the full story). `language` comes from the signed-in user's
// row (Settings → Add a Team Member), resolved server-side once in
// app/layout.tsx and passed down here — same wiring pattern as
// CurrencyProvider's secondaryCurrency. No client fetch needed: the value is
// fixed for the whole session (changing it requires an admin editing the
// login, then that person's next page load picks it up).

type LanguageContextValue = {
  language: string;
  /** Looks up a static UI string by key in the signed-in user's language. */
  t: (key: string) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ language, children }: { language?: string | null; children: React.ReactNode }) {
  const value = useMemo<LanguageContextValue>(() => {
    const lang: Lang = language === "Spanish" || language === "Portuguese" ? language : "English";
    return { language: lang, t: (key: string) => translate(key, lang) };
  }, [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useT() {
  const ctx = useContext(LanguageContext);
  // Defensive fallback (same philosophy as useCurrency): a component
  // rendered outside the provider still shows English instead of crashing.
  if (!ctx) return (key: string) => translate(key, "English");
  return ctx.t;
}

export function useLanguage(): string {
  const ctx = useContext(LanguageContext);
  return ctx?.language ?? "English";
}
