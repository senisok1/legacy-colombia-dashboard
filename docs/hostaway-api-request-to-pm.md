# Request: Hostaway API access for Legacy Pompano

**Property:** Legacy Pompano — Beachfront Oasis (Pool, Cinema, Game Room)
**Requested by:** Seni Sok, owner
**Purpose:** pull Legacy Pompano's reservation, revenue and guest-message data
into the owner's own reporting dashboard.

---

## Why I'm asking

I run a dashboard across all of my properties. Everything except Pompano is on
OwnerRez, and OwnerRez only receives Pompano's calendar from you over iCal.

An iCal feed carries dates and nothing else. Concretely, on my side Pompano
shows **246 calendar entries, 233 of which are $0 availability blocks** with no
guest name and no revenue attached. Only 8 bookings carry any financial data at
all. So Pompano currently reports about **$54,000 all-time** against what I know
is a materially higher number — not a reporting bug, just the limit of what iCal
can carry.

The only way to see accurate figures for my own property is to read it from
Hostaway directly.

---

## What I need

One set of Hostaway Public API credentials:

- **Account ID**
- **API Key**

**How to create them:**

1. In Hostaway, go to **Settings → Hostaway API**
   (direct link: `dashboard.hostaway.com/settings/hostaway-api`)
2. Click **Create**
3. Name it something identifiable — e.g. **"Legacy Pompano — owner reporting"**
4. Select **Partner / Hostaway Public API**
5. Save, and copy **both** values immediately

⚠️ Hostaway displays the Account ID and API Key **once only**. Once you navigate
away, neither you nor Hostaway support can retrieve them — you'd have to
generate a new pair. Copy them before leaving the page.

Please **don't email the API key**. Options, in order of preference:

- Add it directly into our dashboard's settings yourself (I'll send a one-time
  link), or
- Send it via a self-destructing link (1password.com/share, privnote.com), or
- Call/text it to me separately from the Account ID.

---

## The part you're right to be concerned about

**A Hostaway API key is account-wide.** Hostaway does not offer per-listing API
scoping — permissions are managed at the listing level for user accounts, but an
API key issued from your account can technically read every listing on it, not
just Pompano.

I'm flagging that myself rather than letting you discover it, because you have
obligations to your other owners and I'm not asking you to quietly take a risk
on their behalf. Here is exactly what we commit to:

- **We filter to Pompano's listing ID only.** Every request our system makes is
  scoped to Legacy Pompano's listing. No other listing's reservations, guests or
  messages are read, stored, or displayed anywhere in our system.
- **Read-only in practice.** We call reporting endpoints. We do not create,
  modify or cancel reservations, and we do not change calendars, pricing or
  availability.
- **Nothing is written back to Hostaway** without asking you first, in writing.
- **Stored encrypted**, in the same secrets store as our other credentials —
  never in a spreadsheet, email thread, or shared document.
- **You can revoke it instantly, at any time, without asking us** — delete the
  key in Settings → Hostaway API and our access stops immediately. We'd
  appreciate a heads-up so we know why data stopped, but you never need our
  permission.
- **Auditable.** Because the key is named, you can see in Hostaway that it's
  ours, distinct from any other integration on the account.
- Happy to put the above in writing as a short data-processing agreement if that
  helps you with your other owners.

**If you'd still rather not issue an account-wide key**, tell me — that's a
reasonable position. Workable alternatives:

- A scheduled export (CSV or report) of Pompano's reservations, sent monthly.
  Less useful, but it fixes the revenue accuracy problem.
- A separate Hostaway account holding only Legacy Pompano, if you're open to
  moving the listing.

---

## What we'll pull (Legacy Pompano only)

| Data | Used for |
|---|---|
| Reservations — dates, status, channel, amounts | Revenue, occupancy, ADR reporting |
| Guest name, phone, email | Arrivals list for the on-site team |
| Guest message threads | Consolidated inbox alongside our other properties |
| Listing details | Matching the listing to the right property tab |

---

## What to send back

1. **Account ID** (this one is fine by email)
2. **API Key** (via one of the secure methods above)
3. Confirmation of the **listing name or ID** for Legacy Pompano in Hostaway, so
   I can be certain I'm filtering to the right one

If it's easier to do this on a quick call, I'm happy to walk through it with you
while you're in the dashboard. And if anything above gives you pause, say so —
I'd rather solve it than have you feel pushed into it.

Thanks,
Seni
