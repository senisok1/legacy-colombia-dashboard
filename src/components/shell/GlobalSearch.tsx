"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/components/LanguageProvider";
import { IconSearch } from "./NavIcons";

// Global search (2026-08-22). Opens from the header icon or ⌘K / Ctrl-K,
// searches guests, stays and pages, and navigates on Enter or click.
//
// Read-only by construction: it renders links from /api/search and routes
// to them. Results are already role- and property-scoped server-side (see
// that route), so this component never has to reason about permissions.

type Result = { type: "guest" | "stay" | "page"; title: string; subtitle: string; href: string };

const TYPE_LABEL: Record<Result["type"], string> = { page: "Page", guest: "Guest", stay: "Stay" };

export function GlobalSearch() {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ⌘K / Ctrl-K to open, Esc to close — the shortcut people already expect.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Debounced so typing a name doesn't fire a request per keystroke.
  //
  // Note the effect never calls setState synchronously — for queries under
  // two characters it simply does nothing, and the "no results yet" state is
  // DERIVED during render (see `shown` below) rather than written back into
  // state. Clearing it here instead would be a cascading render, which this
  // repo's eslint config treats as an error.
  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (query.length < 2) return;
    let cancelled = false;
    const id = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = (await res.json()) as { results?: Result[] };
        if (!cancelled) {
          setResults(data.results ?? []);
          setActive(0);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [q, open]);

  // Derived, not stored: results only count while the query is long enough.
  const tooShort = q.trim().length < 2;
  const shown = tooShort ? [] : results;

  function go(r: Result) {
    setOpen(false);
    setQ("");
    router.push(r.href);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={`${t("nav.search")} (⌘K)`}
        className="rounded-lg p-2 text-black/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/10"
      >
        <IconSearch className="w-[18px] h-[18px]" />
        <span className="sr-only">{t("nav.search")}</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
          <button
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <div
            className="relative w-full max-w-xl overflow-hidden rounded-2xl border shadow-2xl"
            style={{
              borderColor: "var(--border-subtle, rgba(255,255,255,0.12))",
              background: "var(--surface, #171C22)",
            }}
          >
            <div
              className="flex items-center gap-2.5 px-4 py-3 border-b"
              style={{ borderColor: "var(--border-subtle, rgba(255,255,255,0.1))" }}
            >
              <IconSearch className="w-[18px] h-[18px] shrink-0 opacity-50" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((i) => Math.min(i + 1, shown.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter" && shown[active]) {
                    e.preventDefault();
                    go(shown[active]);
                  }
                }}
                placeholder={t("search.placeholder")}
                className="w-full bg-transparent text-sm outline-none placeholder:text-black/40 dark:placeholder:text-white/40"
              />
              <kbd className="hidden sm:block shrink-0 rounded border border-white/15 px-1.5 py-0.5 text-[10px] opacity-50">
                esc
              </kbd>
            </div>

            <div className="max-h-[52vh] overflow-y-auto py-1">
              {tooShort ? (
                <p className="px-4 py-6 text-center text-xs text-black/40 dark:text-white/40">
                  {t("search.hint")}
                </p>
              ) : loading && shown.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-black/40 dark:text-white/40">
                  {t("search.searching")}
                </p>
              ) : shown.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-black/40 dark:text-white/40">
                  {t("search.noResults")}
                </p>
              ) : (
                <ul>
                  {shown.map((r, i) => (
                    <li key={`${r.type}-${r.href}-${i}`}>
                      <button
                        onClick={() => go(r)}
                        onMouseEnter={() => setActive(i)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left ${
                          i === active ? "bg-[var(--accent)]/12" : ""
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{r.title}</span>
                          <span className="block truncate text-[11px] text-black/50 dark:text-white/50">
                            {r.subtitle}
                          </span>
                        </span>
                        <span className="shrink-0 rounded-full bg-black/10 dark:bg-white/10 px-2 py-0.5 text-[10px] text-black/60 dark:text-white/60">
                          {TYPE_LABEL[r.type]}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
