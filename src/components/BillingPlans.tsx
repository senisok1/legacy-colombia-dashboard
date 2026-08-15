"use client";

import { useEffect, useState } from "react";
import { formatCurrency, formatDate } from "@/lib/format";
import { CouponsManager } from "@/components/CouponsManager";
import { useCurrency } from "@/components/CurrencyProvider";
import { convertAmountCents } from "@/lib/currencyMath";

type Tier = {
  id: string;
  name: string;
  minProperties: number;
  maxProperties: number;
  monthlyPriceCents: number;
  annualPriceCents: number;
};

type BillingStatus = {
  plan: string;
  subscriptionStatus: "trialing" | "active" | "past_due" | "canceled";
  trialEndsAt: string | null;
  billingInterval: "monthly" | "annual";
  locked: boolean;
  stripeConfigured: boolean;
  propertyCount: number | null;
  recommendedTierId: string | "enterprise" | null;
  enterpriseMinProperties: number;
  tiers: Tier[];
  isOperator: boolean;
};

function tierPropertyLabel(tier: Tier): string {
  return tier.minProperties === tier.maxProperties
    ? `${tier.minProperties} property`
    : `${tier.minProperties}–${tier.maxProperties} properties`;
}

export function BillingPlans() {
  // Subscription charges always run in USD through Stripe regardless of the
  // display-currency toggle — we only show a converted estimate alongside
  // the real price so a COP-preferring user isn't surprised at checkout.
  const { secondaryCurrency, displayCurrency, rate } = useCurrency();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  // Lazy initializer (not called during render) so the impure Date.now()
  // call is a one-time "when this component mounted" snapshot, not a
  // render-time side effect.
  const [now] = useState<number>(() => Date.now());
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [busyTierId, setBusyTierId] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"plans" | "coupons">("plans");
  const [showEnterpriseForm, setShowEnterpriseForm] = useState(false);
  const [enterpriseForm, setEnterpriseForm] = useState({ name: "", email: "", message: "" });
  const [enterpriseSubmitted, setEnterpriseSubmitted] = useState(false);

  useEffect(() => {
    fetch("/api/billing/status")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: BillingStatus) => {
        setStatus(data);
        setInterval(data.billingInterval);
      })
      .catch(() => setError("Couldn't load billing status."));
  }, []);

  async function subscribe(tierId: string) {
    setBusyTierId(tierId);
    setError("");
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tierId, interval }),
      });
      const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !data?.url) {
        setError(data?.error || "Couldn't start checkout — try again.");
        setBusyTierId(null);
        return;
      }
      window.location.assign(data.url);
    } catch {
      setError("Couldn't start checkout — try again.");
      setBusyTierId(null);
    }
  }

  async function openPortal() {
    setPortalBusy(true);
    setError("");
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !data?.url) {
        setError(data?.error || "Couldn't open the billing portal.");
        setPortalBusy(false);
        return;
      }
      window.location.assign(data.url);
    } catch {
      setError("Couldn't open the billing portal.");
      setPortalBusy(false);
    }
  }

  async function submitEnterpriseInquiry() {
    if (!enterpriseForm.name.trim() || !enterpriseForm.email.trim()) return;
    const res = await fetch("/api/billing/enterprise-contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: enterpriseForm.name.trim(),
        email: enterpriseForm.email.trim(),
        propertyCount: status?.propertyCount ?? undefined,
        message: enterpriseForm.message.trim() || undefined,
      }),
    });
    if (res.ok) setEnterpriseSubmitted(true);
  }

  if (!status) {
    return <p className="text-sm text-black/50 dark:text-white/50">{error || "Loading…"}</p>;
  }

  const trialDaysLeft =
    status.trialEndsAt && now !== null
      ? Math.ceil((new Date(status.trialEndsAt).getTime() - now) / (24 * 60 * 60 * 1000))
      : null;

  return (
    <div className="space-y-6">
      {status.isOperator && (
        <div className="inline-flex rounded-md border border-black/10 dark:border-white/15 overflow-hidden text-sm">
          {(["plans", "coupons"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 ${
                activeTab === tab ? "bg-black text-white dark:bg-white dark:text-black" : "text-black/60 dark:text-white/60"
              }`}
            >
              {tab === "plans" ? "Plans" : "Coupons"}
            </button>
          ))}
        </div>
      )}

      {activeTab === "coupons" && status.isOperator && <CouponsManager />}

      {activeTab === "plans" && (
      <>
      {status.locked && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-900 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {status.subscriptionStatus === "trialing"
            ? "Your free trial has ended. Pick a plan below to keep using the dashboard."
            : status.subscriptionStatus === "past_due"
              ? "Your last payment failed. Update your payment method or pick a plan below to restore access."
              : "Your subscription has been canceled. Pick a plan below to restore access."}
        </div>
      )}

      {!status.locked && status.subscriptionStatus === "trialing" && trialDaysLeft !== null && (
        <div className="rounded-md border border-black/10 dark:border-white/15 px-4 py-3 text-sm text-black/70 dark:text-white/70">
          {trialDaysLeft > 0
            ? `${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} left in your free trial (ends ${formatDate(status.trialEndsAt ?? undefined)}).`
            : "Your trial ends today."}
        </div>
      )}

      {!status.locked && status.subscriptionStatus === "active" && (
        <div className="flex items-center justify-between rounded-md border border-black/10 dark:border-white/15 px-4 py-3 text-sm">
          <span className="text-black/70 dark:text-white/70">
            You&apos;re on the <strong className="text-black dark:text-white">{status.plan}</strong> plan, billed{" "}
            {status.billingInterval}.
          </span>
          <button
            onClick={openPortal}
            disabled={portalBusy}
            className="text-sm px-3 py-1.5 rounded-md border border-black/15 dark:border-white/20 disabled:opacity-40"
          >
            {portalBusy ? "Opening…" : "Manage billing"}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {!status.stripeConfigured && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Billing isn&apos;t fully configured on this deployment yet — plans are shown for reference but checkout won&apos;t
          work until Stripe is connected.
        </p>
      )}

      <div className="flex items-center gap-2">
        <span className="text-sm text-black/50 dark:text-white/50">Billing:</span>
        <div className="inline-flex rounded-md border border-black/10 dark:border-white/15 overflow-hidden text-sm">
          {(["monthly", "annual"] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => setInterval(opt)}
              className={`px-3 py-1.5 ${
                interval === opt
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "text-black/60 dark:text-white/60"
              }`}
            >
              {opt === "monthly" ? "Monthly" : "Annual (2 months free)"}
            </button>
          ))}
        </div>
        {status.propertyCount !== null && (
          <span className="text-xs text-black/50 dark:text-white/50">
            You currently manage {status.propertyCount} propert{status.propertyCount === 1 ? "y" : "ies"}.
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {status.tiers.map((tier) => {
          const priceCents = interval === "annual" ? tier.annualPriceCents : tier.monthlyPriceCents;
          const isRecommended = status.recommendedTierId === tier.id;
          const isCurrent = status.plan === tier.id && status.subscriptionStatus === "active";
          return (
            <div
              key={tier.id}
              className={`rounded-lg border p-4 space-y-3 ${
                isRecommended
                  ? "border-black dark:border-white"
                  : "border-black/10 dark:border-white/15"
              }`}
            >
              {isRecommended && (
                <span className="text-[10px] uppercase tracking-wide font-medium text-black/50 dark:text-white/50">
                  Recommended for you
                </span>
              )}
              <div>
                <h3 className="font-semibold">{tier.name}</h3>
                <p className="text-xs text-black/50 dark:text-white/50">{tierPropertyLabel(tier)}</p>
              </div>
              <div>
                <span className="text-2xl font-semibold">{formatCurrency(priceCents / 100)}</span>
                <span className="text-sm text-black/50 dark:text-white/50">
                  /{interval === "annual" ? "yr" : "mo"}
                </span>
                {secondaryCurrency && displayCurrency === secondaryCurrency && rate && (
                  <div className="text-xs text-black/40 dark:text-white/40">
                    ≈{" "}
                    {formatCurrency(
                      (convertAmountCents(priceCents, "USD", secondaryCurrency, rate.usdToTarget) ?? priceCents) / 100,
                      secondaryCurrency
                    )}{" "}
                    — charged in USD
                  </div>
                )}
              </div>
              <button
                onClick={() => subscribe(tier.id)}
                disabled={busyTierId === tier.id || isCurrent || !status.stripeConfigured}
                className="w-full text-sm px-3 py-2 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
              >
                {isCurrent ? "Current plan" : busyTierId === tier.id ? "Redirecting…" : "Subscribe"}
              </button>
            </div>
          );
        })}

        <div className="rounded-lg border border-black/10 dark:border-white/15 p-4 space-y-3">
          <div>
            <h3 className="font-semibold">Enterprise</h3>
            <p className="text-xs text-black/50 dark:text-white/50">{status.enterpriseMinProperties}+ properties</p>
          </div>
          <div>
            <span className="text-lg font-semibold">Custom pricing</span>
          </div>
          {!showEnterpriseForm ? (
            <button
              onClick={() => setShowEnterpriseForm(true)}
              className="w-full text-sm px-3 py-2 rounded-md border border-black/15 dark:border-white/20"
            >
              Talk to sales
            </button>
          ) : enterpriseSubmitted ? (
            <p className="text-xs text-green-600 dark:text-green-400">Thanks — we&apos;ll be in touch shortly.</p>
          ) : (
            <div className="space-y-2">
              <input
                value={enterpriseForm.name}
                onChange={(e) => setEnterpriseForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Your name"
                className="w-full rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm outline-none"
              />
              <input
                value={enterpriseForm.email}
                onChange={(e) => setEnterpriseForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="Email"
                className="w-full rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm outline-none"
              />
              <textarea
                value={enterpriseForm.message}
                onChange={(e) => setEnterpriseForm((f) => ({ ...f, message: e.target.value }))}
                placeholder="Anything else we should know? (optional)"
                rows={2}
                className="w-full rounded-md border border-black/10 dark:border-white/15 bg-transparent px-2 py-1.5 text-sm outline-none"
              />
              <button
                onClick={submitEnterpriseInquiry}
                disabled={!enterpriseForm.name.trim() || !enterpriseForm.email.trim()}
                className="w-full text-sm px-3 py-2 rounded-md bg-black text-white dark:bg-white dark:text-black disabled:opacity-40"
              >
                Send
              </button>
            </div>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
}
