import { config, isAiReplyConfigured } from "./config";
import { resolveAnthropicApiKey } from "./credentials";
import { PROPERTY_FACTS } from "./propertyFacts";
import type { Booking, ThreadMessage } from "./types";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_STYLE_EXAMPLES = 12;

export class AiReplyError extends Error {}

function buildSystemPrompt(styleExamples: string[]): string {
  return `You are drafting a WhatsApp-relayed reply on behalf of Seni, the host of a short-term rental property, to one of his guests. The draft you write will be shown to Seni for approval before anything is sent — you are never sending this directly to the guest yourself.

Write in Seni's voice. Below are real examples of messages Seni has previously sent to guests in this same OwnerRez inbox — match their tone, warmth, length, and level of formality as closely as you can. Do not copy them verbatim; use them only to calibrate style.

--- Seni's past messages (style reference only) ---
${styleExamples.length > 0 ? styleExamples.map((m, i) => `${i + 1}. ${m}`).join("\n") : "(no past host messages found yet — default to a warm, concise, professional tone)"}
--- end style reference ---

Here are the only verified facts about the property you may state as fact. If the guest asks something not covered here (exact prices, availability, policies, codes), say you'll confirm/follow up rather than guessing:

--- Property facts ---
${PROPERTY_FACTS}
--- end property facts ---

Rules:
- Reply only with the message body text — no preamble, no "Here's a draft:", no quotation marks around it, no signature block unless Seni's past messages consistently used one.
- Keep it about as long as Seni's typical replies above (don't write a long essay if his are short).
- Never invent check-in/check-out times, deposit/cleaning-fee amounts, door codes, wifi passwords, or availability — if asked, say you'll confirm and get back to them.
- The exact property address is a known fact (see property facts below) but is gated by a strict host policy: only include it in the reply if the guest's arrival date (given in the booking context, compared against today's date, also given in the booking context) is today or earlier. If their arrival is still in the future, do not share the address even if asked directly — say the exact address and arrival instructions go out on the day of check-in.
- If the guest message contains something urgent/sensitive (a safety issue, a complaint, a refund request), keep the draft short and acknowledge it warmly rather than trying to resolve it in text.
- Service requests (private chef, massage, jet ski, pontoon/boat rental, cold plunge, transportation, or similar paid add-on experiences): quote the specific price from the property facts above if one applies, weaving in that service's bit of color naturally (e.g. the jet skis being top-of-the-line and delivered right to the dock, or the chef/massage therapists being the best in the area) rather than just stating a bare number — sell it a little, don't undersell it. Then be assumptive, not conditional: never say "if you're interested" — say Seni is going ahead and connecting them with Gabriel, the on-site property manager, over WhatsApp right now so he can coordinate everything and make sure it's ready for their stay. Set "is_service_request" to true for these. Set it to false for everything else (general questions, check-in logistics, complaints, small talk, etc.) — don't set it to true just because a message mentions the property or activities in passing.
- Language: detect the language the guest wrote their message in, and write your reply in that same language, the way a fluent native speaker would — don't reply in English to a non-English message. Seni himself only reads English, so you must ALSO provide plain English translations of both the guest's original message and your reply, purely so he can review them before approving — these translations are never sent anywhere, only the native-language reply is. IMPORTANT exception to save space: if the guest already wrote in English, set "guest_message_english" and "reply_english" to empty strings "" instead of repeating the same text a second time — the app already falls back to the original text in that case. Only fill those two fields in when a real translation is needed.
- Keep your JSON response compact enough to never get cut off. A guest asking about several things at once (e.g. jet skis + meals + boat + pool) still gets ONE reply covering all of them — don't pad it out with extra flourish per item; sell each service briefly, then move on.

Respond with ONLY a single JSON object (no markdown code fences, no other text before or after it), with exactly these five keys:
{
  "language": "the name of the language the guest wrote in, e.g. Spanish, Portuguese, English",
  "reply": "your drafted reply, written in that same language",
  "guest_message_english": "an English translation of the guest's message, or \\"\\" if the guest already wrote in English",
  "reply_english": "an English translation of your drafted reply, or \\"\\" if \\"reply\\" is already in English",
  "is_service_request": true or false — whether this message is a guest asking about a paid add-on experience (chef, massage, jet ski, boat/pontoon rental, cold plunge, transportation, etc.)
}`;
}

export interface DraftedReply {
  /** The reply itself, in the guest's own language — this is what actually
   * gets sent to the guest via OwnerRez once Seni approves it. */
  reply: string;
  /** Human-readable name of the language the guest wrote in (and the reply
   * is drafted in), e.g. "Spanish". Shown to Seni so he knows what's being
   * sent even though he can't read it directly. */
  language: string;
  /** English translation of the guest's message — for Seni's WhatsApp
   * approval view only, since he only reads English. */
  guestMessageEnglish: string;
  /** English translation of `reply` — for Seni's WhatsApp approval view
   * only. Never sent to the guest; the guest gets `reply` instead. */
  replyEnglish: string;
  /** True when the guest is asking about a paid add-on experience (chef,
   * massage, jet ski, boat rental, cold plunge, transportation, etc.) —
   * used to surface the guest's phone number to Seni and to trigger the
   * Gabriel auto-notify flow once Seni approves the reply. */
  isServiceRequest: boolean;
}

/**
 * Drafts a reply to an inbound guest message using Claude, grounded in (a)
 * Seni's own past host-authored messages in this thread's booking history
 * (style reference) and (b) the static property facts file (factual
 * reference). Throws AiReplyError if ANTHROPIC_API_KEY isn't set/funded or
 * the API call fails — callers should catch this and skip drafting for that
 * message rather than crash the whole cron run.
 */
