import { query, queryOne } from "./db";
import { findUserByWhatsAppPhone, type AppUser } from "./users";

// Team Requests (2026-08-18, Seni's ask: "add an activity under the Team
// Activity Log tab like 'tour guide requested on August 25th, please accept
// or deny' — tag someone from the team to accept or deny it, notified by
// email/WhatsApp"). See db/migrations/0037_team_requests.sql. Lifecycle
// mirrors expense_requests: anyone logged in can raise one and tag exactly
// one teammate; that person accepts or declines — from the dashboard OR by
// replying YES/NO on WhatsApp (see lib/teamRequestNotify.ts + the webhook
// route's team-request branch); either side can mark it Completed afterward.

export type TeamRequest = {
  id: string;
  propertyGroupId: string | null;
  title: string;
  description: string | null;
  descriptionOriginal: string | null;
  authorLanguage: string | null;
  neededBy: string | null;
  requestedByEmail: string;
  requestedByName: string | null;
  requestedAt: string;
  taggedEmail: string;
  taggedName: string | null;
  notifyWamid: string | null;
  accepted: boolean;
  declined: boolean;
  decidedByEmail: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  declineReason: string | null;
  completed: boolean;
  completedByEmail: string | null;
  completedByName: string | null;
  completedAt: string | null;
};

type Row = {
  id: string;
  property_group_id: string | null;
  title: string;
  description: string | null;
  description_original: string | null;
  author_language: string | null;
  needed_by: string | null;
  requested_by_email: string;
  requested_by_name: string | null;
  requested_at: string | Date;
  tagged_email: string;
  tagged_name: string | null;
  notify_wamid: string | null;
  accepted: boolean;
  declined: boolean;
  decided_by_email: string | null;
  decided_by_name: string | null;
  decided_at: string | Date | null;
  decline_reason: string | null;
  completed: boolean;
  completed_by_email: string | null;
  completed_by_name: string | null;
  completed_at: string | Date | null;
};

const COLUMNS = `id, property_group_id, title, description, description_original, author_language,
  needed_by, requested_by_email, requested_by_name, requested_at,
  tagged_email, tagged_name, notify_wamid,
  accepted, declined, decided_by_email, decided_by_name, decided_at, decline_reason,
  completed, completed_by_email, completed_by_name, completed_at`;

function iso(v: string | Date | null): string | null {
  return v === null ? null : new Date(v).toISOString();
}

function fromRow(r: Row): TeamRequest {
  return {
    id: r.id,
    propertyGroupId: r.property_group_id,
    title: r.title,
    description: r.description,
    descriptionOriginal: r.description_original,
    authorLanguage: r.author_language,
    neededBy: r.needed_by,
    requestedByEmail: r.requested_by_email,
    requestedByName: r.requested_by_name,
    requestedAt: iso(r.requested_at)!,
    taggedEmail: r.tagged_email,
    taggedName: r.tagged_name,
    notifyWamid: r.notify_wamid,
    accepted: r.accepted,
    declined: r.declined,
    decidedByEmail: r.decided_by_email,
    decidedByName: r.decided_by_name,
    decidedAt: iso(r.decided_at),
    declineReason: r.decline_reason,
    completed: r.completed,
    completedByEmail: r.completed_by_email,
    completedByName: r.completed_by_name,
    completedAt: iso(r.completed_at),
  };
}

export async function listTeamRequests(
  organizationId: string,
  propertyGroupId?: string
): Promise<TeamRequest[]> {
  const rows = await query<Row>(
    `select ${COLUMNS} from team_requests
     where organization_id = $1
       and ($2::text is null or property_group_id is null or property_group_id = $2)
     order by requested_at desc
     limit 300`,
    [organizationId, propertyGroupId ?? null]
  );
  return rows.map(fromRow);
}

export async function createTeamRequest(input: {
  organizationId: string;
  propertyGroupId?: string | null;
  title: string;
  description?: string | null;
  descriptionOriginal?: string | null;
  authorLanguage?: string | null;
  neededBy?: string | null;
  requestedByEmail: string;
  requestedByName?: string | null;
  taggedEmail: string;
  taggedName?: string | null;
}): Promise<TeamRequest> {
  const row = await queryOne<Row>(
    `insert into team_requests
       (organization_id, property_group_id, title, description, description_original, author_language,
        needed_by, requested_by_email, requested_by_name, tagged_email, tagged_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning ${COLUMNS}`,
    [
      input.organizationId,
      input.propertyGroupId ?? null,
      input.title.trim(),
      input.description?.trim() || null,
      input.descriptionOriginal?.trim() || null,
      input.authorLanguage ?? null,
      input.neededBy || null,
      input.requestedByEmail,
      input.requestedByName ?? null,
      input.taggedEmail.toLowerCase(),
      input.taggedName ?? null,
    ]
  );
  if (!row) throw new Error("Failed to save the request.");
  return fromRow(row);
}

