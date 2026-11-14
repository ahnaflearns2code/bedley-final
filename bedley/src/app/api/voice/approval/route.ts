import { ObjectId } from "mongodb";
import { approvalSummary } from "@/lib/approvals";
import { speak } from "@/lib/integrations/elevenlabs";
import { validateTwilioSignature } from "@/lib/integrations/twilio";
import { C, getDb } from "@/lib/db";

export const runtime = "nodejs";

const xml = (b: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${b}</Response>`, { headers: { "Content-Type": "text/xml" } });

/** The agent phones the landlord: summary of the repair + "press 1 to approve, 2 to decline". */
export async function POST(req: Request) {
  const form = await req.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const u = new URL(req.url);
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!validateTwilioSignature(req.headers.get("x-twilio-signature"), `${base}${u.pathname}${u.search}`, params)) return new Response("Invalid signature", { status: 403 });
  const a = u.searchParams.get("a") || "";
  const uid = u.searchParams.get("u") || "";
  if (!ObjectId.isValid(a) || !ObjectId.isValid(uid)) return xml("<Hangup/>");
  const sum = await approvalSummary(new ObjectId(a));
  if (!sum || sum.approval.status !== "pending") return xml(`${await speak("This request has already been handled. Goodbye.")}<Hangup/>`);
  const db = await getDb();
  const landlord = await db.collection(C.users).findOne({ _id: new ObjectId(uid), orgId: sum.approval.orgId, role: "landlord" });
  if (!landlord) return xml("<Hangup/>");

  const action = `${base}/api/voice/approval/decide?a=${a}&amp;u=${uid}`;
  const intro = await speak(`Hi ${String(landlord.name).split(" ")[0]}, this is your Bedley. ${sum.text}`);
  const ask = await speak("Press 1 to approve this booking. Press 2 to decline.");
  const bye = await speak("I didn't get an answer. You can approve it in the Bedley dashboard. Goodbye.");
  return xml(`${intro}<Gather input="dtmf" numDigits="1" timeout="8" action="${action}" method="POST">${ask}</Gather>${bye}<Hangup/>`);
}
