import { Binary, ClientEncryption } from "mongodb";
import { getClient } from "./db";

/**
 * MongoDB Client-Side Field Level Encryption (explicit mode).
 *
 * Sensitive fields (SIN, DOB, government ID, phone) are encrypted in the app
 * process BEFORE they are sent to Atlas. Atlas only ever stores BSON Binary
 * subtype 6 ciphertext. The data key lives in the key vault collection,
 * wrapped by a master key (local KMS for the hackathon; swap for AWS/GCP/Azure KMS
 * in production by changing kmsProviders).
 *
 * - Random algorithm: SIN, DOB, ID numbers (never queried)
 * - Deterministic algorithm: phone numbers (equality lookups for inbound SMS/WhatsApp)
 */

export const KEY_VAULT_NS = "encryption.__keyVault";
export const KEY_ALT_NAME = "tenant-pii";
const RANDOM = "AEAD_AES_256_CBC_HMAC_SHA_512-Random" as const;
const DETERMINISTIC = "AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic" as const;

let _ce: Promise<ClientEncryption> | null = null;

function kmsProviders() {
  const key = process.env.ENCRYPTION_MASTER_KEY;
  if (!key) throw new Error("ENCRYPTION_MASTER_KEY is not set (openssl rand -base64 96).");
  const buf = Buffer.from(key, "base64");
  if (buf.length !== 96) throw new Error(`ENCRYPTION_MASTER_KEY must decode to 96 bytes (got ${buf.length}).`);
  return { local: { key: buf } };
}

export async function getClientEncryption(): Promise<ClientEncryption> {
  if (!_ce) {
    _ce = (async () => {
      const client = await getClient();
      return new ClientEncryption(client, { keyVaultNamespace: KEY_VAULT_NS, kmsProviders: kmsProviders() });
    })();
  }
  return _ce;
}

/** Creates the key vault index + data key if missing. Safe to call repeatedly. */
export async function ensureDataKey() {
  const client = await getClient();
  const [db, coll] = KEY_VAULT_NS.split(".");
  const kv = client.db(db).collection(coll);
  await kv.createIndex({ keyAltNames: 1 }, { unique: true, partialFilterExpression: { keyAltNames: { $exists: true } } });
  const existing = await kv.findOne({ keyAltNames: KEY_ALT_NAME });
  if (existing) return existing._id;
  const ce = await getClientEncryption();
  return ce.createDataKey("local", { keyAltNames: [KEY_ALT_NAME] });
}

export async function encryptRandom(value: string): Promise<Binary> {
  const ce = await getClientEncryption();
  return ce.encrypt(value, { keyAltName: KEY_ALT_NAME, algorithm: RANDOM });
}

export async function encryptDeterministic(value: string): Promise<Binary> {
  const ce = await getClientEncryption();
  return ce.encrypt(value, { keyAltName: KEY_ALT_NAME, algorithm: DETERMINISTIC });
}

export async function decrypt(value: Binary | null | undefined): Promise<string | null> {
  if (!value) return null;
  const ce = await getClientEncryption();
  return (await ce.decrypt(value)) as string;
}

/** Normalise phone to E.164-ish so deterministic ciphertext matches. */
export function normalizePhone(p: string): string {
  const digits = p.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return digits;
}

export function maskSin(last3?: string | null) {
  return last3 ? `*** *** ${last3}` : "Not provided";
}