export async function getTeamRequest(id: string, organizationId: string): Promise<TeamRequest | null> {
  const row = await queryOne<Row>(
    `select ${COLUMNS} from team_requests where id = $1 and organization_id = $2`,
    [id, organizationId]
  );
  return row ? fromRow(row) : null;
}

/** Oldest still-open request tagged to this email, within one org — the
 * WhatsApp-reply fallback when there's no context wamid to resolve against
 * (same "oldest pending" convention as pendingDrafts.getOldestPendingDraft). */
export async function getOldestPendingTeamRequestForTaggedEmail(
  organizationId: string,
  taggedEmail: string
): Promise<TeamRequest | null> {
  const row = await queryOne<Row>(
    `select ${COLUMNS} from team_requests
     where organization_id = $1 and lower(tagged_email) = lower($2) and accepted = false and declined = false
     order by requested_at asc
     limit 1`,
    [organizationId, taggedEmail]
  );
  return row ? fromRow(row) : null;
}

export async function getTeamRequestByWamid(
  organizationId: string,
  wamid: string
): Promise<TeamRequest | null> {
  const row = await queryOne<Row>(
    `select ${COLUMNS} from team_requests where organization_id = $1 and notify_wamid = $2`,
    [organizationId, wamid]
  );
  return row ? fromRow(row) : null;
}

/** Stamps the wamid of the "please accept or deny" WhatsApp message once the
 * send succeeds, so a swipe-to-reply resolves to exactly this request (same
 * pattern as pendingDrafts.linkWhatsAppMessageId). */
export async function linkNotifyWamid(id: string, organizationId: string, wamid: string): Promise<void> {
  await query(`update team_requests set notify_wamid = $3 where id = $1 and organization_id = $2`, [
    id,
    organizationId,
    wamid,
  ]);
}

/** Edits a request's own details — restricted at the route layer (see
 * api/team-requests/edit/route.ts) to the ORIGINAL REQUESTER only, no CEO
 * override (2026-08-18, Seni's explicit ask: "only that person should be
 * able to edit that request"). Re-tagging is allowed here; the route decides
 * whether to re-notify the newly tagged person. */
export async function updateTeamRequest(input: {
  organizationId: string;
  id: string;
  title: string;
  description?: string | null;
  descriptionOriginal?: string | null;
  authorLanguage?: string | null;
  neededBy?: string | null;
  taggedEmail: string;
  taggedName?: string | null;
}): Promise<TeamRequest | null> {
  const row = await queryOne<Row>(
    `update team_requests set
       title = $3,
       description = $4,
       description_original = $5,
       author_language = $6,
       needed_by = $7,
       tagged_email = $8,
       tagged_name = $9
     where id = $2 and organization_id = $1
     returning ${COLUMNS}`,
    [
      input.organizationId,
      input.id,
      input.title.trim(),
      input.description?.trim() || null,
      input.descriptionOriginal?.trim() || null,
      input.authorLanguage ?? null,
      input.neededBy || null,
      input.taggedEmail.toLowerCase(),
      input.taggedName ?? null,
    ]
  );
  return row ? fromRow(row) : null;
}

/** Accept/decline — restricted at the route layer to the TAGGED person (by
 * email) only, not by role (2026-08-18: the CEO override was deliberately
 * removed — see api/team-requests/route.ts's PATCH). */
export async function setDecision(input: {
  organizationId: string;
  id: string;
  accepted: boolean;
  declined?: boolean;
  declineReason?: string | null;
  byEmail: string;
  byName?: string | null;
}): Promise<TeamRequest | null> {
  const row = await queryOne<Row>(
    `update team_requests set
       accepted = $3,
       declined = $4,
       decline_reason = $5::text,
       decided_by_email = case when $3 or $4 then $6::text else null end,
       decided_by_name  = case when $3 or $4 then $7::text else null end,
       decided_at        = case when $3 or $4 then now() else null end
     where id = $2 and organization_id = $1
     returning ${COLUMNS}`,
    [
      input.organizationId,
      input.id,
      input.accepted,
      input.declined ?? false,
      input.declineReason ?? null,
      input.byEmail,
      input.byName ?? null,
    ]
  );
  return row ? fromRow(row) : null;
}

export async function setCompleted(input: {
  organizationId: string;
  id: string;
  completed: boolean;
  byEmail: string;
  byName?: string | null;
}): Promise<TeamRequest | null> {
  const row = await queryOne<Row>(
    `update team_requests set
       completed = $3,
       completed_by_email = case when $3 then $4::text else null end,
       completed_by_name  = case when $3 then $5::text else null end,
       completed_at       = case when $3 then now() else null end
     where id = $2 and organization_id = $1
     returning ${COLUMNS}`,
    [input.organizationId, input.id, input.completed, input.byEmail, input.byName ?? null]
  );
  return row ? fromRow(row) : null;
}

