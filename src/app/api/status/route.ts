import { NextRequest, NextResponse } from "next/server";
import { config, isLiveModeConfigured } from "@/lib/config";
import { testConnection } from "@/lib/ownerrez";
import { getSessionFromRequest } from "@/lib/session";

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  const demoMode = !isLiveModeConfigured();
  const connection = await testConnection(session?.organizationId);
  return NextResponse.json({
    configured: isLiveModeConfigured(),
    demoMode,
    propertyName: config.propertyName,
    connectionOk: connection.ok,
    message: connection.message,
  });
}
