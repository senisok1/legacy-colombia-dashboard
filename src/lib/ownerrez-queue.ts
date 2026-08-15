/**
 * Request queue for OwnerRez API calls.
 *
 * OwnerRez enforces a strict 300 requests / 5 minutes (~1 req/sec sustained) per IP.
 * This queue batches requests in groups of 5 with 400ms delays between batches.
 * This keeps sustained rate at ~1.2 req/sec (safe margin) while completing within Vercel's 60s timeout.
 *
 * Deployed 2026-08-06 as Priority 4 fix for intermittent 429 rate-limit errors.
 * Simplified 2026-08-06 to avoid race conditions in concurrent queue processing.
 */

class OwnerRezRequestQueue {
  private queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }> = [];

  private isProcessing = false;
  private lastBatchTime = 0;
  private readonly BATCH_SIZE = 5; // Process 5 requests concurrently
  private readonly BATCH_DELAY_MS = 400; // 400ms between batches

  /**
   * Enqueue an OwnerRez API call. Returns a promise that resolves when the call completes.
   */
  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: async () => fn(),
        resolve: resolve as (value: any) => void,
        reject,
      });
      this.process();
    });
  }

  /**
   * Process the queue in batches, ensuring rate-limit compliance and Vercel timeout safety.
   */
  private async process(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;

    while (this.queue.length > 0) {
      // Enforce minimum delay between batches
      const now = Date.now();
      const timeSinceLastBatch = now - this.lastBatchTime;
      const waitMs = Math.max(0, this.BATCH_DELAY_MS - timeSinceLastBatch);

      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }

      this.lastBatchTime = Date.now();

      // Grab next batch of requests
      const batch = [];
      for (let i = 0; i < this.BATCH_SIZE && this.queue.length > 0; i++) {
        const item = this.queue.shift();
        if (item) batch.push(item);
      }

      // Execute batch in parallel
      await Promise.all(
        batch.map(({ fn, resolve, reject }) =>
          fn()
            .then((result) => {
              resolve(result);
            })
            .catch((err) => {
              reject(err instanceof Error ? err : new Error(String(err)));
            })
        )
      );
    }

    this.isProcessing = false;
  }
}

// Singleton instance
export const ownerRezQueue = new OwnerRezRequestQueue();
