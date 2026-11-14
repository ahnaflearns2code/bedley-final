import { getSession } from "@/lib/auth";
import { tts } from "@/lib/integrations/elevenlabs";

/** ElevenLabs voice for in-app calls. 204 = no ElevenLabs (the browser uses its own voice instead). */
export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return new Response("Unauthorized", { status: 401 });
  const { text } = (await req.json()) as { text: string };
  const audio = await tts(String(text || "").slice(0, 900));
  if (!audio) return new Response(null, { status: 204 });
  return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
}
