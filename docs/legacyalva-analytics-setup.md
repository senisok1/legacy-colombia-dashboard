# Legacy Alva — Search Console & GA4 setup request

**Site:** www.legacyalva.com
**Why:** our internal dashboard pulls SEO and traffic numbers for each property
we own. Legacy Colombia is already connected the same way; Legacy Alva is the
second one. Everything below is **read-only** access for a service account —
nothing is written to, published on, or changed on the site.

**Service account to grant access to:**

```
crm-analytics-reader@legacy-crm-analytics.iam.gserviceaccount.com
```

---

## 1. Google Search Console

- Go to **search.google.com/search-console**.
- Check whether a property already exists for legacyalva.com. If not, create one.
- **Create it as a "Domain" property**, not a "URL prefix" property — enter
  `legacyalva.com` (no https://, no www). This is what Legacy Colombia uses, and
  it covers www, non-www, http and https in one place.
  - Verification is done by adding one **TXT record** in the domain's DNS
    (Google shows the exact value). Please add it wherever legacyalva.com's DNS
    is managed.
- Once the property is verified, open **Settings → Users and permissions →
  Add user**:
  - Email: `crm-analytics-reader@legacy-crm-analytics.iam.gserviceaccount.com`
  - Permission: **Full** (Search Console's "Restricted" level does not allow API
    reads, which is what our dashboard uses. The account is read-only in
    practice — it only ever calls the search-analytics reporting endpoint.)
- **Confirm back to us:** whether the property is a *Domain* property
  (`legacyalva.com`) or a *URL-prefix* property (`https://www.legacyalva.com/`).
  We have to match that exactly on our side, and the two are not interchangeable.

## 2. Google Analytics 4

- Go to **analytics.google.com**.
- Check whether a GA4 property already exists for legacyalva.com.
  - If **yes**, skip to the access step below.
  - If **no**, create a GA4 property for the site and install the tag on every
    page (via Google Tag / gtag.js, GTM, or the site platform's built-in GA4
    field — whichever fits how the site is built). Please confirm the tag fires
    on all pages including the booking/enquiry pages.
- Grant access: **Admin → Property access management → Add users**:
  - Email: `crm-analytics-reader@legacy-crm-analytics.iam.gserviceaccount.com`
  - Role: **Viewer** (that's all we need)
  - Untick "Notify new users by email" — it's a service account, not a person.
- **Send us the GA4 Property ID.** Find it under **Admin → Property details** —
  it's a number like `540074334`. Not the "G-XXXXXXX" measurement ID; we need
  the numeric property ID.

## 3. While you're in there (optional but useful)

- Confirm a **sitemap.xml** exists and is submitted in Search Console — it makes
  the Search Console data far more useful.
- Confirm **robots.txt** isn't blocking crawling of the main pages.

---

## What to send back

1. Search Console property type: **Domain** (`legacyalva.com`) or **URL-prefix**
   (`https://www.legacyalva.com/`)?
2. GA4 **numeric Property ID** (from Admin → Property details).
3. Confirmation that the service account has been added to both.

Search Console data lags 2–3 days, so numbers will start appearing shortly after
access is granted, and GA4 only reports traffic from the moment the tag goes
live — there's no historical backfill.
