import { Binary } from "mongodb";
import { getDb } from "../db";

/**
 * ElevenLabs text-to-speech. Generated audio is stored in MongoDB (voice_clips, TTL 1 day)
 * and served at /api/voice/audio/<id> so Twilio can <Play> it during a live phone call.
 */
export const elevenLabsConfigured = () => !!process.env.ELEVENLABS_API_KEY;

export async function tts(text: string): Promise<Buffer | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  const voice = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5" }),
    });
    if (!res.ok) {
      console.error("[elevenlabs]", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error("[elevenlabs]", (e as Error).message);
    return null;
  }
}

/** Returns a public URL for the spoken text, or null (caller falls back to Twilio <Say>). */
export async function clipUrl(text: string): Promise<string | null> {
  const audio = await tts(text);
  if (!audio) return null;
  const db = await getDb();
  const r = await db.collection("voice_clips").insertOne({ mp3: new Binary(audio), text, createdAt: new Date() });
  const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  return `${base}/api/voice/audio/${r.insertedId}`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** <Play> an ElevenLabs clip, or <Say> as fallback. */
export async function speak(text: string): Promise<string> {
  const url = await clipUrl(text);
  return url ? `<Play>${esc(url)}</Play>` : `<Say voice="Polly.Joanna">${esc(text)}</Say>`;
}
