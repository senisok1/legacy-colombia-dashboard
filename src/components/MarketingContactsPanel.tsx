"use client";

import { useMemo, useState } from "react";
import type { MarketingContact, MarketingContactStats } from "@/lib/marketingContacts";
import { formatShortDate } from "@/lib/format";

// Raw external contact list (Mailchimp/Facebook-ads export, imported
// 2026-08-02 — see db/migrations/0010_marketing_contacts.sql). Read-only
// audience view: there is no "email this list" button here on purpose — no
// bulk-send integration exists yet, and any future one needs its own
// approval-gated build, not a quiet add to this panel.

const SOURCE_LABELS: Record<string, string> = {
  facebook_ads: "Facebook ads",
  mailchimp_import: "Mailchimp / other",
};

export function MarketingContactsPanel({
  initialContacts,
  initialStats,
}: {
  initialContacts: MarketingContact[];
  initialStats: MarketingContactStats;
}) {
  const [contacts] = useState<MarketingContact[]>(initialContacts);
  const [stats] = useState<MarketingContactStats>(initialStats);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        c.email.toLowerCase().includes(q) ||
        c.firstName?.toLowerCase().includes(q) ||
        c.lastName?.toLowerCase().includes(q)
    );
  }, [contacts, search]);

  const visible = expanded ? filtered : filtered.slice(0, 15);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold">Contacts</h2>
          <p className="text-xs text-black/40 dark:text-white/40">
            {stats.total} imported ({stats.bySource.map((s) => `${SOURCE_LABELS[s.source] ?? s.source}: ${s.count}`).join(", ")}) —
            audience list only, no send capability yet.
          </p>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or email…"
          className="text-xs rounded-md border border-black/10 dark:border-white/15 bg-white dark:bg-black/20 px-2.5 py-1.5 w-56"
        />
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-black/[0.03] dark:bg-white/[0.05] text-black/50 dark:text-white/50">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Name</th>
              <th className="text-left px-3 py-2 font-medium">Email</th>
              <th className="text-left px-3 py-2 font-medium">Phone</th>
              <th className="text-left px-3 py-2 font-medium">Source</th>
              <th className="text-left px-3 py-2 font-medium">Opted in</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.id} className="border-t border-black/5 dark:border-white/5">
                <td className="px-3 py-1.5">
                  {c.firstName || c.lastName ? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() : <span className="text-black/30 dark:text-white/30">—</span>}
                </td>
                <td className="px-3 py-1.5">{c.email}</td>
                <td className="px-3 py-1.5">{c.phone ?? <span className="text-black/30 dark:text-white/30">—</span>}</td>
                <td className="px-3 py-1.5">{SOURCE_LABELS[c.source] ?? c.source}</td>
                <td className="px-3 py-1.5">{c.subscribedAt ? formatShortDate(c.subscribedAt) : <span className="text-black/30 dark:text-white/30">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="text-center py-8 text-sm text-black/50 dark:text-white/50">No contacts match that search.</p>
        )}
      </div>

      {filtered.length > 15 && (
        <button onClick={() => setExpanded((v) => !v)} className="text-xs text-black/50 dark:text-white/50 hover:underline">
          {expanded ? "Show fewer" : `Show all ${filtered.length}`}
        </button>
      )}
    </div>
  );
}
