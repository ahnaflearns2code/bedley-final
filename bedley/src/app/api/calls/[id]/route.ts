import { ObjectId } from "mongodb";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

/** Answer / decline / hang up an in-app call. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s || s.role === "tenant") return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  if (!ObjectId.isValid(id)) return new Response("Bad id", { status: 400 });
  const { action } = (await req.json()) as { action: "answer" | "decline" | "end" };
  const status = action === "answer" ? "answered" : action === "decline" ? "declined" : "ended";
  const db = await getDb();
  const call = await db.collection("voice_calls").findOneAndUpdate(
    { _id: new ObjectId(id), userId: new ObjectId(s.userId) },
    { $set: { status, [`${status}At`]: new Date() } },
    { returnDocument: "after" }
  );
  if (!call) return new Response("Not found", { status: 404 });
  if (action === "answer") await db.collection("voice_calls").updateOne({ _id: call._id }, { $push: { transcript: { who: "bedley", text: call.script, ts: new Date() } } as any });
  if (action !== "end")
    await writeAudit({ orgId: call.orgId, ticketId: call.ticketId, actor: { type: "user", id: s.userId, name: s.name }, action: `landlord.${status}_in_app_call`, input: { kind: call.kind }, result: { status: "confirmed" } });
  // Declining marks the other ringing calls for this ticket as declined too
  if (action === "decline") await db.collection("voice_calls").updateMany({ ticketId: call.ticketId, userId: call.userId, status: "ringing" }, { $set: { status: "declined" } });
  return Response.json({ ok: true });
}
