import { ObjectId } from "mongodb";
import { applyApprovalDecision } from "@/lib/approvals";
import { speak } from "@/lib/integrations/elevenlabs";
import { validateTwilioSignature } from "@/lib/integrations/twilio";
import { C, getDb } from "@/lib/db";

export const runtime = "nodejs";

const xml = (b: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${b}</Response>`, { headers: { "Content-Type": "text/xml" } });

/** Landlord pressed a key: 1 = approve, 2 = decline. Same audited code path as the dashboard button. */
export async function POST(req: Request) {
  const form = await req.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const u = new URL(req.url);
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!validateTwilioSignature(req.headers.get("x-twilio-signature"), `${base}${u.pathname}${u.search}`, params)) return new Response("Invalid signature", { status: 403 });
  const a = u.searchParams.get("a") || "";
  const uid = u.searchParams.get("u") || "";
  if (!ObjectId.isValid(a) || !ObjectId.isValid(uid)) return xml("<Hangup/>");
  const db = await getDb();
  const landlord = await db.collection(C.users).findOne({ _id: new ObjectId(uid), role: "landlord" });
  const approval = await db.collection(C.approvals).findOne({ _id: new ObjectId(a) });
  if (!landlord || !approval || String(approval.orgId) !== String(landlord.orgId)) return xml("<Hangup/>");

  const digit = params.Digits;
  if (digit !== "1" && digit !== "2") return xml(`${await speak("Sorry, that wasn't 1 or 2. Please use the dashboard. Goodbye.")}<Hangup/>`);
  const decision = digit === "1" ? "approved" : "rejected";
  const r = await applyApprovalDecision({
    approvalId: approval._id,
    orgId: approval.orgId,
    decision,
    by: { userId: String(landlord._id), name: landlord.name },
    via: "phone",
  });
  if (!r.ok) return xml(`${await speak("This request was already handled. Goodbye.")}<Hangup/>`);
  return xml(
    `${await speak(decision === "approved" ? "Approved. I'll book the contractor and let the tenant know. Goodbye." : "Declined. The request is back in your dashboard. Goodbye.")}<Hangup/>`
  );
}
