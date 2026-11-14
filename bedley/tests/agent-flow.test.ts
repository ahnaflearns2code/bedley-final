/**
 * End-to-end simulation of the agent workflow against an in-memory MongoDB stand-in (mingo).
 * Covers: triage → search → contact → sleep for quotes → wake → propose → approval gate →
 * approve → book → notify tenant, plus kill switch and stop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ObjectId } from "mongodb";
import { Query, aggregate } from "mingo";
import { updateObject } from "mingo/updater";

process.env.MONGODB_URI = "mongodb://fake";
process.env.DEMO_SIMULATE_CONTRACTORS = "0"; // most tests use the landlord's saved contractors

/* eslint-disable @typescript-eslint/no-explicit-any */
class Cursor {
  constructor(private docs: any[]) {}
  sort(spec: Record<string, 1 | -1>) {
    const [[k, dir]] = Object.entries(spec);
    this.docs.sort((a, b) => (a[k] > b[k] ? dir : a[k] < b[k] ? -dir : 0));
    return this;
  }
  limit(n: number) { this.docs = this.docs.slice(0, n); return this; }
  project() { return this; }
  async toArray() { return this.docs; }
  async next() { return this.docs[0] ?? null; }
}

const clone = (d: any): any => {
  if (d instanceof ObjectId || d instanceof Date || d === null || typeof d !== "object") return d;
  if (Array.isArray(d)) return d.map(clone);
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, clone(v)]));
};

function setPath(o: any, path: string, v: any) {
  const ks = path.split(".");
  let cur = o;
  for (const k of ks.slice(0, -1)) { if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {}; cur = cur[k]; }
  cur[ks[ks.length - 1]] = v;
}

