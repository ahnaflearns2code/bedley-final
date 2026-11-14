/**
 * Places ONE test call so you can hear what your Twilio account allows.
 *   npm run test-call -- +14166174686 inline     (the AI's own words — what we want)
 *   npm run test-call -- +14166174686 template   (Twilio's trial template — always works on trial)
 */
import twilio from "twilio";

const [to, mode = "inline"] = process.argv.slice(2);
if (!to) {
  console.log("Usage: npm run test-call -- +1YOURNUMBER inline|template");
  process.exit(1);
}
const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_PHONE_NUMBER: from } = process.env;
if (!sid || !tok || !from) {
  console.log("Twilio keys missing in .env");
  process.exit(1);
}
const client = twilio(sid, tok);
const params: Record<string, string> =
  mode === "template"
    ? { url: "https://webhooks.twilio.com/v1/Voice/Template/voice_speech_recognition" }
    : { twiml: '<Response><Pause length="1"/><Say voice="Polly.Joanna">Hi, this is the Bedley A.I. property assistant. If you can hear this sentence, custom calls work on your Twilio account. Goodbye.</Say></Response>' };

client.calls
  .create({ to, from, ...params } as any)
  .then((c) => console.log(`✅ Twilio accepted the ${mode} call (${c.sid}). Answer the phone and listen.\n   If you hear "If you can hear this sentence, custom calls work" — the AI's own words work.`))
  .catch((e) => console.log(`❌ Twilio rejected the ${mode} call: ${e.message}`));