/**
 * Resolves an inbound WhatsApp message to "this sender is a team member with
 * a pending request awaiting their own decision" (2026-08-18, Seni's ask:
 * accept/deny should work by WhatsApp reply, not just the dashboard). Mirrors
 * the guest-approval webhook's resolvePendingApproval: a swipe-to-reply
 * (contextWamid) targets that exact request; a plain reply with no context
 * falls back to the sender's own oldest pending item. A contextWamid that
 * resolves to a DIFFERENT person's request, or one already decided, is
 * treated as "nothing to do" rather than guessing — same refusal-to-guess
 * policy as the guest flow (see that file's 2026-08-17 audit comment).
 */
export async function resolveTeamRequestForPhone(
  organizationId: string,
  phone: string,
  contextWamid?: string
): Promise<{ user: AppUser; request: TeamRequest } | null> {
  const user = await findUserByWhatsAppPhone(organizationId, phone);
  if (!user) return null;

  if (contextWamid) {
    const request = await getTeamRequestByWamid(organizationId, contextWamid);
    if (!request) return null; // an unresolved quote is "gone," not "guess something else"
    const isTheirs =
      request.taggedEmail.toLowerCase() === user.email.toLowerCase() && !request.accepted && !request.declined;
    return isTheirs ? { user, request } : null;
  }

  const request = await getOldestPendingTeamRequestForTaggedEmail(organizationId, user.email);
  return request ? { user, request } : null;
}

export async function deleteTeamRequest(organizationId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from team_requests where id = $1 and organization_id = $2 returning id`,
    [id, organizationId]
  );
  return rows.length > 0;
}

// ---- Notes (migration 0038, 2026-08-18): a threaded back-and-forth per
// request, separate from the accept/deny decision itself — "each team
// member can put in their notes back and forth," timestamped and
// attributed. Same language handling as the request's own description:
// non-English authors get translated to English for storage, with the
// original kept alongside for same-language readers. ----

export type TeamRequestNote = {
  id: string;
  requestId: string;
  authorEmail: string;
  authorName: string | null;
  body: string;
  bodyOriginal: string | null;
  authorLanguage: string | null;
  createdAt: string;
};

type NoteRow = {
  id: string;
  request_id: string;
  author_email: string;
  author_name: string | null;
  body: string;
  body_original: string | null;
  author_language: string | null;
  created_at: string | Date;
};

function fromNoteRow(r: NoteRow): TeamRequestNote {
  return {
    id: r.id,
    requestId: r.request_id,
    authorEmail: r.author_email,
    authorName: r.author_name,
    body: r.body,
    bodyOriginal: r.body_original,
    authorLanguage: r.author_language,
    createdAt: iso(r.created_at)!,
  };
}

/** Every note for a batch of requests in one query, oldest first within
 * each thread — the GET route uses this to attach `notes` to each request
 * card without an N+1 query per request. */
export async function listNotesForRequests(
  organizationId: string,
  requestIds: string[]
): Promise<Map<string, TeamRequestNote[]>> {
  const byRequest = new Map<string, TeamRequestNote[]>();
  if (requestIds.length === 0) return byRequest;
  const rows = await query<NoteRow>(
    `select id, request_id, author_email, author_name, body, body_original, author_language, created_at
     from team_request_notes
     where organization_id = $1 and request_id = any($2::uuid[])
     order by created_at asc`,
    [organizationId, requestIds]
  );
  for (const row of rows) {
    const note = fromNoteRow(row);
    const list = byRequest.get(note.requestId);
    if (list) list.push(note);
    else byRequest.set(note.requestId, [note]);
  }
  return byRequest;
}

export async function addTeamRequestNote(input: {
  organizationId: string;
  requestId: string;
  authorEmail: string;
  authorName?: string | null;
  body: string;
  bodyOriginal?: string | null;
  authorLanguage?: string | null;
}): Promise<TeamRequestNote> {
  const row = await queryOne<NoteRow>(
    `insert into team_request_notes
       (request_id, organization_id, author_email, author_name, body, body_original, author_language)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id, request_id, author_email, author_name, body, body_original, author_language, created_at`,
    [
      input.requestId,
      input.organizationId,
      input.authorEmail,
      input.authorName ?? null,
      input.body.trim(),
      input.bodyOriginal?.trim() || null,
      input.authorLanguage ?? null,
    ]
  );
  if (!row) throw new Error("Failed to save the note.");
  return fromNoteRow(row);
}
