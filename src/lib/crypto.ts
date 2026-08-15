import crypto from "node:crypto";
import { config } from "./config";

// AES-256-GCM encrypt/decrypt for per-tenant credentials at rest (see
// db/migrations/0016_organization_credentials.sql and lib/credentials.ts).
// CREDENTIALS_ENCRYPTION_KEY is a 32-byte key, base64-encoded, generated
// once and stored as a Vercel "Sensitive" env var — never typed or
// memorized by a person, same pattern as AUTH_SECRET. Losing/rotating it
// without a re-encryption migration makes every stored credential
// unrecoverable, so treat it like a database password.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM

function getKey(): Buffer {
  const raw = (process.env.CREDENTIALS_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY isn't set — required to encrypt/decrypt per-tenant credentials."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  return key;
}

export function isCredentialsEncryptionConfigured(): boolean {
  return Boolean((process.env.CREDENTIALS_ENCRYPTION_KEY || "").trim());
}

/** Encrypts a plaintext string, returning a single storable string:
 * base64(iv):base64(authTag):base64(ciphertext). */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/** Reverses encrypt(). Throws if the value is malformed or the auth tag
 * doesn't verify (wrong key, or the ciphertext was tampered with/corrupted). */
export function decrypt(stored: string): string {
  const key = getKey();
  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted credential value (expected iv:authTag:ciphertext).");
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
