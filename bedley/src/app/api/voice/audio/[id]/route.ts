import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

/** Serves ElevenLabs audio to Twilio during a live call. IDs are unguessable and clips expire after a day. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const clip = await db.collection("voice_clips").findOne({ _id: new ObjectId(id) });
  if (!clip) return new Response("Not found", { status: 404 });
  const buf = Buffer.from(clip.mp3.buffer);
  return new Response(buf, { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(buf.length), "Cache-Control": "private, max-age=3600" } });
}
