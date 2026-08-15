# Legacy AI Company — Master Vision

Source: Seni's master build instructions, captured 2026-07-30. This is the north star
for CRM.LegacyEstateRentals.com — not a sprint backlog. Individual phases get their own
architecture docs in `docs/architecture/` as they're actually built; this file is the
one place that holds the *why* and the full shape of where the system is headed.

## What this is

An AI-powered operating system for Legacy Estate Rentals (starting with Legacy Colombia),
structured as an "AI company" of specialized agents coordinated by a single AI COO, all
operating through one CRM that is the shared database, dashboard, approval center, and
audit log. OwnerRez stays the reservation/OTA backbone — this system integrates with it,
it does not replace it.

## Business objectives

- 90% direct bookings, 90% occupancy, maximized sustainable ADR
- Average guest rating ≥ 4.95 across all listings
- Owner involvement reduced to strategic decisions and exception approvals
- Automated: guest comms, marketing, pricing, maintenance, reporting, sales,
  reputation management, CRM follow-up, bill tracking
- Scalable to future properties (Florida, Miami, elsewhere)
- Complete logs of every AI action, recommendation, approval, communication, and
  financial activity

## Organizational structure

**CEO — Seni.** Approves: discounts above a configurable %, guest compensation/refunds
above configurable $, policy exceptions, cancellation-policy changes, new marketing
campaigns (unless pre-approved), major repairs, capex, vendor changes, new contracts,
bank-info changes, bill payments above threshold, bills from unknown vendors, and
anything unusual/suspicious or carrying legal/financial/safety/reputational risk. All
thresholds configurable in the CRM.

**AI COO — the only manager.** Routes events to the right specialist agent(s), prevents
duplicate work, resolves conflicting recommendations, escalates exceptions, tracks
deadlines, and ensures every agent follows approval policy and logs to the CRM. Owns a
visible task queue: task, assigned agent, priority, status, due date, confidence,
approval required, responsible person, last/next action, completion date.

**Ten specialist agents**, each with its own CRM tab, scorecard, and automation modes
(sandbox → shadow → approval → limited automation → full automation, configurable per
agent in the CRM):

1. **Revenue Manager** — occupancy/ADR/RevPAR optimization; eventually replaces
   PriceLabs, but only after a shadow-mode track record beats it. Auto rate changes
   only within configurable bands (e.g. ±5%); anything larger requires approval.
2. **Guest Experience Manager** — instant, personalized, translated guest comms across
   every channel; auto-sends only at ≥95% confidence and within policy; anything
   involving refunds/compensation/policy exceptions/safety escalates regardless of
   confidence.
3. **Maintenance Manager** — intake → urgency classification → work order → vendor
   WhatsApp group → tracking → cost/root-cause logging. Emergencies escalate
   immediately to Seni + local manager.
4. **Marketing Director** — content across all social channels, repurposed from single
   source assets, brand-voice enforced, new campaigns need approval, recurring approved
   campaign types can run automatically.
5. **SEO Manager** — rankings/traffic/content gaps, 3 blogs/week, technical SEO,
   attribution back to direct bookings.
6. **CRM & Lifecycle Marketing Manager** — segmentation, win-back/birthday/referral/
   abandoned-booking campaigns, consent tracking, next-best-action.
7. **Data Analyst** — the 5am ET daily executive report (30-second read): occupancy,
   ADR, RevPAR, direct-booking %, revenue vs. budget, pace, marketing/SEO performance,
   guest satisfaction, open maintenance, bills due/awaiting approval, top AI
   recommendations. Never invents numbers; flags missing/delayed data.
8. **Sales Agent** — converts inquiries to direct bookings across chat/DM/WhatsApp/
   phone/email; owns a pipeline (new → contacted → qualified → proposal → deposit →
   booked/lost/nurture); cannot promise unavailable dates or unapproved discounts.
9. **Reputation Manager** — monitors reviews across platforms, auto-responds to routine
   positive reviews, flags negative ones, alerts Maintenance/Guest Experience on
   operational patterns; negative reviews/legal threats/safety concerns require
   approval before any public response.
10. **Bill Pay & Accounts Payable Manager** — invoice intake (email/upload/WhatsApp) →
    extraction → vendor/property/category match → duplicate/anomaly detection →
    approval routing → payment scheduling → reconciliation. **Money movement is
    strictly permission-gated** — new vendors, bank-info changes, international wires,
    payments above threshold, duplicate/unusual/unmatched invoices, refunds, and any
    payment-instruction change (independently verified, never trusted from email alone)
    all require CEO approval. Tracking and detection are built and trusted long before
    any payment scheduling is turned on.

## CRM foundation (shared by every agent)

Tabs: Executive Dashboard, Reservations, Guests, Leads, Communications, Revenue
Management, Maintenance, Marketing, SEO, CRM Campaigns, Sales Pipeline, Reputation,
Bill Pay, Vendors, Reports, Approvals, AI Activity, Settings, Knowledge Base,
Properties.

Every record: created/updated timestamps, source, responsible agent, human owner,
status, priority, confidence score, approval requirement, full activity history,
attachments, and links to related property/guest/reservation/vendor/campaign/work
order/invoice.

**Approvals tab** — universal inbox for every agent's approval requests (also pushed to
WhatsApp when urgent), showing: what/why, requesting agent, recommendation,
alternatives, financial/guest/revenue impact, risk, deadline, confidence, supporting
records, and Approve/Reject/Modify/Ask-a-question actions.

**AI Activity tab** — append-only audit log of every agent action: timestamp, agent,
task, trigger, data reviewed, decision, policy used, confidence, action taken,
approval, comms sent, systems changed, result, error, reversal, human override. No
agent may delete its own audit history.

**Knowledge Base** — single source of truth every agent answers from (property facts,
policies, procedures, contracts, brand voice, FAQs). Agents escalate rather than
invent an answer when information is missing or contradictory.

## Guardrails that apply to every agent, always

- No agent bypasses an approval threshold, alters its own permissions, or erases audit
  records.
- No agent sends money without proper authorization.
- No agent fabricates data, reservations, financial figures, guest info, reviews, or
  results.
- Critical approval rules live in deterministic code, not only in AI prompts.
- Browser automation only where no reliable API exists; never the primary path for
  reservations, payments, pricing, or other mission-critical financial workflows.
- A master switch lets Seni pause all agents, or any one agent, or specific
  capabilities (auto messages, pricing changes, publishing, bill payments, vendor
  comms) independently.

## Phased roadmap (build one at a time, get sign-off, then move on)

1. **CRM foundation** — database, auth/roles, Properties/Guests/Reservations/
   Communications/Tasks, Approvals, AI Activity log, Knowledge Base, Executive
   Dashboard skeleton. *(Current phase — see `docs/architecture/PHASE1_CRM_FOUNDATION.md`)*
2. OwnerRez + communication integration (reservation/guest/availability sync, WhatsApp,
   email, translation, approval messages)
3. Guest Experience + Maintenance (work orders, WhatsApp maintenance groups, issue
   tracking)
4. Bill Pay + vendor management (tracking/detection only — no automatic payment
   movement during initial testing)
5. Revenue Management (shadow mode vs. PriceLabs before any live automation)
6. Sales + CRM lifecycle marketing
7. Marketing, social, SEO
8. Executive reporting + optimization

Before any agent gets automatic-action permission: observation mode → recommendation-
only → compare against human decisions → measure accuracy/impact → test failure/
duplicate/bad-data/rollback/emergency-shutdown scenarios → document results → Seni
approves activation.
