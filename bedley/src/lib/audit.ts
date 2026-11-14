import { ObjectId } from "mongodb";
import { C, getDb } from "./db";
import { redactDeep } from "./redact";

export type ResultStatus = "pending" | "sent" | "confirmed" | "failed" | "simulated" | "blocked" | "awaiting_approval";

export interface AuditEntry {
  orgId: ObjectId;
  runId?: ObjectId;
  ticketId?: ObjectId;
  actor: { type: "agent" | "user" | "system" | "provider"; id: string; name: string };
  onBehalfOf?: { userId: string; role: string };
  action: string;
  tool?: string;
  toolUseId?: string;
  input?: unknown;
  decision?: "allowed" | "denied" | "needs_approval";
  policyRule?: string;
  policyVersion?: number;
  reason?: string;
  result?: { status: ResultStatus; detail?: unknown; providerId?: string };
}

export async function writeAudit(e: AuditEntry) {
  const db = await getDb();
  const doc = { ...e, input: redactDeep(e.input), ts: new Date() };
  const r = await db.collection(C.audit).insertOne(doc);
  return r.insertedId;
}

export async function updateAuditResult(id: ObjectId, result: AuditEntry["result"]) {
  const db = await getDb();
  await db.collection(C.audit).updateOne(
    { _id: id },
    { $set: { result: redactDeep(result), resultAt: new Date() } }
  );
}
