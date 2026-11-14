import { ObjectId } from "mongodb";
import { YES, NO, answer } from "@/lib/conversation";
import { applyApprovalDecision, approvalSummary } from "@/lib/approvals";
import { validateTwilioSignature } from "@/lib/integrations/twilio";
import { writeAudit } from "@/lib/audit";
import { C, getDb } from "@/lib/db";

export const runtime = "nodejs";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const say = (t: string) => `<Say voice="Polly.Joanna">${esc(t)}</Say>`;
const xml = (b: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${b}</Response>`, { headers: { "Content-Type": "text/xml" } });

/** One turn of the landlord phone conversation. Twilio posts what they said (SpeechResult) or pressed (Digits). */
export async function POST(req: Request) {
  const form = await req.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const u = new URL(req.url);
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!validateTwilioSignature(req.headers.get("x-twilio-signature"), `${base}${u.pathname}${u.search}`, params)) return new Response("Invalid signature", { status: 403 });

  const a = u.searchParams.get("a") || "";
  const uid = u.searchParams.get("u") || "";
  const turn = Number(u.searchParams.get("turn") || "1");
  if (!ObjectId.isValid(a) || !ObjectId.isValid(uid)) return xml("<Hangup/>");
  const db = await getDb();
  const landlord = await db.collection(C.users).findOne({ _id: new ObjectId(uid), role: "landlord" });
  const sum = await approvalSummary(new ObjectId(a));
  if (!landlord || !sum || String(sum.approval.orgId) !== String(landlord.orgId)) return xml("<Hangup/>");
  if (sum.approval.status !== "pending") return xml(say("This one's already been handled. Thanks, goodbye.") + "<Hangup/>");

  const heard = (params.SpeechResult || "").trim();
  const digit = params.Digits;
  await writeAudit({
    orgId: sum.approval.orgId,
    ticketId: sum.approval.ticketId,
    runId: sum.approval.runId,
    actor: { type: "user", id: String(landlord._id), name: `${landlord.name} (phone)` },
    action: "landlord.said",
    input: { heard, digit, turn },
    result: { status: "confirmed" },
  });

  const decide = async (decision: "approved" | "rejected") => {
    await applyApprovalDecision({
      approvalId: sum.approval._id,
      orgId: sum.approval.orgId,
      decision,
      by: { userId: String(landlord._id), name: landlord.name },
      via: "phone",
      note: heard ? `Said on the phone: "${heard}"` : `Pressed ${digit}`,
    });
  };

  const tenantFirst = String(sum.tenant?.name ?? "your tenant").split(" ")[0];
  if (digit === "1" || (!digit && YES.test(heard) && !NO.test(heard.replace(/no problem/i, "")))) {
    await decide("approved");
    return xml(say(`Great, I'm booking ${sum.contractor?.name ?? "them"} for ${sum.approval.input.proposed_window ?? "the earliest time"}. I'll let ${tenantFirst} know right away, and you'll get a summary in your dashboard. Thanks, goodbye.`) + "<Hangup/>");
  }
  if (digit === "2" || (!digit && NO.test(heard))) {
    await decide("rejected");
    return xml(say(`No problem, I won't book anyone. The request is waiting in your dashboard if you want to pick a different contractor. Goodbye.`) + "<Hangup/>");
  }
  if (turn >= 5 || (!heard && !digit)) {
    return xml(say("I'll leave this in your Bedley dashboard so you can decide there. Thanks, goodbye.") + "<Hangup/>");
  }

  const reply = await answer(heard, sum.text);
  const next = `${base}/api/voice/landlord?a=${a}&amp;u=${uid}&amp;turn=${turn + 1}`;
  return xml(
    say(reply) +
      `<Gather input="speech dtmf" numDigits="1" speechTimeout="auto" timeout="8" language="en-CA" action="${next}" method="POST">${say("Should I go ahead and book them?")}</Gather>` +
      say("I'll leave this in your dashboard. Goodbye.") +
      "<Hangup/>"
  );
}
