import { ObjectId } from "mongodb";
import { C, getDb } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { validateTwilioSignature } from "@/lib/integrations/twilio";

export const runtime = "nodejs";

/** TwiML for a masked call: after the landlord answers, dial the tenant using the platform number as caller ID. */
export async function POST(req: Request) {
  const form = await req.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const u = new URL(req.url);
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!validateTwilioSignature(req.headers.get("x-twilio-signature"), `${base}${u.pathname}${u.search}`, params)) {
    return new Response("Invalid signature", { status: 403 });
  }
  const c = u.searchParams.get("c");
  const db = await getDb();
  const convo = c && ObjectId.isValid(c) ? await db.collection(C.conversations).findOne({ _id: new ObjectId(c) }) : null;
  const tenant = convo ? await db.collection(C.tenants).findOne({ _id: convo.tenantId }) : null;
  const phone = tenant?.phoneEnc ? await decrypt(tenant.phoneEnc) : null;
  const xml = phone
    ? `<Response><Say voice="Polly.Joanna">Connecting you to your tenant through Bedley. This call is not recorded.</Say><Dial callerId="${process.env.TWILIO_PHONE_NUMBER}" record="do-not-record">${phone}</Dial></Response>`
    : `<Response><Say>Sorry, we could not find a phone number for this tenant.</Say></Response>`;
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${xml}`, { headers: { "Content-Type": "text/xml" } });
}
