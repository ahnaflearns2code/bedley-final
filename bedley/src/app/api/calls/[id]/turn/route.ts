import { ObjectId } from "mongodb";
import { getSession } from "@/lib/auth";
import { inAppTurn } from "@/lib/browserCalls";

/** The landlord said something on the in-app call; Bedley replies. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s || s.role === "tenant") return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  if (!ObjectId.isValid(id)) return new Response("Bad id", { status: 400 });
  const { text } = (await req.json()) as { text: string };
  const heard = String(text || "").trim().slice(0, 500);
  if (!heard) return Response.json({ say: "Sorry, I didn't catch that. Could you say it again?", done: false });
  return Response.json(await inAppTurn(new ObjectId(id), new ObjectId(s.userId), heard));
}
