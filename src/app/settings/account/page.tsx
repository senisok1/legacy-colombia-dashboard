import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { getServerSession } from "@/lib/session";
import { getUserByEmail } from "@/lib/users";
import { allowedPropertyGroups } from "@/lib/propertyGroups";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// Settings → My Account (2026-08-17, Seni's ask). Reachable by EVERY login,
// including READ_ONLY team members — deliberately not in the proxy's
// team-blocked list, since the whole point is that team members manage their
// own password.
export default async function AccountPage() {
  const session = await getServerSession();
  const me = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const lang = me?.language;
  const properties = allowedPropertyGroups(me?.propertyAccess).map((g) => g.label);

  return (
    <div className="mx-auto max-w-3xl px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t("account.title", lang)}</h1>
        <p className="text-sm text-black/50 dark:text-white/50">{t("account.subtitle", lang)}</p>
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5 space-y-2 text-sm">
        <div>
          <span className="text-black/50 dark:text-white/50">{t("account.signedInAs", lang)} </span>
          <span className="font-medium">{me?.name || session?.email}</span>
          {me?.name && <span className="text-black/50 dark:text-white/50"> · {session?.email}</span>}
        </div>
        <div>
          <span className="text-black/50 dark:text-white/50">{t("account.access", lang)}: </span>
          {session?.role === "CEO" ? t("account.adminFull", lang) : t("account.teamViewOnly", lang)}
        </div>
        <div>
          <span className="text-black/50 dark:text-white/50">{t("account.properties", lang)}: </span>
          {properties.join(", ")}
        </div>
        {me?.language && me.language !== "English" && (
          <div>
            <span className="text-black/50 dark:text-white/50">{t("account.language", lang)}: </span>
            {me.language}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-black/10 dark:border-white/10 p-4 bg-white dark:bg-white/5">
        <h2 className="text-sm font-semibold mb-3">{t("account.changePassword", lang)}</h2>
        <ChangePasswordForm />
      </div>
    </div>
  );
}
