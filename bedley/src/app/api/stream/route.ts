import { ObjectId } from "mongodb";
import { getSession } from "@/lib/auth";
import { C, getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Server-Sent Events backed by a MongoDB Change Stream, scoped to the caller's organisation. */
export async function GET(req: Request) {
  const s = await getSession();
  if (!s) return new Response("Unauthorized", { status: 401 });
  const db = await getDb();
  const orgId = new ObjectId(s.orgId);
  const match: Record<string, unknown> = {
    "ns.coll": { $in: [C.audit, C.runs, C.tickets, C.approvals, C.messages, C.rent] },
    "fullDocument.orgId": orgId,
  };
  if (s.role === "tenant") {
    // Tenants only get pinged for their own tickets/messages/rent.
    match["fullDocument.tenantId"] = new ObjectId(s.tenantId);
  }
  const stream = db.watch([{ $match: match }], { fullDocument: "updateLookup" });
  const enc = new TextEncoder();

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(": connected\n\n"));
      const ping = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 20000);
      stream.on("change", (ch: any) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ coll: ch.ns?.coll, op: ch.operationType })}\n\n`));
        } catch {
          /* closed */
        }
      });
      stream.on("error", () => {
        clearInterval(ping);
        try { controller.close(); } catch { /* */ }
      });
      req.signal.addEventListener("abort", () => {
        clearInterval(ping);
        stream.close().catch(() => {});
        try { controller.close(); } catch { /* */ }
      });
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