class Coll {
  docs: any[] = [];
  private q(f: any = {}) { return this.docs.filter((d) => new Query(f).test(d)); }
  find(f?: any) { return new Cursor(this.q(f).map(clone)); }
  async findOne(f?: any) { const d = this.q(f)[0]; return d ? clone(d) : null; }
  async insertOne(doc: any) { const d = { _id: new ObjectId(), ...doc }; this.docs.push(d); return { insertedId: d._id }; }
  async insertMany(ds: any[]) { for (const d of ds) await this.insertOne(d); return {}; }
  private apply(d: any, u: any) {
    const { $setOnInsert: _s, ...rest } = u;
    for (const [op, v] of Object.entries(rest)) {
      if (op === "$set") { for (const [k, val] of Object.entries(v as any)) setPath(d, k, val); continue; }
      updateObject(d, { [op]: v } as any);
    }
  }
  async updateOne(f: any, u: any, o: any = {}) {
    const d = this.q(f)[0];
    if (d) { this.apply(d, u); return { matchedCount: 1, modifiedCount: 1 }; }
    if (o.upsert) { const n: any = { _id: new ObjectId() }; for (const [k, v] of Object.entries(f)) if (!k.startsWith("$") && typeof v !== "object") n[k] = v; this.apply(n, { ...u, $set: { ...(u.$set || {}), ...(u.$setOnInsert || {}) } }); this.docs.push(n); return { matchedCount: 0, upsertedId: n._id }; }
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async updateMany(f: any, u: any) { const ds = this.q(f); ds.forEach((d) => this.apply(d, u)); return { matchedCount: ds.length }; }
  async findOneAndUpdate(f: any, u: any, o: any = {}) {
    let ds = this.q(f);
    if (o.sort) ds = new Cursor(ds).sort(o.sort)["docs"];
    const d = ds[0];
    if (!d) {
      if (!o.upsert) return null;
      const n: any = { _id: new ObjectId(), ...Object.fromEntries(Object.entries(f).filter(([k, v]) => !k.startsWith("$") && !(v && typeof v === "object" && !(v instanceof ObjectId)))) };
      this.apply(n, { ...u, $set: { ...(u.$set || {}), ...(u.$setOnInsert || {}) } });
      this.docs.push(n);
      return clone(n);
    }
    const before = clone(d);
    this.apply(d, u);
    return o.returnDocument === "after" ? clone(d) : before;
  }
  async countDocuments(f?: any) { return this.q(f).length; }
  aggregate(p: any[]) { return { toArray: async () => aggregate(this.docs, p) }; }
  async createIndex() {}
}

const colls = new Map<string, Coll>();
const fakeDb: any = { collection: (n: string) => { if (!colls.has(n)) colls.set(n, new Coll()); return colls.get(n)!; }, watch: () => new EventEmitter() };
(globalThis as any)._mongoClient = Promise.resolve({ db: () => fakeDb, startSession: () => ({ withTransaction: (fn: any) => fn(), endSession: async () => {} }) });

const db = fakeDb;

async function seed() {
  colls.clear();
  const orgId = new ObjectId();
  await db.collection("organizations").insertOne({ _id: orgId, name: "Raman Property Group" });
  const propertyId = new ObjectId();
  await db.collection("properties").insertOne({ _id: propertyId, orgId, name: "Midland Commons", address: "2350 Midland Ave", city: "Toronto", lat: 43.78, lng: -79.27 });
  const unitId = new ObjectId();
  await db.collection("units").insertOne({ _id: unitId, orgId, propertyId, label: "2B", rentCents: 215000 });
  await db.collection("users").insertOne({ orgId, role: "landlord", name: "Priya Raman", email: "l@x" });
  const tenantId = new ObjectId();
  await db.collection("tenants").insertOne({ _id: tenantId, orgId, userId: new ObjectId(), name: "Marcus Chen", email: "t@x", unitId, preferredChannel: "in_app", optIn: {} });
  await db.collection("contractors").insertMany([
    { orgId, name: "Danforth Plumbing Co.", phone: "+14165550199", trades: ["plumber"], source: "saved", verification: "landlord_verified", rating: 4.8, reviews: 212 },
    { orgId, name: "Eastside Drains", phone: "+14165550198", trades: ["plumber"], source: "saved", verification: "unverified", rating: 4.5, reviews: 40 },
  ]);
  const ticketId = new ObjectId();
  await db.collection("maintenance_requests").insertOne({ _id: ticketId, orgId, propertyId, unitId, tenantId, title: "Water leaking under the kitchen sink", description: "Pipe under the sink is dripping into the cabinet.", status: "new", createdAt: new Date() });
  return { orgId, ticketId, tenantId };
}

test("full agent workflow with approval gate", async () => {
  const { runAgent, startRun } = await import("../src/lib/agent/runner");
  const { orgId, ticketId } = await seed();
  await db.collection("policies").insertOne({ orgId, version: 2, killSwitch: false, autoBookMinor: false, spendingLimitCents: 50000, hardCapCents: 200000, maxContractorsContacted: 5, tools: {} });
  const runId = await startRun({ orgId, ticketId, startedBy: { userId: "u1", role: "tenant", name: "Marcus" } });
  await runAgent(runId);

  let run = await db.collection("agent_runs").findOne({ _id: runId });
  let ticket = await db.collection("maintenance_requests").findOne({ _id: ticketId });
  assert.equal(run.status, "waiting", `expected waiting, got ${run.status} ${run.error ?? ""}`);
  assert.equal(ticket.category, "plumbing");
  assert.equal(ticket.contacts.length, 2, "contacted both plumbers");
  assert.equal(ticket.contacts[0].status, "simulated");

  // A contractor answers the call with a price
  await db.collection("maintenance_requests").updateOne({ _id: ticketId }, { $push: { quotes: { contractorId: ticket.contacts[1].contractorId, amountCents: 18000, availability: "tomorrow 10am", raw: "180 tomorrow 10am", source: "voice_call", receivedAt: new Date() } } });
  // Both answer → time passes → worker wakes the run
  await db.collection("maintenance_requests").updateOne({ _id: ticketId }, { $push: { quotes: { contractorId: ticket.contacts[0].contractorId, amountCents: 26000, availability: "today 4pm", raw: "260 today at 4", source: "voice_call", receivedAt: new Date() } } });
  await db.collection("agent_runs").updateOne({ _id: runId }, { $set: { status: "running", lockedUntil: null, "waiting.until": new Date(Date.now() - 1000) } });
  await runAgent(runId);

  run = await db.collection("agent_runs").findOne({ _id: runId });
  assert.equal(run.status, "awaiting_approval", `got ${run.status} ${run.error ?? ""}`);
  const approval = await db.collection("approvals").findOne({ runId });
  assert.equal(approval.tool, "propose_booking");
  assert.equal(approval.input.estimate_cents, 18000, "picked the cheapest real quote");
  ticket = await db.collection("maintenance_requests").findOne({ _id: ticketId });
  assert.equal(ticket.status, "awaiting_approval");
  assert.equal(ticket.booking, undefined, "nothing booked before approval");

  // Landlord approves
  await db.collection("approvals").updateOne({ _id: approval._id }, { $set: { status: "approved", overrideInput: {} } });
  await db.collection("agent_runs").updateOne({ _id: runId }, { $set: { status: "running" } });
  await runAgent(runId);

  run = await db.collection("agent_runs").findOne({ _id: runId });
  ticket = await db.collection("maintenance_requests").findOne({ _id: ticketId });
  assert.equal(run.status, "completed", `got ${run.status} ${run.error ?? ""}`);
  assert.equal(ticket.status, "contractor_booked");
  assert.equal(ticket.booking.approvedCents, 18000);
  const msgs = await db.collection("messages").find({ ticketId }).toArray();
  assert.ok(msgs.some((m: any) => /booked/i.test(m.body)), "tenant notified");

  const audit = await db.collection("audit_logs").find({ runId }).toArray();
  const actions = audit.map((a: any) => a.action);
  for (const a of ["tool.triage_ticket", "tool.search_contractors", "tool.contact_contractor", "tool.wait_for_quotes", "tool.propose_booking", "tool.notify_tenant", "agent.run.completed"]) assert.ok(actions.includes(a), `audit has ${a}`);
  const gated = audit.filter((a: any) => a.tool === "propose_booking").map((a: any) => a.decision);
  assert.deepEqual(gated, ["needs_approval", "allowed"]);
  assert.ok(audit.filter((a: any) => a.tool).every((a: any) => a.policyVersion && a.onBehalfOf), "every tool call cites policy + authority");
});

test("kill switch blocks every agent action", async () => {
  const { runAgent, startRun } = await import("../src/lib/agent/runner");
  const { orgId, ticketId } = await seed();
  await db.collection("policies").insertOne({ orgId, version: 2, killSwitch: true, spendingLimitCents: 50000, hardCapCents: 200000, tools: {} });
  const runId = await startRun({ orgId, ticketId, startedBy: { userId: "u1", role: "tenant", name: "Marcus" } });
  await runAgent(runId);
  const audit = await db.collection("audit_logs").find({ runId, tool: { $exists: true } }).toArray();
  assert.ok(audit.length > 0);
  assert.ok(audit.every((a: any) => a.decision === "denied" && a.policyRule === "org.killSwitch"));
  const ticket = await db.collection("maintenance_requests").findOne({ _id: ticketId });
  assert.equal(ticket.contacts, undefined, "no contractor was contacted");
});

test("stop requested halts before next action", async () => {
  const { runAgent, startRun } = await import("../src/lib/agent/runner");
  const { orgId, ticketId } = await seed();
  const runId = await startRun({ orgId, ticketId, startedBy: { userId: "u1", role: "tenant", name: "Marcus" } });
  await db.collection("agent_runs").updateOne({ _id: runId }, { $set: { stopRequested: true } });
  await runAgent(runId);
  const run = await db.collection("agent_runs").findOne({ _id: runId });
  assert.equal(run.status, "stopped");
  const tools = await db.collection("audit_logs").find({ runId, tool: { $exists: true } }).toArray();
  assert.equal(tools.length, 0);
});

test("always-on worker picks up a new ticket by itself", async () => {
  const { startAgentWorker } = await import("../src/lib/agent/worker");
  const { ticketId } = await seed();
  startAgentWorker();
  await new Promise((r) => setTimeout(r, 800));
  const ticket = await db.collection("maintenance_requests").findOne({ _id: ticketId });
  assert.ok(ticket.agentRunId, "worker started a run");
  const run = await db.collection("agent_runs").findOne({ _id: ticket.agentRunId });
  assert.equal(run.status, "waiting", `got ${run.status} ${run.error ?? ""}`);
  const beat = await db.collection("agent_worker").findOne({});
  assert.ok(beat?.lastBeat, "heartbeat written");
});

test("clogged sink: AI sends DIY fix + waits; tenant says fixed → no contractor", async () => {
  const { runAgent, startRun } = await import("../src/lib/agent/runner");
  const { orgId, ticketId } = await seed();
  await db.collection("maintenance_requests").updateOne({ _id: ticketId }, { $set: { title: "Kitchen sink clogged", description: "Water won't drain from the kitchen sink." } });
  const runId = await startRun({ orgId, ticketId, startedBy: { userId: "u1", role: "tenant", name: "Marcus" } });
  await runAgent(runId);
  let ticket = await db.collection("maintenance_requests").findOne({ _id: ticketId });
  let run = await db.collection("agent_runs").findOne({ _id: runId });
  assert.equal(run.status, "waiting", `got ${run.status} ${run.error ?? ""}`);
  assert.equal(run.waiting.toolUse.name, "wait_for_tenant");
  assert.ok(ticket.diySteps.length >= 3, "steps sent");
  assert.equal(ticket.awaitingTenant, true);
  const msgs = await db.collection("messages").find({ ticketId }).toArray();
  assert.ok(msgs.some((m: any) => /plunger/i.test(m.body)), "tenant got the steps");

  // tenant: fixed
  await db.collection("maintenance_requests").updateOne({ _id: ticketId }, { $set: { diyResult: "fixed", status: "completed" } });
  await db.collection("agent_runs").updateOne({ _id: runId }, { $set: { status: "running", "waiting.until": new Date(Date.now() - 1) } });
  await runAgent(runId);
  run = await db.collection("agent_runs").findOne({ _id: runId });
  ticket = await db.collection("maintenance_requests").findOne({ _id: ticketId });
  assert.equal(run.status, "completed", `got ${run.status} ${run.error ?? ""}`);
  assert.equal(ticket.contacts, undefined, "no contractor contacted");
});

test("clogged sink: tenant says still broken → agent goes to contractors", async () => {
  const { runAgent, startRun } = await import("../src/lib/agent/runner");
  const { orgId, ticketId } = await seed();
  await db.collection("maintenance_requests").updateOne({ _id: ticketId }, { $set: { title: "Kitchen sink clogged", description: "Water won't drain from the kitchen sink." } });
  const runId = await startRun({ orgId, ticketId, startedBy: { userId: "u1", role: "tenant", name: "Marcus" } });
  await runAgent(runId);
  await db.collection("maintenance_requests").updateOne({ _id: ticketId }, { $set: { diyResult: "not_fixed" } });
  await db.collection("agent_runs").updateOne({ _id: runId }, { $set: { status: "running", "waiting.until": new Date(Date.now() - 1) } });
  await runAgent(runId);
  const run = await db.collection("agent_runs").findOne({ _id: runId });
  const ticket = await db.collection("maintenance_requests").findOne({ _id: ticketId });
  assert.equal(run.status, "waiting");
  assert.equal(run.waiting.toolUse.name, "wait_for_quotes");
  assert.equal(ticket.contacts.length, 2);
});


test("demo market: minor leak → 4 contractors called → best quote auto-booked → tenant + landlord told", async () => {
  process.env.DEMO_SIMULATE_CONTRACTORS = "1";
  try {
    const { runAgent, startRun } = await import("../src/lib/agent/runner");
    const { orgId, ticketId } = await seed();
    const runId = await startRun({ orgId, ticketId, startedBy: { userId: "u1", role: "tenant", name: "Marcus" } });
    await runAgent(runId);
    let t = await db.collection("maintenance_requests").findOne({ _id: ticketId });
    assert.equal(t.contacts.length, 4, "called 4 contractors");
    assert.ok(t.contacts.every((c: any) => c.simulated && c.simQuote.amountCents > 0));
    assert.equal(t.majorRepair, false);
    // contractors answer
    for (const c of t.contacts) await db.collection("maintenance_requests").updateOne({ _id: ticketId }, { $push: { quotes: { contractorId: c.contractorId, amountCents: c.simQuote.amountCents, availability: c.simQuote.availability, raw: c.simQuote.raw, source: "voice_call" } } });
    await db.collection("agent_runs").updateOne({ _id: runId }, { $set: { status: "running", "waiting.until": new Date(Date.now() - 1) } });
    await runAgent(runId);
    const run = await db.collection("agent_runs").findOne({ _id: runId });
    t = await db.collection("maintenance_requests").findOne({ _id: ticketId });
    assert.equal(run.status, "completed", `got ${run.status} ${run.error ?? ""}`);
    assert.equal(t.status, "contractor_booked");
    const cheapest = Math.min(...t.contacts.map((c: any) => c.simQuote.amountCents));
    assert.equal(t.booking.approvedCents, cheapest, "booked the cheapest quote");
    const audit = await db.collection("audit_logs").find({ runId, tool: "propose_booking" }).toArray();
    assert.equal(audit[0].decision, "allowed");
    assert.match(audit[0].policyRule, /autoBookMinor/);
    const msgs = await db.collection("messages").find({ ticketId }).toArray();
    assert.ok(msgs.some((m: any) => /I called 4 local plumbers/.test(m.body)), "tenant got the full script");
    const ups = await db.collection("landlord_updates").find({}).toArray();
    assert.equal(ups.length, 1);
    assert.match(ups[0].text, /auto-book limit/);
  } finally {
    process.env.DEMO_SIMULATE_CONTRACTORS = "0";
  }
});

test("demo market: major repair (no heat) → landlord phoned immediately, then approval required before booking", async () => {
  process.env.DEMO_SIMULATE_CONTRACTORS = "1";
  process.env.DEMO_LANDLORD_PHONE = "+14165550100";
  try {
    const { runAgent, startRun } = await import("../src/lib/agent/runner");
    const { orgId, ticketId } = await seed();
    await db.collection("maintenance_requests").updateOne({ _id: ticketId }, { $set: { title: "No heat in the apartment", description: "The furnace stopped and there's no heat." } });
    const runId = await startRun({ orgId, ticketId, startedBy: { userId: "u1", role: "tenant", name: "Marcus" } });
    await runAgent(runId);
    await new Promise((r) => setTimeout(r, 300)); // briefing call is fire-and-forget
    let t = await db.collection("maintenance_requests").findOne({ _id: ticketId });
    assert.equal(t.majorRepair, true);
    const brief = await db.collection("audit_logs").findOne({ ticketId, action: "landlord.briefed_by_phone" });
    assert.ok(brief, "landlord was phoned immediately with a briefing");
    assert.ok(t.landlordBriefedAt);
    const up = await db.collection("landlord_updates").findOne({ ticketId });
    assert.match(up.text, /Bedley called you/);
    for (const c of t.contacts) await db.collection("maintenance_requests").updateOne({ _id: ticketId }, { $push: { quotes: { contractorId: c.contractorId, amountCents: c.simQuote.amountCents, availability: c.simQuote.availability, source: "voice_call" } } });
    await db.collection("agent_runs").updateOne({ _id: runId }, { $set: { status: "running", "waiting.until": new Date(Date.now() - 1) } });
    await runAgent(runId);
    const run = await db.collection("agent_runs").findOne({ _id: runId });
    t = await db.collection("maintenance_requests").findOne({ _id: ticketId });
    assert.equal(run.status, "awaiting_approval");
    assert.equal(t.booking, undefined);
    assert.ok(await db.collection("approvals").findOne({ runId, status: "pending" }));
  } finally {
    process.env.DEMO_SIMULATE_CONTRACTORS = "0";
    delete process.env.DEMO_LANDLORD_PHONE;
  }
});
