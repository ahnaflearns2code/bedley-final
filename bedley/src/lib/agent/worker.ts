import { ObjectId } from "mongodb";
import { C, getDb } from "../db";
import { runAgent, startRun } from "./runner";
import { writeAudit } from "../audit";

/**
 * The always-on maintenance agent. Starts with the server (src/instrumentation.ts) and:
 *  - picks up every new ticket and starts a workflow for it
 *  - wakes runs that were sleeping for contractor quotes
 *  - continues runs a landlord just approved
 *  - recovers runs whose worker died mid-step (expired lock) from their last checkpoint
 * It reacts instantly to new tickets via a MongoDB Change Stream and also polls every 3s as a safety net.
 */

type WorkerState = { started: boolean; busy: boolean; inflight: Set<string>; nudge: () => void };
const g = globalThis as unknown as { __keystoneWorker?: WorkerState };

export function nudgeWorker() {
  g.__keystoneWorker?.nudge();
}

export function startAgentWorker() {
  if (g.__keystoneWorker?.started) return;
  if (!process.env.MONGODB_URI) {
    console.warn("[agent] MONGODB_URI not set — agent worker not started");
    return;
  }
  const state: WorkerState = { started: true, busy: false, inflight: new Set(), nudge: () => void tick() };
  g.__keystoneWorker = state;

  const drive = (runId: ObjectId) => {
    const key = String(runId);
    if (state.inflight.has(key)) return;
    state.inflight.add(key);
    runAgent(runId)
      .catch(async (e) => {
        console.error("[agent] run error", e);
        const db = await getDb();
        await db.collection(C.runs).updateOne({ _id: runId }, { $set: { status: "failed", error: String(e?.message || e), lockedUntil: null, updatedAt: new Date() } });
      })
      .finally(() => state.inflight.delete(key));
  };

  async function tick() {
    if (state.busy) return;
    state.busy = true;
    try {
      // Pick up the public link written by `npm run tunnel` (only if the user started it).
      try {
        const fs = await import("node:fs");
        if (fs.existsSync(".public-url")) {
          const url = fs.readFileSync(".public-url", "utf8").trim();
          if (/^https:\/\//.test(url) && process.env.APP_BASE_URL !== url) {
            process.env.APP_BASE_URL = url;
            console.log(`[agent] using public link ${url} for phone calls`);
          }
        } else if (/trycloudflare\.com/.test(process.env.APP_BASE_URL || "")) {
          process.env.APP_BASE_URL = "http://localhost:3000"; // tunnel was closed
        }
      } catch {
        /* ignore */
      }
      const db = await getDb();
      const now = new Date();
      await db.collection("agent_worker").updateOne(
        { _id: "maintenance-agent" as any },
        { $set: { lastBeat: now, pid: process.pid, inflight: state.inflight.size } },
        { upsert: true }
      );

      // 1. New tickets → claim atomically and start a run
      for (let i = 0; i < 5; i++) {
        const t = await db.collection(C.tickets).findOneAndUpdate(
          { status: "new", agentClaimedAt: { $exists: false } },
          { $set: { agentClaimedAt: now } },
          { sort: { createdAt: 1 } }
        );
        if (!t) break;
        const tenant = await db.collection(C.tenants).findOne({ _id: t.tenantId });
        const runId = await startRun({
          orgId: t.orgId,
          ticketId: t._id,
          startedBy: { userId: String(tenant?.userId ?? t.tenantId), role: "tenant", name: tenant?.name ?? "Tenant" },
        });
        drive(runId);
      }

      // 1b. Demo contractor market: deliver quotes from simulated contractors when their "call" finishes
      const due = await db
        .collection(C.tickets)
        .find({ contacts: { $elemMatch: { simulated: true, answered: { $ne: true }, replyAt: { $lte: now } } } })
        .limit(20)
        .toArray();
      for (const t of due) {
        for (let i = 0; i < (t.contacts?.length ?? 0); i++) {
          const ct = t.contacts[i];
          if (!ct.simulated || ct.answered || new Date(ct.replyAt) > now) continue;
          const quote = { contractorId: ct.contractorId, amountCents: ct.simQuote.amountCents, availability: ct.simQuote.availability, raw: ct.simQuote.raw, source: "voice_call", kind: "verbal_estimate", simulated: true, receivedAt: new Date() };
          const r = await db.collection(C.tickets).updateOne(
            { _id: t._id, [`contacts.${i}.answered`]: { $ne: true } },
            { $set: { [`contacts.${i}.answered`]: true, updatedAt: new Date() }, $push: { quotes: quote } as any }
          );
          if (r.modifiedCount || r.matchedCount)
            await writeAudit({ orgId: t.orgId, ticketId: t._id, runId: t.agentRunId, actor: { type: "provider", id: "demo-market", name: "Contractor (phone call)" }, action: "quote.received", input: quote, result: { status: "confirmed" } });
        }
      }

      // 2. Sleeping runs whose wait is over → wake
      await db.collection(C.runs).updateMany({ status: "waiting", resumeAt: { $lte: now }, stopRequested: { $ne: true } }, { $set: { status: "running", lockedUntil: null } });

      // 3. Runnable runs (just approved, just woken, or crashed with an expired lock)
      const runnable = await db
        .collection(C.runs)
        .find({ status: "running", $or: [{ lockedUntil: null }, { lockedUntil: { $exists: false } }, { lockedUntil: { $lt: now } }] })
        .project({ _id: 1, lockedUntil: 1, orgId: 1, ticketId: 1 })
        .limit(10)
        .toArray();
      for (const r of runnable) {
        if (r.lockedUntil && !state.inflight.has(String(r._id))) {
          await writeAudit({ orgId: r.orgId, runId: r._id, ticketId: r.ticketId, actor: { type: "system", id: "worker", name: "Agent worker" }, action: "agent.run.recovering", reason: "Previous worker lock expired; resuming from checkpoint.", result: { status: "confirmed" } });
        }
        drive(r._id as ObjectId);
      }
    } catch (e) {
      console.error("[agent] tick failed", (e as Error).message);
    } finally {
      state.busy = false;
    }
  }

  setInterval(() => void tick(), 3000).unref?.();
  void tick();

  // Instant pickup of new tickets and approvals via Change Streams
  (async () => {
    try {
      const db = await getDb();
      const cs = db.watch(
        [{ $match: { $or: [{ "ns.coll": C.tickets, operationType: "insert" }, { "ns.coll": C.runs, "updateDescription.updatedFields.status": "running" }] } }],
        {}
      );
      cs.on("change", () => void tick());
      cs.on("error", (e) => console.warn("[agent] change stream closed; polling only", e.message));
    } catch (e) {
      console.warn("[agent] change stream unavailable; polling only", (e as Error).message);
    }
  })();

  console.log("[agent] maintenance agent online");
}
