# GA4 double-counting fix — recap for developer

**Site:** legacycolombia.com
**Date:** 2026-08-06
**Property:** Legacy Colombia (GA4 property 540074334, stream ID G-2YWN56BF3J)

## What was wrong

Google Tag Manager (container `GT-K8D25ZVK`) was already firing a GA4 Configuration tag on every page. When Site Kit by Google was installed, its Analytics module connected to the same GA4 property and had "Place Google Analytics code" turned on — meaning Site Kit *also* injected its own gtag.js snippet on every page load. Result: every pageview and session was being recorded twice in GA4 (once via GTM, once via Site Kit's own tag), inflating traffic numbers and skewing bounce rate / engagement metrics.

## Fix applied

In WordPress admin: **Site Kit → Settings → Connected Services → Analytics**, turned off the **"Place Google Analytics code"** toggle. Confirmed the change took by checking the "Code Snippet" status, which now reads "Snippet is not inserted."

This does **not** affect Site Kit's own reporting dashboard inside WP admin — that reads GA4 data via the Analytics Data API using the connected Google account, independent of which mechanism places the tracking tag. No changes were made inside GTM itself; it remains the sole source of the GA4 tag.

## What to verify / watch for

- No code changes needed on your end — this was a Site Kit settings toggle, not a template/theme change.
- If historical GA4 reports (before 2026-08-06) look ~2x actual traffic, that's the double-count artifact from before the fix — not a new problem.
- If Site Kit is ever reconnected or reset in the future, check that this toggle stays off, since reconnecting the Analytics module can reset it to its default (on).
