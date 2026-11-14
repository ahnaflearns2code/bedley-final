import type Stripe from "stripe";
import { ObjectId } from "mongodb";
import { stripe } from "@/lib/integrations/stripe";
import { C, getClient, getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Stripe webhooks are the source of truth for payment state.
 * Signature-verified, de-duplicated by event id, and applied in a MongoDB transaction.
 */
export async function POST(req: Request) {
  const st = stripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!st || !secret) return new Response("Stripe not configured", { status: 503 });
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = st.webhooks.constructEvent(raw, req.headers.get("stripe-signature") || "", secret);
  } catch (e) {
    return new Response(`Bad signature: ${(e as Error).message}`, { status: 400 });
  }

  const db = await getDb();
  try {
    await db.collection(C.stripeEvents).insertOne({ _id: event.id as any, type: event.type, receivedAt: new Date() });
  } catch {
    return Response.json({ duplicate: true }); // already processed
  }

  if (event.type === "account.updated") {
    const acct = event.data.object as Stripe.Account;
    await db.collection(C.orgs).updateOne({ stripeAccountId: acct.id }, { $set: { stripeChargesEnabled: acct.charges_enabled } });
    return Response.json({ ok: true });
  }

  const statusMap: Record<string, string> = {
    "payment_intent.processing": "processing",
    "payment_intent.succeeded": "paid",
    "payment_intent.payment_failed": "failed",
  };
  if (!(event.type in statusMap)) return Response.json({ ignored: event.type });

  const pi = event.data.object as Stripe.PaymentIntent;
  const rentId = pi.metadata?.rentRecordId;
  const orgId = pi.metadata?.orgId;
  if (!rentId || !orgId || !ObjectId.isValid(rentId)) return Response.json({ ignored: "no metadata" });
  const status = statusMap[event.type];

  const session = (await getClient()).startSession();
  try {
    await session.withTransaction(async () => {
      const rec = await db.collection(C.rent).findOne({ _id: new ObjectId(rentId), orgId: new ObjectId(orgId) }, { session });
      if (!rec) throw new Error("rent record missing");
      if (pi.amount_received && pi.amount_received !== rec.amountCents && status === "paid") throw new Error("amount mismatch");
      await db.collection(C.payments).updateOne(
        { stripePaymentIntentId: pi.id },
        {
          $set: { status, amountCents: pi.amount, updatedAt: new Date(), lastEvent: event.id },
          $setOnInsert: { orgId: rec.orgId, rentRecordId: rec._id, tenantId: rec.tenantId, method: "stripe", createdAt: new Date() },
        },
        { upsert: true, session }
      );
      if (rec.status !== "paid") {
        await db.collection(C.rent).updateOne(
          { _id: rec._id },
          { $set: { status: status === "failed" ? "failed" : status, ...(status === "paid" ? { paidAt: new Date(), paidVia: "stripe" } : {}) } },
          { session }
        );
      }
    });
  } finally {
    await session.endSession();
  }
  await writeAudit({
    orgId: new ObjectId(orgId),
    actor: { type: "provider", id: "stripe", name: "Stripe webhook" },
    action: `payment.${status}`,
    input: { rentRecordId: rentId, amountCents: pi.amount },
    result: { status: status === "failed" ? "failed" : "confirmed", providerId: pi.id, detail: { event: event.type } },
  });
  return Response.json({ ok: true });
}
