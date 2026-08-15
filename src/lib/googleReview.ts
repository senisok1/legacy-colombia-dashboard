// Direct link straight to the "leave a review" flow on Legacy Colombia's
// Google Business Profile — pulled from the GBP dashboard's own "Ask for
// reviews" panel (Business Profile Manager -> Ask for reviews -> Review
// link), captured 2026-08-04. This is Google's official short link for this
// specific listing (g.page/r/<id>/review); it is not something to
// regenerate or guess — if it ever needs to change, re-pull it from that
// same panel.
//
// Used by lib/lifecycleMarketing.ts's "review_request" campaign type. Kept
// in its own tiny module (rather than inline in lifecycleMarketing.ts) so
// it's easy to find and update without digging through drafting logic, and
// so any other future feature that wants this link (e.g. a post-checkout
// email) can import it from one place.
export const GOOGLE_REVIEW_LINK = "https://g.page/r/CZAJnJ0y5JQiEBM/review";