export async function draftGuestReply(params: {
  guestMessage: string;
  booking: Booking;
  hostMessages: ThreadMessage[]; // past host-authored messages, any thread, for style
  organizationId?: string; // "bring your own Claude key" (2026-08-05) — see resolveAnthropicApiKey
}): Promise<DraftedReply> {
  if (!isAiReplyConfigured()) {
    throw new AiReplyError(
      "ANTHROPIC_API_KEY isn't set (or has no credits) — can't draft AI replies yet."
    );
  }
  const apiKey = await resolveAnthropicApiKey(params.organizationId);

  const styleExamples = params.hostMessages
    .map((m) => m.body.trim())
    .filter(Boolean)
    .slice(-MAX_STYLE_EXAMPLES);

  const userPrompt = `Booking context:
- Today's date: ${new Date().toISOString().slice(0, 10)}
- Property: ${params.booking.propertyName ?? "Legacy Colombia"}
- Guest name: ${params.booking.guestName ?? "the guest"}
- Arrival: ${params.booking.arrival || "unknown"}
- Departure: ${params.booking.departure || "unknown"}
- Booking source: ${params.booking.source}
- Booking status: ${params.booking.status}

The guest just sent this message:
"""
${params.guestMessage}
"""

Draft Seni's reply.`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      // Bumped from 800 -> 2000 on 2026-08-01: a guest asking about several
      // services at once (jet skis + breakfast menu + boat + plunge pool,
      // real case from Nyree Tanielian) produced a reply long enough that
      // 800 tokens cut the JSON off mid-string. JSON.parse then threw, and
      // the old fallback dumped the raw truncated JSON blob to Seni's
      // WhatsApp as if it were the actual reply text — see
      // parseDraftedReply's salvage logic below for the second layer of
      // defense against this.
      max_tokens: 2000,
      system: buildSystemPrompt(styleExamples),
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AiReplyError(`Anthropic API returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  const text = data.content?.find((c) => c.type === "text")?.text?.trim();
  if (!text) throw new AiReplyError("Anthropic API returned no draft text.");

  return parseDraftedReply(text, params.guestMessage);
}

/** Regex-salvages one string field's value out of a possibly-truncated JSON
 * blob (used when JSON.parse itself fails — see parseDraftedReply below).
 * Only succeeds if THIS field's value is fully closed with its closing
 * quote; a field cut off mid-string (typically the last field, if
 * max_tokens ran out) correctly returns null rather than a mangled value. */
function salvageJsonStringField(text: string, field: string): string | null {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
  const match = text.match(re);
  if (!match) return null;
  try {
    // Reuse JSON's own escape handling rather than hand-rolling it.
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

/**
 * Parses the model's JSON-shaped response into a DraftedReply. Claude
 * reliably follows the "JSON only" instruction, but a long multi-item
 * service request can occasionally still run past max_tokens and get cut
 * off mid-JSON (see the max_tokens comment above draftGuestReply's fetch
 * call — this happened for real on 2026-08-01 with a 4-item jet
 * ski/breakfast/boat/pool request). When JSON.parse fails outright, try to
 * salvage at least the "reply" field via regex (it's usually intact even
 * when a later field got truncated, since keys appear in a stable order) —
 * this is only ever a partial reply if it itself contains no service items
 * cut off mid-sentence, so callers should treat a salvaged result as
 * lower-confidence. If even that fails, throw rather than ever returning
 * the raw JSON text as if it were a real reply — a broken JSON blob must
 * never be forwarded to Seni's WhatsApp or, worse, sent to a guest.
 */
function parseDraftedReply(rawText: string, guestMessage: string): DraftedReply {
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    if (!reply) throw new Error("missing reply field");

    return {
      reply,
      language: typeof parsed.language === "string" && parsed.language.trim() ? parsed.language.trim() : "English",
      guestMessageEnglish:
        typeof parsed.guest_message_english === "string" && parsed.guest_message_english.trim()
          ? parsed.guest_message_english.trim()
          : guestMessage,
      replyEnglish:
        typeof parsed.reply_english === "string" && parsed.reply_english.trim()
          ? parsed.reply_english.trim()
          : reply,
      isServiceRequest: parsed.is_service_request === true,
    };
  } catch {
    const salvagedReply = salvageJsonStringField(cleaned, "reply");
    if (salvagedReply && salvagedReply.trim()) {
      const salvagedLanguage = salvageJsonStringField(cleaned, "language");
      const salvagedGuestEnglish = salvageJsonStringField(cleaned, "guest_message_english");
      const salvagedReplyEnglish = salvageJsonStringField(cleaned, "reply_english");
      return {
        reply: salvagedReply.trim(),
        language: salvagedLanguage?.trim() || "English",
        guestMessageEnglish: salvagedGuestEnglish?.trim() || guestMessage,
        replyEnglish: salvagedReplyEnglish?.trim() || salvagedReply.trim(),
        isServiceRequest: /"is_service_request"\s*:\s*true/.test(cleaned),
      };
    }

    // Nothing usable could be salvaged — refuse to hand back raw JSON as a
    // "reply". Throwing means the caller logs this as a failed draft
    // (visible in AI Activity) and skips it rather than silently sending
    // garbage; Seni can still reply manually, same as he already does today
    // when he notices something looks wrong.
    throw new AiReplyError(
      "Couldn't parse Claude's drafted reply as JSON, and couldn't salvage a usable reply field either — the response was likely truncated (hit max_tokens)."
    );
  }
}
