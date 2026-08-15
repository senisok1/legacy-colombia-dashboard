# Legacy Colombia — Website Recommendations for Direct-Booking Growth

Prepared 2026-08-02 for Seni to share with the development team. Every item below was verified directly on the live site, in WordPress admin, and in the CRM's real Search Console data — nothing here is speculative. Claude will be implementing these directly via existing WordPress admin access; this list is for the dev team's visibility and sign-off.

**Core goal all of this serves: get a visitor from "browsing" to "booked directly" — skipping Airbnb/VRBO fees entirely.** Every recommendation below is filtered through that lens.

---

## 1. Booking & conversion funnel (highest priority — fix first)

- **There is currently no way to actually book or inquire on the site.** Every CTA — header "CHECK AVAILABILITY," "BOOK DIRECT - SAVE," "RESERVE," and the dedicated Contact Us page — either links to a dead on-page anchor (`#book`, which exists in the HTML but has nothing in it) or just repeats the phone number / a generic `mailto:` link. Confirmed on Home, About, Amenities, Gallery, and Contact.
- This is the direct, confirmed cause of the "Check Availability" Gravity Form showing 141 views and 0 real submissions, and the Airbnb Form showing only 1.
- **Fix:** embed the Gravity Forms "Check Availability" form directly and visibly on the homepage's Reserve section and on Contact Us (Elementor's native Gravity Forms widget does this without a rebuild), or make the header button open the form in a popup/modal on every page.
- The form is already wired into the CRM (`crm.legacyestaterentals.com`) via webhook, so every fixed submission becomes a tracked lead automatically — no extra work needed once it's visible.
- **Bigger upgrade to consider:** embed an actual real-time availability calendar (OwnerRez supports an embeddable booking widget) instead of only a lead-capture form. Right now even a fixed form still requires a guest to submit and wait for a reply — showing live dates and letting them request/book instantly removes friction that pushes undecided guests toward Airbnb's Instant Book instead.
- **Price transparency:** no nightly rate or "starting from $X" appears anywhere on the site. Luxury travelers self-qualify on price before they'll fill out any form — add at minimum a rate range near the booking CTA.
- **Make the "book direct and save" pitch louder and more specific.** The only place the actual number appears is "Direct guests save 15%" buried on the About page. Put a specific savings callout (e.g., "Save 15% + no booking fees") next to every booking CTA sitewide, not just implied by button copy that says "SAVE" with no number.
- **Add a WhatsApp click-to-chat button** (floating, all pages). The CRM already has a full AI-assisted WhatsApp reply system built and running for this property — there's currently no WhatsApp link anywhere on the public site to feed it. This is the fastest win on this list since the backend already exists.

## 2. Trust & social proof

- The four guest reviews (Troy, Bailee, Jenee, Harry) are strong, specific, and well-written — keep the copy, but they're currently hardcoded text with no link to a verifiable source. Add a live Google Reviews widget or link each quote to its original review — award judges and skeptical travelers both look for a way to verify.
- No FAQ page exists in the current navigation (an old FAQ page existed on a previous version of the site and was dropped in the redesign). A direct-booking FAQ — cancellation/deposit policy, minimum stay, check-in/out times, pet policy, what makes booking direct safe — removes the exact hesitations that send people back to Airbnb for its "buyer protection."

## 3. Design & branding consistency

- The current site's palette (dark navy header/sections, gold/mustard CTA buttons, cream serif headlines) is cohesive and genuinely elegant across every current page — Home, About, Amenities, Gallery, and Contact all match. No change needed here.
- **The one real inconsistency:** the 5 older blog posts (see Section 4) still render in the *previous* site's design entirely — different header, different logo treatment, different footer ("© 2024," different quick links like "Villa Specs" and "FAQ's" that no longer exist in the current nav). Anyone landing on one of these from Google sees a visually disconnected, dated version of the brand. These need to be re-templated into the current design, not just left as-is.

## 4. Blog & content — fix what exists, then grow it

