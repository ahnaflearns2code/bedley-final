import { C, getDb } from "@/lib/db";
import { validateTwilioSignature } from "@/lib/integrations/twilio";

export const runtime = "nodejs";

/**
 * Twilio delivery callbacks upgrade an audit entry from "sent" (Twilio accepted it)
 * to "confirmed" (delivered) or "failed" — the difference between an action that was
 * only sent and one that actually took effect.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const url = base ? `${base}/api/webhooks/twilio/status` : req.url;
  if (!validateTwilioSignature(req.headers.get("x-twilio-signature"), url, params)) return new Response("Invalid signature", { status: 403 });

  const sid = params.MessageSid || params.CallSid;
  const raw = params.MessageStatus || params.CallStatus;
  const mapped = ["delivered", "read", "completed"].includes(raw) ? "confirmed" : ["failed", "undelivered", "busy", "no-answer", "canceled"].includes(raw) ? "failed" : null;
  if (!sid || !mapped) return new Response("ok");

  const db = await getDb();
  await db.collection(C.audit).updateMany(
    { "result.providerId": sid },
    { $set: { "result.status": mapped, "result.providerStatus": raw, resultAt: new Date() } }
  );
  await db.collection(C.tickets).updateMany({ "contacts.sid": sid }, { $set: { "contacts.$[c].status": mapped } }, { arrayFilters: [{ "c.sid": sid }] });
  await db.collection(C.messages).updateMany({ "delivery.providerId": sid }, { $set: { "delivery.status": mapped, "delivery.detail": raw } });
  if (params.CallSid) await db.collection(C.calls).updateOne({ providerId: sid }, { $set: { status: raw, durationSec: Number(params.CallDuration || 0), endedAt: new Date() } });
  return new Response("ok");
}
