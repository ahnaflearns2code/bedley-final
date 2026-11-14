import { ObjectId } from "mongodb";
import { C, getDb } from "./db";
import { decrypt } from "./encryption";
import { callAndSay, sendSms, SendResult } from "./integrations/twilio";
import { sendEmail } from "./integrations/email";

export type Channel = "in_app" | "sms" | "whatsapp" | "email" | "call";

export interface Sender {
  type: "user" | "agent" | "system" | "external";
  id: string;
  name: string;
  role?: string;
}

export async function getOrCreateConversation(orgId: ObjectId, tenantId: ObjectId) {
  const db = await getDb();
  const r = await db.collection(C.conversations).findOneAndUpdate(
    { orgId, tenantId },
    { $setOnInsert: { orgId, tenantId, createdAt: new Date() }, $set: { updatedAt: new Date() } },
    { upsert: true, returnDocument: "after" }
  );
  return r!;
}

/**
 * Stores the message in the unified thread (always) and, for non-in-app channels,
 * delivers it externally. Respects the tenant's opt-ins: no SMS/WhatsApp without opt-in.
 */
export async function postMessage(opts: {
  orgId: ObjectId;
  tenantId: ObjectId;
  body: string;
  sender: Sender;
  channel: Channel;
  direction?: "outbound" | "inbound";
  ticketId?: ObjectId;
}): Promise<{ messageId: ObjectId; delivery: SendResult | null }> {
  const db = await getDb();
  const convo = await getOrCreateConversation(opts.orgId, opts.tenantId);
  let delivery: SendResult | null = null;
  const direction = opts.direction ?? "outbound";
  const messageId = new ObjectId();

  // Only outbound-to-tenant messages are delivered externally (landlord/agent → tenant).
  if (direction === "outbound" && opts.channel !== "in_app" && opts.sender.role !== "tenant") {
    const tenant = await db.collection(C.tenants).findOne({ _id: opts.tenantId, orgId: opts.orgId });
    if (!tenant) throw new Error("Tenant not found");
    if (opts.channel === "call") {
      const phone = tenant.phoneEnc ? await decrypt(tenant.phoneEnc) : null;
      if (!phone) delivery = { status: "failed", detail: "Tenant has no phone number in their details." };
      else if (tenant.optIn?.call === false) delivery = { status: "failed", detail: "Tenant turned off phone calls." };
      else
        delivery = await callAndSay(
          phone,
          /^hi\b/i.test(opts.body) ? opts.body : `Hi ${String(tenant.name).split(" ")[0]}, this is Bedley, your building's maintenance assistant. ${opts.body}`,
          `/api/voice/say?m=${messageId}`
        );
    } else if (opts.channel === "sms" || opts.channel === "whatsapp") {
      const optedIn = opts.channel === "sms" ? tenant.optIn?.sms : tenant.optIn?.whatsapp;
      if (!optedIn) delivery = { status: "failed", detail: `Tenant has not opted in to ${opts.channel}.` };
      else {
        const phone = await decrypt(tenant.phoneEnc);
        delivery = phone ? await sendSms(phone, opts.body, opts.channel) : { status: "failed", detail: "No phone on file." };
      }
    } else if (opts.channel === "email") {
      delivery = await sendEmail(tenant.email, `Message from ${opts.sender.name}`, opts.body);
    }
  }

  const r = await db.collection(C.messages).insertOne({
    _id: messageId,
    orgId: opts.orgId,
    conversationId: convo._id,
    tenantId: opts.tenantId,
    ticketId: opts.ticketId,
    channel: opts.channel,
    direction,
    sender: opts.sender,
    body: opts.body,
    delivery,
    readBy: [opts.sender.id],
    ts: new Date(),
  });
  await db.collection(C.conversations).updateOne({ _id: convo._id }, { $set: { updatedAt: new Date(), lastMessage: opts.body.slice(0, 140) } });
  return { messageId: r.insertedId, delivery };
}

/** Agent/system notifications go to in-app plus the tenant's preferred external channel. */
export async function notifyTenant(orgId: ObjectId, tenantId: ObjectId, body: string, sender: Sender, ticketId?: ObjectId) {
  const db = await getDb();
  const tenant = await db.collection(C.tenants).findOne({ _id: tenantId, orgId });
  const raw: Channel = tenant?.preferredChannel || "in_app";
  // Phone calls to tenants need an upgraded Twilio account; otherwise the update is delivered in the app.
  const pref: Channel = raw === "call" && process.env.TWILIO_CUSTOM_CALLS !== "1" ? "in_app" : raw;
  // One stored message (always visible in the in-app thread) + external delivery on the preferred channel.
  const r = await postMessage({ orgId, tenantId, body, sender, channel: pref, ticketId });
  return { messageId: r.messageId, external: r.delivery, channel: pref };
}
