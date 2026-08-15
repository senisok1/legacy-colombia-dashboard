import { NextRequest, NextResponse } from "next/server";
import { translateText } from "@/lib/translate";
import { getSessionFromRequest } from "@/lib/session";

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req);
  const { text, target } = (await req.json().catch(() => ({}))) as {
    text?: string;
    target?: "en" | "es";
  };
  if (!text || (target !== "en" && target !== "es")) {
    return NextResponse.json({ error: "Provide text and target ('en'|'es')" }, { status: 400 });
  }
  const result = await translateText(text, target, session?.organizationId);
  return NextResponse.json(result);
}
