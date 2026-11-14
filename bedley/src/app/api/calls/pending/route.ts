import { ObjectId } from "mongodb";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The most recent ringing in-app call for the signed-in landlord (if any). */
export async function GET() {
  const s = await getSession();
  if (!s || s.role === "tenant") return Response.json({ call: null });
  const db = await getDb();
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const call = await db
    .collection("voice_calls")
    .find({ userId: new ObjectId(s.userId), orgId: new ObjectId(s.orgId), status: "ringing", createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  return Response.json({ call: call ? { id: String(call._id), kind: call.kind, script: call.script, ticketId: String(call.ticketId) } : null });
}
