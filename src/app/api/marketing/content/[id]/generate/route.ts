import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "@/lib/config";
import { generateContentDraft } from "@/lib/contentMarketing";
import { getSessionFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "Database isn't connected yet." }, { status: 400 });
  }
  const session = getSessionFromRequest(req);
  const { id } = await params;
  try {
    const piece = await generateContentDraft(id, session?.organizationId);
    if (!piece) return NextResponse.json({ error: "Content piece not found." }, { status: 404 });
    return NextResponse.json({ piece });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error." },
      { status: 500 }
    );
  }
}
