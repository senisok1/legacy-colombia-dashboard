"use client";

import { useState, useTransition } from "react";

export function GuestNotesEditor({
  guestId,
  initialNotes,
  initialTags,
}: {
  guestId: number;
  initialNotes: string;
  initialTags: string[];
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [tagInput, setTagInput] = useState(initialTags.join(", "));
  const [saved, setSaved] = useState(true);
  const [isPending, startTransition] = useTransition();

  function save() {
    const tags = tagInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    startTransition(async () => {
      await fetch(`/api/guests/${guestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes, tags }),
      });
      setSaved(true);
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs font-medium text-black/50 dark:text-white/50">Tags (comma-separated)</label>
        <input
          value={tagInput}
          onChange={(e) => {
            setTagInput(e.target.value);
            setSaved(false);
          }}
          placeholder="e.g. VIP, pet owner, long-term interest"
          className="mt-1 w-full rounded-md border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
        />
      </div>
      <div>
        <label className="text-xs font-medium text-black/50 dark:text-white/50">Private notes</label>
        <textarea
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            setSaved(false);
          }}
          rows={4}
          placeholder="Anything worth remembering about this guest…"
          className="mt-1 w-full rounded-md border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/30 dark:focus:border-white/30"
        />
      </div>
      <button
        onClick={save}
        disabled={isPending || saved}
        className="text-sm px-3 py-1.5 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
      >
        {isPending ? "Saving…" : saved ? "Saved" : "Save"}
      </button>
    </div>
  );
}
