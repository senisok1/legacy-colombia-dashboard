import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { redisGet } from "@/lib/redis";
import { listTeamRequests } from "@/lib/teamRequests";
import { listConstructionItems } from "@/lib/construction";
import { effectivePropertyGroupId, PROPERTY_GROUP_COOKIE } from "@/lib/propertyGroups";
import { getUserByEmail } from "@/lib/users";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Notification bell (2026-08-22, Seni's ask to build the mock's bell for
// real). Answers one question: "what is waiting on ME right now?"
//
// DELIBERATELY NARROW SCOPE. This route only returns the few actionable
// counts the nav badges DON'T already compute:
//   - commissions awaiting the owner's approval
//   - team requests nobody has accepted or declined yet
//   - construction items past their estimated completion date
// The bell merges these with the badge counts the shell already polls
// (approvals, bills, leads, campaigns, maintenance, reputation — see
// components/shell/useNavBadges.ts), so opening the bell costs ONE light
// call rather than re-fetching six endpoints that are already in memory.
// That matters: those badge endpoints hit OwnerRez, and over-polling them
// is exactly what caused the 2026-08-05 rate-limit incident.
//
// Read-only. Every item is a count plus a link into the module that owns
// it — nothing here approves, dismisses or mutates anything.

export type NotificationItem = {
  key: string;
  label: string;
  count: number;
  href: string;
  /** true = time-critical (rendered in amber), false = routine. */
  urgent: boolean;
};

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Not logged in." }, { status: 401 });

  const me = await getUserByEmail(session.email).catch(() => null);
  const groupId = effectivePropertyGroupId(req.cookies.get(PROPERTY_GROUP_COOKIE)?.value, me?.propertyAccess);
  const today = new Date().toISOString().slice(0, 10);

  const items: NotificationItem[] = [];

  // Commissions awaiting approval — read from the snapshot the Commissions
  // tab already maintains rather than rebuilding the board (which fans out
  // to OwnerRez). Absent snapshot simply means "nothing to report yet".
  try {
    // Key must match commissionsSnapshotKey() in
    // api/management/commissions/route.ts — verified 2026-08-22 rather than
    // assumed, since a wrong key here fails silently as "nothing pending".
    const raw = await redisGet(`commissions:board:${session.organizationId}`);
    if (raw) {
      const board = JSON.parse(raw) as {
        extras?: { approved: boolean; declined: boolean; settledAt: string | null }[];
        directBookings?: { approved: boolean; declined: boolean; settledAt: string | null }[];
      };
      const pending = [...(board.extras ?? []), ...(board.directBookings ?? [])].filter(
        (l) => !l.approved && !l.declined && !l.settledAt
      ).length;
      if (pending > 0) {
        items.push({
          key: "commissions",
          label: `${pending} commission line${pending === 1 ? "" : "s"} awaiting your approval`,
          count: pending,
          href: "/commissions",
          urgent: false,
        });
      }
    }
  } catch {
    // Never let the bell fail over a cache miss.
  }

  try {
    const requests = await listTeamRequests(session.organizationId, groupId);
    const pending = requests.filter((r) => !r.accepted && !r.declined && !r.completed).length;
    if (pending > 0) {
      items.push({
        key: "team-requests",
        label: `${pending} team request${pending === 1 ? "" : "s"} awaiting a decision`,
        count: pending,
        href: "/team-log",
        urgent: false,
      });
    }
  } catch {
    // Same fail-quiet posture.
  }

  try {
    const construction = await listConstructionItems(session.organizationId, groupId);
    const overdue = construction.filter(
      (i) => !i.completed && i.estimatedCompletionDate && i.estimatedCompletionDate < today
    ).length;
    if (overdue > 0) {
      items.push({
        key: "construction-overdue",
        label: `${overdue} construction item${overdue === 1 ? "" : "s"} past due`,
        count: overdue,
        href: "/construction",
        urgent: true,
      });
    }
  } catch {
    // Same fail-quiet posture.
  }

  return NextResponse.json({ items });
}
