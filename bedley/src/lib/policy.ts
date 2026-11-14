import { ObjectId } from "mongodb";
import { C, getDb } from "./db";
import { DEFAULT_POLICY, PolicyDoc } from "./policy-core";

export async function loadPolicy(orgId: ObjectId): Promise<PolicyDoc> {
  const db = await getDb();
  const p = await db.collection(C.policies).find({ orgId }).sort({ version: -1 }).limit(1).next();
  if (!p) return DEFAULT_POLICY;
  return {
    version: p.version,
    killSwitch: !!p.killSwitch,
    spendingLimitCents: p.spendingLimitCents,
    hardCapCents: p.hardCapCents,
    maxContractorsContacted: p.maxContractorsContacted ?? 5,
    autoBookMinor: p.autoBookMinor !== false,
    tools: { ...DEFAULT_POLICY.tools, ...(p.tools || {}) },
  };
}

/** Policies are append-only: every change is a new version, so audits can cite the exact rule set in force. */
export async function savePolicy(orgId: ObjectId, next: Omit<PolicyDoc, "version">, changedBy: string) {
  const db = await getDb();
  const cur = await loadPolicy(orgId);
  const doc = { orgId, ...next, version: cur.version + 1, changedBy, createdAt: new Date() };
  await db.collection(C.policies).insertOne(doc);
  return doc.version;
}
