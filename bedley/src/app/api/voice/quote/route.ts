import { ObjectId } from "mongodb";
import { C, getDb } from "@/lib/db";
import { speak } from "@/lib/integrations/elevenlabs";
import { validateTwilioSignature } from "@/lib/integrations/twilio";
import { writeAudit } from "@/lib/audit";
import { parseAmount } from "@/lib/quotes";

export const runtime = "nodejs";

const xml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "Content-Type": "text/xml" } });

/** Twilio posts the contractor's spoken answer here (SpeechResult). */
export async function POST(req: Request) {
  const form = await req.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const u = new URL(req.url);
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!validateTwilioSignature(req.headers.get("x-twilio-signature"), `${base}${u.pathname}${u.search}`, params)) return new Response("Invalid signature", { status: 403 });

  const t = u.searchParams.get("t") || "";
  const code = u.searchParams.get("c") || "";
  if (!ObjectId.isValid(t)) return xml("<Hangup/>");
  const db = await getDb();
  const ticket = await db.collection(C.tickets).findOne({ _id: new ObjectId(t) });
  const contact = ticket?.contacts?.find((c: any) => c.code === code);
  const said = (params.SpeechResult || "").trim();
  if (!ticket || !contact) return xml("<Hangup/>");

  const amountCents = parseAmount(said);
  const availability = said.replace(/\$?\s?\d{2,5}(\.\d{1,2})?\s*(dollars|bucks)?/i, "").trim().slice(0, 120);
  const quote = {
    contractorId: contact.contractorId,
    amountCents,
    availability,
    raw: said.slice(0, 500),
    confidence: Number(params.Confidence || 0),
    source: "voice_call",
    kind: "verbal_estimate",
    receivedAt: new Date(),
  };
  await db.collection(C.tickets).updateOne({ _id: ticket._id }, { $push: { quotes: quote } as any, $set: { updatedAt: new Date() } });
  await writeAudit({
    orgId: ticket.orgId,
    ticketId: ticket._id,
    runId: ticket.agentRunId,
    actor: { type: "provider", id: "twilio", name: "Contractor (AI phone call)" },
    action: "quote.received",
    input: quote,
    result: { status: "confirmed", providerId: params.CallSid },
  });
  const reply = amountCents
    ? `Thank you. I have $${(amountCents / 100).toFixed(0)}. The property manager will confirm by text if they'd like to book. Goodbye.`
    : "Thank you, I've passed that on to the property manager. They'll follow up by text. Goodbye.";
  return xml(`${await speak(reply)}<Hangup/>`);
}
