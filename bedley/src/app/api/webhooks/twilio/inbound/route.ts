import { C, getDb } from "@/lib/db";
import { encryptDeterministic, normalizePhone } from "@/lib/encryption";
import { validateTwilioSignature } from "@/lib/integrations/twilio";
import { postMessage } from "@/lib/messaging";
import { writeAudit } from "@/lib/audit";

export const runtime = "nodejs";

const twiml = (msg?: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${msg}</Message>` : ""}</Response>`, { headers: { "Content-Type": "text/xml" } });

function publicUrl(req: Request) {
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const u = new URL(req.url);
  return base ? `${base}${u.pathname}${u.search}` : req.url;
}

/**
 * Inbound SMS / WhatsApp. Two kinds of senders:
 *  1. Contractors replying to a quote request ("Q2 $180 tomorrow 10am") → quote attached to ticket.
 *  2. Tenants texting the platform number → message lands in their thread.
 * Unknown numbers are quarantined, never attached to anyone's thread.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  if (process.env.TWILIO_AUTH_TOKEN && !validateTwilioSignature(req.headers.get("x-twilio-signature"), publicUrl(req), params)) {
    return new Response("Invalid signature", { status: 403 });
  }
  const isWhatsApp = params.From?.startsWith("whatsapp:");
  const from = normalizePhone((params.From || "").replace("whatsapp:", ""));
  const body = (params.Body || "").trim();
  const db = await getDb();

  // 1. Contractor quote reply — match the most recent outbound quote request to this number
  const ticket = await db.collection(C.tickets).find({ "contacts.to": from }).sort({ updatedAt: -1 }).limit(1).next();
  if (ticket) {
    const codeMatch = body.match(/\bQ(\d+)\b/i);
    const contact =
      (codeMatch && ticket.contacts.find((c: any) => c.code.toUpperCase() === `Q${codeMatch[1]}`)) ||
      [...ticket.contacts].reverse().find((c: any) => c.to === from);
    const amount = body.replace(/\bQ\d+\b/i, "").match(/\$?\s?(\d{2,5}(?:\.\d{2})?)/);
    const quote = {
      contractorId: contact.contractorId,
      amountCents: amount ? Math.round(parseFloat(amount[1]) * 100) : null,
      availability: body.replace(/\bQ\d+\b/i, "").replace(amount?.[0] ?? "", "").trim().slice(0, 120),
      raw: body.slice(0, 500),
      source: isWhatsApp ? "whatsapp_reply" : "sms_reply",
      kind: "verbal_estimate",
      receivedAt: new Date(),
    };
    await db.collection(C.tickets).updateOne({ _id: ticket._id }, { $push: { quotes: quote } as any, $set: { updatedAt: new Date() } });
    await writeAudit({
      orgId: ticket.orgId,
      ticketId: ticket._id,
      runId: ticket.agentRunId,
      actor: { type: "provider", id: "twilio", name: "Contractor reply (SMS)" },
      action: "quote.received",
      input: quote,
      result: { status: "confirmed", providerId: params.MessageSid },
    });
    return twiml("Thanks — your quote was passed to the property manager.");
  }

  // 2. Tenant texting in
  const phoneEnc = await encryptDeterministic(from);
  const tenant = await db.collection(C.tenants).findOne({ phoneEnc });
  if (tenant) {
    if (/^stop$/i.test(body)) {
      await db.collection(C.tenants).updateOne({ _id: tenant._id }, { $set: { [`optIn.${isWhatsApp ? "whatsapp" : "sms"}`]: false } });
      return twiml();
    }
    await postMessage({
      orgId: tenant.orgId,
      tenantId: tenant._id,
      body,
      channel: isWhatsApp ? "whatsapp" : "sms",
      direction: "inbound",
      sender: { type: "user", id: String(tenant.userId), name: tenant.name, role: "tenant" },
    });
    return twiml();
  }

  await db.collection("quarantined_messages").insertOne({ fromLast4: from.slice(-4), channel: isWhatsApp ? "whatsapp" : "sms", receivedAt: new Date(), sid: params.MessageSid });
  return twiml();
}
