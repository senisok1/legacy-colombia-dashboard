import { getRecentAiActivity, type AiActivityEntry } from "@/lib/aiActivity";
import { isDbConfigured } from "@/lib/config";
import { formatRelativeTime } from "@/lib/format";
import { getServerSession } from "@/lib/session";
import { enforceBillingLock } from "@/lib/billingGate";
import { RefreshButton } from "@/components/RefreshButton";

export const dynamic = "force-dynamic";

const ACTIVITY_LIMIT = 100;

const RESULT_STYLES: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300",
  drafted: "bg-blue-100 text-blue-800 dark:bg-blue-500/10 dark:text-blue-300",
  pending_approval: "bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300",
  rejected: "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60",
  failed: "bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-300",
};

function resultBadgeClass(result: string | null): string {
  if (!result) return "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50";
  return RESULT_STYLES[result] ?? "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50";
}

function resultLabel(result: string | null): string {
  if (!result) return "—";
  return result.replace(/_/g, " ");
}

export default async function ActivityPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const configured = isDbConfigured();
  const entries = configured ? await getRecentAiActivity(ACTIVITY_LIMIT, session?.organizationId) : [];

  return (
    <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">AI Activity</h1>
          <p className="text-sm text-black/50 dark:text-white/50">
            An append-only audit log of every action your AI agents have taken — what they reviewed, what they
            decided, and what happened as a result. Nothing here can be edited or deleted, by design.
          </p>
        </div>
        {configured && <RefreshButton />}
      </div>

      {!configured ? (
        <p className="text-sm text-black/50 dark:text-white/50 py-8 text-center">
          The Postgres database isn&rsquo;t connected yet — ask Claude to finish the one-time setup (see README) to
          start recording agent activity here.
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-black/50 dark:text-white/50 py-8 text-center">
          No agent activity recorded yet — this fills in as the AI Guest Experience Manager drafts and sends replies.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-black/40 dark:text-white/40">Showing the last {entries.length} events.</p>
          {entries.map((entry) => (
            <ActivityRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ entry }: { entry: AiActivityEntry }) {
  const hasDetail = entry.dataReviewed !== null || entry.communicationSent !== null;

  return (
    <div className="rounded-lg border border-black/10 dark:border-white/10 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium truncate">{entry.agentName ?? "Unknown agent"}</span>
          <span className="text-black/30 dark:text-white/30">·</span>
          <span className="text-black/70 dark:text-white/70 truncate">{entry.task}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[11px] px-2 py-0.5 rounded-full capitalize ${resultBadgeClass(entry.result)}`}>
            {resultLabel(entry.result)}
          </span>
          <span className="text-xs text-black/40 dark:text-white/40">{formatRelativeTime(entry.occurredAt)}</span>
        </div>
      </div>

      {entry.trigger && (
        <div className="mt-1.5 text-xs text-black/50 dark:text-white/50">Trigger: {entry.trigger}</div>
      )}

      {entry.decision && (
        <div className="mt-1.5 text-xs whitespace-pre-wrap">
          <span className="text-black/40 dark:text-white/40">Decision: </span>
          {entry.decision}
        </div>
      )}

      {entry.actionTaken && (
        <div className="mt-1 text-xs text-black/60 dark:text-white/60">{entry.actionTaken}</div>
      )}

      {entry.error && (
        <div className="mt-1.5 text-xs text-red-600 dark:text-red-400">Error: {entry.error}</div>
      )}

      {hasDetail && (
        <details className="mt-1.5">
          <summary className="text-[11px] text-black/40 dark:text-white/40 cursor-pointer select-none hover:text-black/60 dark:hover:text-white/60">
            Details
          </summary>
          <pre className="mt-1.5 text-[11px] whitespace-pre-wrap break-words rounded-md bg-black/5 dark:bg-white/10 p-2 overflow-x-auto">
            {JSON.stringify({ dataReviewed: entry.dataReviewed, communicationSent: entry.communicationSent }, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
