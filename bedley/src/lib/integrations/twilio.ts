import twilio from "twilio";
import { normalizePhone } from "../encryption";

export interface SendResult {
  status: "sent" | "simulated" | "failed";
  providerId?: string;
  detail?: string;
  to?: string;
}

export const twilioConfigured = () =>
  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

function client() {
  return twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
}

const base = () => (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const isPublicBase = () => !/localhost|127\.0\.0\.1/.test(base());

/**
 * Contractors you saved yourself are contacted on the number in your directory.
 * Businesses found on Google are real companies, so while DEMO_CONTRACTOR_PHONE is set
 * their calls go to that demo phone instead of the actual business.
 */
export function contractorDestination(c: Record<string, any> | null | undefined): { to: string | null; redirected: boolean } {
  const demo = process.env.DEMO_CONTRACTOR_PHONE;
  if (c?.source === "google_places" && demo) return { to: normalizePhone(demo), redirected: true };
  return { to: c?.phone ? normalizePhone(c.phone) : null, redirected: false };
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Phone call that speaks a message. With a public URL the app serves TwiML (ElevenLabs voice);
 * without one, Twilio gets inline TwiML with its built-in voice — so calls still work on localhost.
 */
export async function callAndSay(
  to: string,
  text: string,
  twimlPath?: string,
  gather?: { action: string; prompt: string; input?: "dtmf" | "speech dtmf" },
  opts: { allowTemplate?: boolean } = {}
): Promise<SendResult> {
  const say = `<Say voice="Polly.Joanna">${xmlEsc(text)}</Say>`;
  const inline =
    gather && isPublicBase()
      ? `<Response><Pause length="1"/>${say}<Gather input="${gather.input ?? "dtmf"}" numDigits="1" speechTimeout="auto" timeout="8" language="en-CA" action="${xmlEsc(base() + gather.action)}" method="POST"><Say voice="Polly.Joanna">${xmlEsc(gather.prompt)}</Say></Gather><Say voice="Polly.Joanna">I didn't hear an answer. You can approve it in the Bedley dashboard. Goodbye.</Say><Hangup/></Response>`
      : `<Response><Pause length="1"/>${say}<Pause length="1"/>${say}<Hangup/></Response>`;
  return smartCall(to, { url: twimlPath ? `${base()}${twimlPath}` : undefined, twiml: inline, template: gather ? "voice_keyboard_input" : "voice_text_to_speech", allowTemplate: opts.allowTemplate });
}

export async function sendSms(to: string, body: string, channel: "sms" | "whatsapp" = "sms"): Promise<SendResult> {
  if (!twilioConfigured()) return { status: "simulated", detail: "Twilio credentials not set — message not sent.", to };
  if (channel === "whatsapp" && !process.env.TWILIO_WHATSAPP_NUMBER)
    return { status: "simulated", detail: "TWILIO_WHATSAPP_NUMBER not set.", to };
  try {
    const msg = await client().messages.create({
      to: channel === "whatsapp" ? `whatsapp:${to}` : to,
      from: channel === "whatsapp" ? process.env.TWILIO_WHATSAPP_NUMBER! : process.env.TWILIO_PHONE_NUMBER!,
      body,
      ...(isPublicBase() ? { statusCallback: `${base()}/api/webhooks/twilio/status` } : {}),
    });
    return { status: "sent", providerId: msg.sid, detail: `Twilio accepted (${msg.status})`, to };
  } catch (e) {
    return { status: "failed", detail: (e as Error).message, to };
  }
}

export const publicBaseUrl = () => (isPublicBase() ? base() : null);

/**
 * Twilio trial accounts restrict what a call may do. Every call tries, in order:
 *   1. our own server's TwiML (url)      — full AI conversation, ElevenLabs voice
 *   2. inline TwiML (twiml)              — AI's own words, can still listen via <Gather action>
 *   3. a Twilio trial template (url)     — always allowed on trial; the phone still rings
 * The first one Twilio accepts wins. A mode that Twilio rejects is skipped for later calls.
 */
const TEMPLATE_BASE = "https://webhooks.twilio.com/v1/Voice/Template/";
const g = globalThis as unknown as { __twilioBlocked?: Set<string> };
const blocked = (g.__twilioBlocked ??= new Set<string>());

export async function smartCall(
  to: string,
  opts: { url?: string; twiml?: string; template?: "voice_text_to_speech" | "voice_speech_recognition" | "voice_keyboard_input"; allowTemplate?: boolean }
): Promise<SendResult> {
  if (!twilioConfigured()) return { status: "simulated", detail: "Twilio not connected — call not placed.", to };
  // Free Twilio trial: custom words are blocked, so default to Twilio's trial template (it always rings).
  // After upgrading Twilio, set TWILIO_CUSTOM_CALLS=1 so calls speak Bedley's own words.
  const templateOnly = process.env.TWILIO_TRIAL_TEMPLATES_ONLY === "1" || (opts.allowTemplate && process.env.TWILIO_CUSTOM_CALLS !== "1");
  const status = isPublicBase() ? { statusCallback: `${base()}/api/webhooks/twilio/status`, statusCallbackEvent: ["completed"] } : {};
  const attempts: Array<[string, Record<string, unknown>]> = [];
  if (opts.url && isPublicBase() && !templateOnly && !blocked.has("url")) attempts.push(["url", { url: opts.url }]);
  if (opts.twiml && !templateOnly && !blocked.has("twiml")) attempts.push(["twiml", { twiml: opts.twiml }]);
  // Twilio's generic trial template doesn't carry Bedley's words, so it's off unless explicitly enabled.
  if (templateOnly || opts.allowTemplate || process.env.TWILIO_TEMPLATE_FALLBACK === "1") attempts.push(["template", { url: TEMPLATE_BASE + (opts.template ?? "voice_text_to_speech") }]);

  const errors: string[] = [];
  for (const [mode, p] of attempts) {
    try {
      const call = await client().calls.create({ to, from: process.env.TWILIO_PHONE_NUMBER!, ...p, ...status } as any);
      console.log(`[twilio] call to …${to.slice(-4)} placed (${mode}) sid=${call.sid} status=${call.status}`);
      const masked = `${to.slice(0, -4).replace(/\d/g, "•")}${to.slice(-4)}`;
      const how =
        mode === "template"
          ? "Twilio trial template (upgrade Twilio for the AI's own words)"
          : mode === "url"
          ? "AI voice"
          : "AI message";
      return { status: "sent", providerId: call.sid, detail: `Calling ${masked} · ${how}`, to };
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`[twilio] call to …${to.slice(-4)} REJECTED (${mode}): ${msg}`);
      errors.push(`${mode}: ${msg}`);
      // Only remember rejections that look like trial/content restrictions, not bad numbers.
      if (mode !== "template" && /trial|not (allowed|supported|permitted)|template|21\d{3}/i.test(msg) && !/unverified|not a valid phone/i.test(msg)) blocked.add(mode);
      if (/unverified|not a valid phone|is not verified/i.test(msg)) break; // same answer for every mode
    }
  }
  return { status: "failed", detail: errors.join(" | "), to };
}

/** Outbound interactive AI call (contractor quote): Twilio fetches TwiML from our server. */
export async function placeVoiceCall(to: string, twimlUrl: string, fallbackText?: string, gatherAction?: string): Promise<SendResult> {
  const inline = fallbackText
    ? `<Response><Pause length="1"/><Say voice="Polly.Joanna">${xmlEsc(fallbackText)}</Say>` +
      (gatherAction
        ? `<Gather input="speech" action="${xmlEsc(gatherAction)}" method="POST" speechTimeout="auto" timeout="8" language="en-CA"><Say voice="Polly.Joanna">Please tell me your price and when you can come.</Say></Gather>`
        : "") +
      `<Say voice="Polly.Joanna">Thank you. Goodbye.</Say><Hangup/></Response>`
    : undefined;
  return smartCall(to, { url: twimlUrl, twiml: inline, template: "voice_speech_recognition" });
}

/** Masked call: Twilio rings `firstLeg`, then bridges to `secondLeg`. Neither sees the other's number. */
export async function startBridgedCall(firstLeg: string, secondLeg: string, conversationId: string): Promise<SendResult> {
  if (!twilioConfigured()) return { status: "simulated", detail: "Twilio credentials not set — call not placed." };
  if (!isPublicBase()) return { status: "failed", detail: "APP_BASE_URL must be a public URL (ngrok) for Twilio to fetch call instructions." };
  try {
    const url = `${base()}/api/twilio/bridge?c=${encodeURIComponent(conversationId)}`;
    const call = await client().calls.create({
      to: firstLeg,
      from: process.env.TWILIO_PHONE_NUMBER!,
      url,
      statusCallback: `${base()}/api/webhooks/twilio/status`,
      statusCallbackEvent: ["completed"],
    });
    // second leg is resolved server-side in the bridge route from the conversation; never passed via URL
    void secondLeg;
    return { status: "sent", providerId: call.sid, detail: `Calling (${call.status})` };
  } catch (e) {
    return { status: "failed", detail: (e as Error).message };
  }
}

export function validateTwilioSignature(signature: string | null, url: string, params: Record<string, string>) {
  if (!process.env.TWILIO_AUTH_TOKEN || !signature) return false;
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, params);
}
