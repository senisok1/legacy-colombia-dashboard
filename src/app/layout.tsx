import type { Metadata, Viewport } from "next";
import { NavBar } from "@/components/NavBar";
import { StatusBanner } from "@/components/StatusBanner";
import { CurrencyProvider } from "@/components/CurrencyProvider";
import { PwaRegister } from "@/components/PwaRegister";
import { getServerSession } from "@/lib/session";
import { cookies } from "next/headers";
import {
  PROPERTY_GROUP_COOKIE,
  effectivePropertyGroupId,
  allowedPropertyGroups,
  DEFAULT_PROPERTY_GROUP_ID,
} from "@/lib/propertyGroups";
import { getUserByEmail } from "@/lib/users";
import { getOrganizationById } from "@/lib/organizations";
import { isDbConfigured } from "@/lib/config";
import { getTheme } from "@/lib/themes";
import "./globals.css";

// Phase 5 (PWA, 2026-08-08): manifest/icons/appleWebApp below make the
// dashboard installable to a phone's home screen — see app/manifest.ts for
// the manifest content itself and public/sw.js for the (deliberately
// minimal) service worker. themeColor moved to the separate `viewport`
// export per Next's current Metadata API.
export const metadata: Metadata = {
  title: "Legacy Colombia — Dashboard",
  description: "Booking dashboard and guest CRM for Legacy Colombia",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "LC Dashboard",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

// Resolves the signed-in user's organization color scheme (Settings >
// Appearance, see lib/themes.ts) and secondary display currency (Settings >
// Currency, see lib/organizations.ts) in one shot so the root layout only
// needs a single DB round-trip. Falls back to the default theme and no
// secondary currency for logged-out pages (login/signup) or if the DB read
// fails, rather than blocking the whole app's render on it succeeding.
async function resolveOrgSettings() {
  if (!isDbConfigured()) return { theme: getTheme(null), secondaryCurrency: null as string | null };
  try {
    const session = await getServerSession();
    if (!session) return { theme: getTheme(null), secondaryCurrency: null as string | null };
    const org = await getOrganizationById(session.organizationId);
    return { theme: getTheme(org?.theme), secondaryCurrency: org?.secondaryCurrency ?? null };
  } catch {
    return { theme: getTheme(null), secondaryCurrency: null as string | null };
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { theme, secondaryCurrency } = await resolveOrgSettings();
  // Role drives nav visibility: READ_ONLY team logins get a simplified nav
  // (no CRM/Messaging/Marketing/AI Activity/Reports — 2026-08-16 Seni's ask).
  const session = await getServerSession();
  const cookieStore = await cookies();
  // Property access (2026-08-16): the switcher only offers properties this
  // login may see, and a disallowed cookie value falls back to their first
  // allowed property.
  const me = session ? await getUserByEmail(session.email).catch(() => null) : null;
  const propertyGroupId = effectivePropertyGroupId(cookieStore.get(PROPERTY_GROUP_COOKIE)?.value, me?.propertyAccess);
  const allowedGroups = allowedPropertyGroups(me?.propertyAccess).map((g) => ({ id: g.id, label: g.label }));
  return (
    <html lang="en" className="h-full antialiased" data-theme={theme.id}>
      {/* No hardcoded bg-neutral-50/dark:bg-neutral-950 here anymore — body's
          background/text now come entirely from the --background/--foreground
          CSS variables in globals.css, which is what lets a forced-dark theme
          like Red & Black actually take effect regardless of the visitor's OS
          light/dark preference. */}
      <body className="min-h-full flex flex-col">
        <PwaRegister />
        {/* USD→COP toggle is Legacy Colombia only (2026-08-17, Seni's ask:
            "the USD to COP conversion toggle should only show on the Legacy
            Colombia property page. All the other properties are USD only").
            The org-level secondaryCurrency setting still drives WHETHER the
            feature exists; this decides which property it applies to. Passing
            null disables the toggle and renders every figure in USD. */}
        <CurrencyProvider
          secondaryCurrency={propertyGroupId === DEFAULT_PROPERTY_GROUP_ID ? secondaryCurrency : null}
        >
          <NavBar role={session?.role} propertyGroupId={propertyGroupId} propertyGroups={allowedGroups} />
          <StatusBanner />
          <main className="flex-1">{children}</main>
        </CurrencyProvider>
      </body>
    </html>
  );
}
