"use client";

import { useEffect, useState } from "react";
import type { MessageLogEntry, MessageTemplate } from "@/lib/types";
import { ThreadInbox } from "@/components/ThreadInbox";

type Tab = "inbox" | "templates" | "log";

export function MessagingCenter({
  initialTemplates = [],
  initialLog = [],
  messagingConfigured,
}: {
  initialTemplates?: MessageTemplate[];
  initialLog?: MessageLogEntry[];
  messagingConfigured: boolean;
}) {
  const [tab, setTab] = useState<Tab>("inbox");
  const [templates, setTemplates] = useState(initialTemplates);
  const [log, setLog] = useState(initialLog);

  // Instant-load fix (2026-08-16): the page no longer blocks its shell on
  // the templates/sent-log DB reads — they load here, after first paint.
  useEffect(() => {
    if (initialTemplates.length === 0) {
      fetch("/api/templates")
        .then((r) => (r.ok ? r.json() : []))
        .then((d) => Array.isArray(d) && setTemplates(d))
        .catch(() => {});
    }
    if (initialLog.length === 0) {
      fetch("/api/messages")
        .then((r) => (r.ok ? r.json() : []))
        .then((d) => Array.isArray(d) && setLog(d))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      {!messagingConfigured && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          Sending replies directly to OwnerRez isn&rsquo;t connected yet — ask Claude to finish the one-time
          OwnerRez messaging connection to enable real sending.
        </div>
      )}
      <div className="flex gap-1 border-b border-black/10 dark:border-white/10">
        {(
          [
            ["inbox", "Inbox"],
            ["templates", "Templates"],
            ["log", `Sent log (${log.length})`],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${
              tab === key
                ? "border-black dark:border-white font-medium"
                : "border-transparent text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "inbox" && <ThreadInbox messagingConfigured={messagingConfigured} />}
      {tab === "templates" && <TemplateManager templates={templates} setTemplates={setTemplates} />}
      {tab === "log" && <MessageLog log={log} />}
    </div>
  );
}

function TemplateManager({
  templates,
  setTemplates,
}: {
  templates: MessageTemplate[];
  setTemplates: (t: MessageTemplate[]) => void;
}) {
  async function update(id: string, changes: Partial<MessageTemplate>) {
    const res = await fetch(`/api/templates/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    const updated = (await res.json()) as MessageTemplate;
    setTemplates(templates.map((t) => (t.id === id ? updated : t)));
  }

  async function addTemplate() {
    const res = await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New template", trigger: "manual" }),
    });
    const created = (await res.json()) as MessageTemplate;
    setTemplates([...templates, created]);
  }

  async function remove(id: string) {
    await fetch(`/api/templates/${id}`, { method: "DELETE" });
    setTemplates(templates.filter((t) => t.id !== id));
  }

  return (
    <div className="space-y-4">
      {templates.map((t) => (
        <div key={t.id} className="rounded-lg border border-black/10 dark:border-white/10 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <input
              defaultValue={t.name}
              onBlur={(e) => update(t.id, { name: e.target.value })}
              className="font-medium text-sm bg-transparent border-b border-transparent focus:border-black/30 dark:focus:border-white/30 outline-none"
            />
            <select
              defaultValue={t.trigger}
              onChange={(e) => update(t.id, { trigger: e.target.value as MessageTemplate["trigger"] })}
              className="text-xs bg-transparent border border-black/10 dark:border-white/15 rounded px-1.5 py-1"
            >
              <option value="manual">Manual only</option>
              <option value="pre_arrival">Before arrival</option>
              <option value="check_in">On check-in day</option>
              <option value="post_stay_review">After checkout</option>
            </select>
            {t.trigger !== "manual" && (
              <label className="text-xs flex items-center gap-1">
                Days offset
                <input
                  type="number"
                  defaultValue={t.daysOffset}
                  onBlur={(e) => update(t.id, { daysOffset: Number(e.target.value) })}
                  className="w-14 bg-transparent border border-black/10 dark:border-white/15 rounded px-1 py-0.5"
                />
              </label>
            )}
            <label className="text-xs flex items-center gap-1 ml-auto">
              <input
                type="checkbox"
                defaultChecked={t.active}
                onChange={(e) => update(t.id, { active: e.target.checked })}
              />
              Active
            </label>
            <button onClick={() => remove(t.id)} className="text-xs text-red-600 dark:text-red-400 hover:underline">
              Delete
            </button>
          </div>
          <input
            defaultValue={t.subject}
            onBlur={(e) => update(t.id, { subject: e.target.value })}
            placeholder="Subject"
            className="w-full text-sm bg-transparent border-b border-black/10 dark:border-white/15 outline-none py-1"
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-black/50 dark:text-white/50">English</label>
              <textarea
                defaultValue={t.bodyEn}
                onBlur={(e) => update(t.id, { bodyEn: e.target.value })}
                rows={4}
                className="w-full text-sm bg-transparent border border-black/10 dark:border-white/15 rounded-md px-2 py-1.5 mt-1"
              />
            </div>
            <div>
              <label className="text-xs text-black/50 dark:text-white/50">Español</label>
              <textarea
                defaultValue={t.bodyEs}
                onBlur={(e) => update(t.id, { bodyEs: e.target.value })}
                rows={4}
                className="w-full text-sm bg-transparent border border-black/10 dark:border-white/15 rounded-md px-2 py-1.5 mt-1"
              />
            </div>
          </div>
          <p className="text-[11px] text-black/40 dark:text-white/40">
            Merge fields: {"{{guest_first_name}}"}, {"{{guest_name}}"}, {"{{arrival_date}}"}, {"{{departure_date}}"},{" "}
            {"{{property_name}}"}
          </p>
        </div>
      ))}
      <button onClick={addTemplate} className="text-sm px-3 py-1.5 rounded-md bg-black/5 dark:bg-white/10 hover:bg-black/10">
        + Add template
      </button>
    </div>
  );
}

function MessageLog({ log }: { log: MessageLogEntry[] }) {
  if (log.length === 0) {
    return <p className="text-sm text-black/50 dark:text-white/50 py-8 text-center">No messages logged yet.</p>;
  }
  return (
    <div className="space-y-2">
      {log.map((m) => (
        <div key={m.id} className="rounded-lg border border-black/10 dark:border-white/10 p-3 text-sm">
          <div className="flex justify-between text-xs text-black/50 dark:text-white/50 mb-1">
            <span>
              {m.guestName || "Guest"} · {m.templateName || "Manual"} · {m.language.toUpperCase()}
            </span>
            <span>{new Date(m.createdAt).toLocaleString()}</span>
          </div>
          <div className="whitespace-pre-wrap">{m.body}</div>
        </div>
      ))}
    </div>
  );
}
