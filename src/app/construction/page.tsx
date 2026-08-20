import { ConstructionBoard } from "@/components/ConstructionBoard";
import { getServerSession } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { enforceBillingLock } from "@/lib/billingGate";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// Construction Management (2026-08-20, Seni's ask): admin/owner + a
// dedicated CONSTRUCTION-role login only — see NavBar.tsx (nav visibility)
// and src/proxy.ts (the actual enforcement; a CONSTRUCTION session can't
// reach anything else, and this page 403s in the API for a plain READ_ONLY
// team login even if they guessed the URL).
export default async function ConstructionPage() {
  const session = await getServerSession();
  await enforceBillingLock(session);
  const viewer = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const lang = viewer?.language;

  return (
    <div className="mx-auto max-w-4xl px-6 py-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t("construction.title", lang)}</h1>
        <p className="text-sm text-black/50 dark:text-white/50">{t("construction.subtitle", lang)}</p>
      </div>
      <ConstructionBoard />
    </div>
  );
}
