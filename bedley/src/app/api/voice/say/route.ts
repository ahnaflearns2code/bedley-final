import { ObjectId } from "mongodb";
import { C, getDb } from "@/lib/db";
import { speak } from "@/lib/integrations/elevenlabs";
import { validateTwilioSignature } from "@/lib/integrations/twilio";

export const runtime = "nodejs";

const xml = (b: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${b}</Response>`, { headers: { "Content-Type": "text/xml" } });

/** Reads a tenant notification aloud (ElevenLabs voice). */
export async function POST(req: Request) {
  const form = await req.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const u = new URL(req.url);
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!validateTwilioSignature(req.headers.get("x-twilio-signature"), `${base}${u.pathname}${u.search}`, params)) return new Response("Invalid signature", { status: 403 });
  const m = u.searchParams.get("m") || "";
  if (!ObjectId.isValid(m)) return xml("<Hangup/>");
  const db = await getDb();
  let msg = await db.collection(C.messages).findOne({ _id: new ObjectId(m) });
  if (!msg) {
    await new Promise((r) => setTimeout(r, 1200));
    msg = await db.collection(C.messages).findOne({ _id: new ObjectId(m) });
  }
  if (!msg) return xml("<Hangup/>");
  const tenant = await db.collection(C.tenants).findOne({ _id: msg.tenantId });
  const text = /^hi\b/i.test(msg.body) ? msg.body : `Hi ${String(tenant?.name ?? "there").split(" ")[0]}, this is Bedley, your building's maintenance assistant. ${msg.body}`;
  return xml(`<Pause length="1"/>${await speak(text)}<Pause length="1"/>${await speak("You can see all the details in the Bedley app. Goodbye.")}<Hangup/>`);
}
