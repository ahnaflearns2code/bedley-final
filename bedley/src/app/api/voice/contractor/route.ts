import { ObjectId } from "mongodb";
import { C, getDb } from "@/lib/db";
import { speak } from "@/lib/integrations/elevenlabs";
import { validateTwilioSignature } from "@/lib/integrations/twilio";

export const runtime = "nodejs";

const xml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "Content-Type": "text/xml" } });

function signedUrl(req: Request) {
  const u = new URL(req.url);
  return `${(process.env.APP_BASE_URL || "").replace(/\/$/, "")}${u.pathname}${u.search}`;
}

/**
 * TwiML for the AI quote call. The agent introduces itself as an AI (ElevenLabs voice),
 * describes the job, then listens (Twilio speech recognition) for price + availability.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  if (!validateTwilioSignature(req.headers.get("x-twilio-signature"), signedUrl(req), params)) return new Response("Invalid signature", { status: 403 });

  const u = new URL(req.url);
  const t = u.searchParams.get("t") || "";
  const code = u.searchParams.get("c") || "";
  if (!ObjectId.isValid(t) || !/^Q\d+$/.test(code)) return xml("<Hangup/>");
  const db = await getDb();
  const ticket = await db.collection(C.tickets).findOne({ _id: new ObjectId(t) });
  const script = ticket?.callScripts?.[code];
  if (!script) return xml("<Hangup/>");

  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const action = `${base}/api/voice/quote?t=${t}&amp;c=${code}`;
  const intro = await speak(
    `Hi, this is an automated A.I. assistant calling on behalf of ${script.org}, a property manager in Toronto. ` +
      `We have a repair job: ${script.job}`
  );
  const ask = await speak("Could you tell me your price estimate, including any call-out fee, and your earliest availability? Go ahead whenever you're ready.");
  const noAnswer = await speak("Sorry, I didn't catch that. We'll follow up by text. Thank you, goodbye.");
  return xml(
    `${intro}<Gather input="speech" action="${action}" method="POST" speechTimeout="auto" timeout="8" language="en-CA">${ask}</Gather>${noAnswer}<Hangup/>`
  );
}