- **Reconnect the blog archive.** WordPress has 6 published posts, but the live `/legacy-colombia-blog/` page only lists 1. The other 5 are orphaned — still indexed by Google (one earns 380 impressions/month, another 348) but invisible to anyone browsing the site normally. Likely a template/query setting on the blog archive page in Elementor, not missing content.
- **Clean up the 5 orphaned posts** before relinking them:
  - Old site header/footer/branding (see Section 3).
  - Leftover, unedited AI-research citation fragments pasted directly into the body text (e.g., "Weather Spark+1," "Tomplanmytrip: Colombia Travel agency") — reads as unpolished/AI-generated rather than authoritative.
  - A factual error: one post's image caption reads "Discover Unmatched Luxury Living with Private Tennis Courts" — the property has no tennis court. Needs correcting.
  - None of the 6 posts have a Rank Math focus keyword set — a quick fix that improves on-page SEO scoring across the board.
- **New content, grounded in real Search Console queries** (not guesses — pulled from the CRM's live GSC data, 1,276 impressions / 19 clicks over the last 28 days):
  - *"Guatapé vs. Medellín: Where Should You Stay for a Colombia Trip?"* — comparison content for undecided travelers.
  - *"El Peñol & Guatapé Family Trip Guide: What to Do With Kids"* — "family friendly rentals" already gets 35 impressions/month with nothing directly answering it.
  - *"Guatapé Rock (La Piedra del Peñol): Complete Visitor Guide"* — the area's #1 landmark; no dedicated page exists despite huge independent search interest and strong backlink potential from Colombia travel sites.
  - *"How Much Does a Luxury Villa in Guatapé Cost? A Real Pricing Breakdown"* — answers real "affordable luxury"/pricing-intent queries and doubles as a natural place to pitch direct-booking savings.
  - Expand/fix the existing "best months to visit" post, and consider a **Spanish-language companion** given "cuando es la temporada baja" (low season, in Spanish) is already a real incoming query.
  - A recurring **"Guest Story" series** built from real past stays — cheap to produce, reuses the strong review material you already have, and keeps a fresh publishing cadence.
- **Cadence:** the CRM's Marketing tab already has an AI content-idea drafting tool for this — it drafts, you review and publish. There's been a 9-month gap since the last post (Nov 2025); even resuming at 1/month changes the trajectory meaningfully.

## 5. Language

- The header has a live "EN" language switcher, implying Spanish support was planned, but every page checked is English-only right now.
- A real Spanish-language version (site + at least the top-performing blog posts) opens the Colombian domestic/regional weekend-trip market — a genuinely different, currently-untapped audience from the English-speaking wellness-retreat travelers the current copy targets. Not urgent, but a real opportunity once the funnel and blog fixes above are done.

## 6. Technical / SEO fundamentals

- **No LodgingBusiness/VacationRental schema markup detected.** Rank Math is already installed and supports this — enabling it earns star ratings, price range, and amenity rich results directly in Google search results, improving click-through on the impressions already coming in.
- **GA4 tracking still isn't installed** (already flagged and queued separately) — without it, there's no way to measure whether any of the above changes are actually working once they ship.
- **Two form plugins installed** (Gravity Forms and WPForms) — both active. Consolidating to one reduces plugin bloat and admin confusion about which system is the "real" one.
- **Page speed** should get an actual PageSpeed Insights / GTmetrix run — heavy hero video and large images are a common cost on a photography-led site like this, and speed is a Google ranking factor.

---

## Suggested order of operations

1. Get the booking form actually visible and working (Section 1) — this is costing real bookings today.
2. Add the WhatsApp click-to-chat button — fastest win, backend already exists.
3. Add specific "save 15%, no fees" messaging next to every booking CTA.
4. Fix the blog archive so all 6 posts are visible.
5. Clean up the 5 orphaned posts (re-theme, remove AI-artifact text, fix the tennis court error, set focus keywords).
6. Add a live reviews widget and a direct-booking FAQ page.
7. Add LodgingBusiness schema via Rank Math; install GA4 tracking.
8. Publish 1–2 new blog posts/month from the list in Section 4, starting with the Guatapé Rock guide.
9. Evaluate a real-time OwnerRez booking-calendar embed (bigger lift, biggest long-term conversion upgrade).
10. Spanish-language site + content, once the above is stable.
