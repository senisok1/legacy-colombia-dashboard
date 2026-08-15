import { NextRequest, NextResponse } from "next/server";
import { appendMessage, listMessages } from "@/lib/store";
import type { MessageLogEntry } from "@/lib/types";
import { getSessionFromRequest } from "@/lib/session";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  return NextResponse.json(await listMessages(session?.organizationId));
}

// Logs a message as sent/drafted. Actually delivering it through OwnerRez
// requires Messaging API access (a signed agreement with OwnerRez — email
// help@ownerrez.com with subject "Messaging API Access"). Until that's in
// place, this records the message here so you have a ready-to-copy draft
// and a full history, and you send it manually from OwnerRez's own message
// center or the guest's booking source (Airbnb/Vrbo inbox).
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  const body = (await req.json().catch(() => ({}))) as Omit<MessageLogEntry, "id" | "createdAt">;
  const entry = await appendMessage(body, session?.organizationId);
  return NextResponse.json(entry);
}
