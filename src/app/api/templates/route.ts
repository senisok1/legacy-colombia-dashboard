import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { listTemplates, saveTemplate } from "@/lib/store";
import type { MessageTemplate } from "@/lib/types";
import { getSessionFromRequest } from "@/lib/session";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  return NextResponse.json(await listTemplates(session?.organizationId));
}

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  const body = (await req.json().catch(() => ({}))) as Partial<MessageTemplate>;
  const now = new Date().toISOString();
  const template: MessageTemplate = {
    id: body.id || randomUUID(),
    name: body.name || "Untitled template",
    trigger: body.trigger || "manual",
    daysOffset: body.daysOffset ?? 0,
    subject: body.subject || "",
    bodyEn: body.bodyEn || "",
    bodyEs: body.bodyEs || "",
    active: body.active ?? true,
    createdAt: body.createdAt || now,
    updatedAt: now,
  };
  const saved = await saveTemplate(template, session?.organizationId);
  return NextResponse.json(saved);
}
