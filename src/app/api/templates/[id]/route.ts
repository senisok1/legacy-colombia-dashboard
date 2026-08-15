import { NextRequest, NextResponse } from "next/server";
import { deleteTemplate, listTemplates, saveTemplate } from "@/lib/store";
import type { MessageTemplate } from "@/lib/types";
import { getSessionFromRequest } from "@/lib/session";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = getSessionFromRequest(req);
  const { id } = await params;
  const templates = await listTemplates(session?.organizationId);
  const existing = templates.find((t) => t.id === id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Partial<MessageTemplate>;
  const updated = await saveTemplate({ ...existing, ...body, id }, session?.organizationId);
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = getSessionFromRequest(req);
  const { id } = await params;
  await deleteTemplate(id, session?.organizationId);
  return NextResponse.json({ ok: true });
}
