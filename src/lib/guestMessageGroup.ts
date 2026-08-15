import type { ThreadMessage } from "./types";

// Guests sometimes send several separate WhatsApp/OwnerRez messages
// back-to-back instead of one long one — e.g. "I finished the access info"
// / "can you send the complete address" / "Thank you" as three separate
// sends a few seconds apart. Treating only the very last one as "the" new
// guest message (as both the cron poller and the Inbox's on-demand drafter
// used to) silently drops the earlier ones from both the AI's drafting
// context and the WhatsApp approval text Seni reviews — he'd only ever see
// "Thank you" and have no idea a request for the address came right before
// it. (Reported by Seni 2026-07-30 re: guest Christopher Menendez.)
//
// Fix: walk backward from the end of a chronologically-ordered message
// list and collect the trailing run of consecutive guest messages, stopping
// as soon as a host message is hit. A host message in between means Seni
// (or this system) already addressed everything before it, so only the
// guest messages after that reply are genuinely new/unanswered.

export function trailingGuestMessages(messages: ThreadMessage[]): ThreadMessage[] {
  const trailing: ThreadMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.isGuest) break;
    trailing.unshift(m);
  }
  return trailing;
}

/** Joins a guest's consecutive messages into one block, in the order they
 * were sent, for use as a single "guestMessage" string everywhere downstream
 * (AI drafting context, PendingDraft.guestMessage, the WhatsApp approval
 * text) already expects one. */
export function combineGuestMessageBodies(messages: ThreadMessage[]): string {
  return messages
    .map((m) => m.body.trim())
    .filter(Boolean)
    .join("\n");
}
