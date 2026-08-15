import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { updateContentFields, updateContentStatus } from "@/lib/contentMarketing";
import { isChannelPushable, pushPieceToPostiz } from "@/lib/postiz";
import { getSessionFromRequest } from "@/lib/session";
import type { ContentPieceStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VALID_STATUSES: ContentPieceStatus[] = ["idea", "draft", "approved", "published_externally", "archived"];

// Same two-independent-edits pattern as /api/bills/[id] and /api/leads/[id]:
//   { status: "..." }        -> updateContentStatus
//   { fields: { ... } }      -> updateContentFields (topic/channel/keyword/body/meta)
//
// Social Media Manager addition (2026-08-07): moving a piece to "approved"
// on a channel Seni has connected in Postiz (isChannelPushable) also pushes
// it there as a real draft — see lib/postiz.ts. This is the literal "so all
// I have to do is approve or edit" flow Seni asked for. If the push fails
// (Postiz not configured yet, network error, etc.) the status change still
// succeeds — we surface postizError on the response instead of blocking the
// approval, since Seni approving in the CRM shouldn't be undone by a
// downstream integration hiccup.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || (!body.status && !body.fields)) {
    return NextResponse.json({ error: "Provide a status and/or fields to update." }, { status: 400 });
  }
  if (body.status && !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
  }

  if (body.fields) {
    const fieldsResult = await updateContentFields(id, body.fields, session?.organizationId);
    if (!fieldsResult) return NextResponse.json({ error: "Content piece not found." }, { status: 404 });
    if (!body.status) return NextResponse.json({ piece: fieldsResult });
  }

  let piece = await updateContentStatus(id, body.status, session?.organizationId);
  if (!piece) return NextResponse.json({ error: "Content piece not found." }, { status: 404 });

  let postizError: string | undefined;
  if (body.status === "approved" && isChannelPushable(piece.channel)) {
    try {
      piece = await pushPieceToPostiz(piece, session?.organizationId);
    } catch (err) {
      postizError = err instanceof Error ? err.message : "Failed to push to Postiz.";
    }
  }

  return NextResponse.json(postizError ? { piece, postizError } : { piece });
}
