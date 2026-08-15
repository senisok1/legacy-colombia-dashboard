# Legacy Colombia duplicate-page cleanup — follow-up needed

Checked the redirect from `legacyestaterentals.com` on 2026-08-06. The main fix is live and working, but two things were missed.

## ✅ Confirmed working

`legacyestaterentals.com/legacy-colombia/` now 301-redirects to `https://legacycolombia.com/`. This one's done — no action needed.

## ❌ Still needs fixing

**1. Duplicate content page not redirected**

`legacyestaterentals.com/new-legacy-colombia/` is still live as a full, separate page (old "Casa De Los Sueños" / tennis-court copy — different text from the current legacycolombia.com site). It needs the same treatment as `/legacy-colombia/`: a 301 redirect to `https://legacycolombia.com/`.

It's also still linked from the legacyestaterentals.com homepage in three places:
- "Legacy wedding & events venues" section — "Legacy Colombia" link
- Same section — "Legacy Mountain" link (also points to `/new-legacy-colombia/`, looks like a copy-paste leftover)
- "exotic location luxury rentals" section — "Legacy Colombia, Colombia" link

Once the redirect is in place these links will resolve correctly on their own, but it'd be cleaner to point them straight at `https://legacycolombia.com/` (or at `/legacy-colombia/`, which already redirects there) instead of relying on a second-hop redirect.

**2. Broken link — 404**

On the homepage's main property grid, the "Property Details" link under the "04. Legacy Colombia" card points to `legacyestaterentals.com/?page_id=3703`, which now returns "Page Not Found." Looks like that page was deleted without updating the link. Please repoint that link to `https://legacycolombia.com/`.

## Why this matters

Both issues create duplicate/broken content tied to the Legacy Colombia property, which works against the SEO cleanup already done on legacycolombia.com (new Spanish `/es/` page, hreflang tags, blog content). Redirecting `/new-legacy-colombia/` consolidates SEO value onto the real site instead of splitting it across two competing pages, and fixing the dead link removes a bad user experience on the main site's property grid.
