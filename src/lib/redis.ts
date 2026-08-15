import { createClient, type RedisClientType } from "redis";
import { config, isRedisConfigured } from "./config";

// A single shared Redis connection, reused across requests within the same
// serverless function instance (Vercel keeps warm instances around between
// invocations, unlike /tmp files — this is what actually gets us real
// persistence instead of the local JSON store's best-effort behavior).
//
// If REDIS_URL isn't set (e.g. running locally without the Vercel Redis
// integration pulled down via `vercel env pull`), every call here throws a
// clear error instead of hanging — callers should check isRedisConfigured()
// first and degrade gracefully, same pattern as isMessagingConfigured().

let client: RedisClientType | undefined;
let connectPromise: Promise<RedisClientType> | undefined;

export class RedisNotConfiguredError extends Error {
  constructor() {
    super(
      "REDIS_URL isn't set. Connect the Redis database to this project in Vercel's Storage tab, or run `vercel env pull .env.local` to get it locally."
    );
    this.name = "RedisNotConfiguredError";
  }
}

async function getClient(): Promise<RedisClientType> {
  if (!isRedisConfigured()) throw new RedisNotConfiguredError();

  if (client?.isOpen) return client;

  if (!connectPromise) {
    const c = createClient({ url: config.redisUrl }) as RedisClientType;
    c.on("error", (err) => console.error("[redis] connection error", err));
    connectPromise = c.connect().then(() => {
      client = c;
      return c;
    });
  }

  return connectPromise;
}

export async function redisGet(key: string): Promise<string | null> {
  const c = await getClient();
  return c.get(key);
}

/**
 * Batch GET — fetches many keys in a single round trip to Redis instead of
 * one `GET` per key. Order of results matches `keys`; missing keys come
 * back as null. Used anywhere a caller previously looped `await redisGet()`
 * once per item (e.g. translations for every message in a thread), which on
 * a thread with a couple dozen messages meant that many sequential network
 * round trips just to check the cache — the single biggest cause of the
 * Messaging tab's "opening a conversation" delay before this was added.
 */
export async function redisMGet(keys: string[]): Promise<(string | null)[]> {
  if (keys.length === 0) return [];
  const c = await getClient();
  return c.mGet(keys);
}

export async function redisSet(
  key: string,
  value: string,
  options?: { exSeconds?: number }
): Promise<void> {
  const c = await getClient();
  if (options?.exSeconds) {
    await c.set(key, value, { EX: options.exSeconds });
  } else {
    await c.set(key, value);
  }
}

export async function redisDel(key: string): Promise<void> {
  const c = await getClient();
  await c.del(key);
}

export async function redisKeys(pattern: string): Promise<string[]> {
  const c = await getClient();
  return c.keys(pattern);
}
