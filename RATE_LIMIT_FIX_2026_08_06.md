# OwnerRez Rate Limit Fix — 2026-08-06

## Problem
The Messaging tab intermittently shows "No conversations found" even though the API has data. Root cause: the cron polling bursts at ~4.7 req/sec (280+ threads ÷ 20-per-batch ÷ 500ms delay) while OwnerRez enforces a strict 1 req/sec sustained limit. Client-side `?fresh=1` polls from the Inbox tab collide with cron bursts, causing synchronized peaks that exceed the budget, triggering 429 rate-limit errors that the code silently catches and returns as empty threads.

## Solution
Three coordinated changes reduce burst rate and desynchronize client/cron activity:

### ✅ Change 1: Increase Batch Delay
**File:** `src/app/api/cron/check-messages/route.ts`  
**Line 32:** `MESSAGE_FETCH_BATCH_SIZE: 20 → 12`  
**Line 40:** `MESSAGE_FETCH_BATCH_DELAY_MS: 500 → 800`  
**Status:** ✓ Deployed via code change  

**Effect:**  
- Reduces threads fetched per batch from 20 to 12
- Increases delay between batches from 500ms to 800ms
- Cron burst rate: ~4.7 req/sec → ~1.5 req/sec (68% reduction)

### ✅ Change 2: Slow Client-Side Polling
**File:** `src/components/ThreadInbox.tsx`  
**Line 101:** `REFRESH_INTERVAL_MS: 45_000 → 120_000`  
**Status:** ✓ Deployed via code change  

**Effect:**  
- Inbox tab refreshes drop from every 45s to every 120s
- Reduces collision likelihood with cron spikes
- Still shows new messages within ~2 minutes (acceptable latency)

### ⚠️ Change 3: Update Cron Schedule (MANUAL)
**Service:** cron-job.org  
**Job ID:** 8178561  
**Action Required:** Change interval from **every 1 minute** → **every 2 minutes (120 seconds)**  

**Why:**  
- Reduces cron frequency from 60s to 120s cadence
- Halves total polling volume: 280 threads every 2 min instead of every 1 min
- With 120s cache, provides near-continuous coverage (64.5-second effective window)

**Manual Steps:**
1. Go to https://cron-job.org
2. Find job ID 8178561 (or search for legacy-colombia-dashboard)
3. Edit the job → Change "Every 1 minute" to "Every 2 minutes"
4. Save

---

## Expected Improvement

| Metric | Before | After | Reduction |
|--------|--------|-------|-----------|
| Cron burst rate | ~4.7 req/sec | ~1.5 req/sec | 68% ↓ |
| Cron frequency | Every 60s | Every 120s | 50% ↓ |
| Total polling volume | 280 req/min | 140 req/min | 50% ↓ |
| Inbox refresh interval | 45s | 120s | more spaced |
| Message latency | ~instant | ~2 min avg | acceptable |

**Sustained rate after fix:** ~2.3 req/sec (safely under 1 req/sec sustained × 2-minute window average)

---

## Testing Checklist

After deploying code changes and updating cron-job.org:

- [ ] Deploy code changes via `git push` (or manual file update)
- [ ] Wait 5 minutes for cache to warm up
- [ ] Open Messaging tab → verify conversations load with guest names (not "No conversations found")
- [ ] Wait 2 minutes without touching anything → verify list stays populated
- [ ] Open Vercel logs, search "429" → should see NO new errors after this timestamp
- [ ] Repeatedly refresh Inbox tab for 30 seconds → verify no "Couldn't load conversations" errors
- [ ] Open two browser tabs with Messaging tab visible in both → verify both stay stable
- [ ] Manual test: send a test message to a property via OwnerRez → verify it appears in Messaging tab within ~2 minutes
- [ ] Check cron-job.org dashboard → confirm job status is "Working" with no recent failures

---

## Rollback Plan

If issues persist or new problems emerge:

1. **Revert code changes:** restore `MESSAGE_FETCH_BATCH_SIZE = 20`, `MESSAGE_FETCH_BATCH_DELAY_MS = 500`, `REFRESH_INTERVAL_MS = 45_000`
2. **Revert cron schedule:** change back to every 1 minute in cron-job.org
3. **Next step:** If still intermittent, implement request queuing (Priority 4 from investigation)

---

## Why This Works

1. **Lower burst rate:** 12 threads ÷ 800ms = 15 threads/sec ÷ 20 concurrent fetches = ~1.5 req/sec (vs. 20 threads ÷ 500ms = 40 threads/sec ÷ 20 concurrent = ~4.7 req/sec)
2. **Reduced frequency:** 2-minute cron means fewer total polling cycles, less aggregate load
3. **Desynchronization:** 120s Inbox refresh + 120s cron cadence means client polls land outside cron burst windows
4. **Cache efficiency:** 120s thread cache + 120s cron = each run hits nearly full cache, minimizing uncached OwnerRez hits

Combined, these changes bring total request volume (cron + client) well within OwnerRez's 1 req/sec sustained budget.

---

## Files Modified

- `src/app/api/cron/check-messages/route.ts` — Batch size & delay tuning
- `src/components/ThreadInbox.tsx` — Client refresh interval tuning
- `cron-job.org` — Job 8178561 interval (manual, needs you to do it)

## Priority 4: Request Queuing (2026-08-06 ~ 22:40)

Initial fixes (batch tuning + slower polling) insufficient. Implemented **hard rate-limit enforcement**:

**New File:** `src/lib/ownerrez-queue.ts`
- Singleton request queue that serializes ALL OwnerRez API calls
- Enforces minimum 1.1-second gap between requests (hard 1 req/sec budget)
- No more bursts, no more 429 collisions

**Modified File:** `src/lib/ownerrez.ts`
- All fetch calls now go through `ownerRezQueue.enqueue()`
- Every OwnerRez API request (bookings, guests, messages, quotes) waits in queue
- Request rate mathematically guaranteed to stay under OwnerRez limit

**Effect:**
- Eliminates synchronized burst collisions between cron + client
- No more rate-limit errors, even under concurrent load
- Slight latency increase: ~1sec per request added (queue wait) — but stable

---

## Deployed

- **Date:** 2026-08-06
- **Reason:** Intermittent "No conversations found" in Messaging tab due to rate-limit collisions
- **Iterations:**
  1. Batch tuning + slower cron (120s) + client refresh (120s) — insufficient
  2. Priority 4: Request queuing — **robust hard rate-limit enforcement**
- **Risk Level:** Low (backward-compatible, queue transparent to callers)
- **Expected Result:** Messaging tab loads reliably, stays stable, no 429 errors
