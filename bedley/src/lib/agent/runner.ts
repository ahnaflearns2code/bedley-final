import Anthropic from "@anthropic-ai/sdk";
import { ObjectId } from "mongodb";
import { C, getDb } from "../db";
import { loadPolicy } from "../policy";
import { evaluate } from "../policy-core";
import { updateAuditResult, writeAudit } from "../audit";
import { redact } from "../redact";
import { EXECUTORS, TOOL_DEFS } from "./tools";
import { scriptedNext } from "./scripted";

const AGENT_NAME = "maintenance-agent";
const MAX_STEPS = 14;

type Msg = Anthropic.MessageParam;
type ToolUse = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ToolResult = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

const SYSTEM = `You are the maintenance agent for a residential property manager in Toronto, Ontario.
You coordinate a repair from a tenant's report to a booked contractor. Every tool call you make is checked against the landlord's policy BEFORE it runs, and recorded in an audit ledger.
Workflow:
1. triage_ticket first. If it is an emergency (gas, flooding, sparking/burning smell, CO alarm, no heat in freezing weather), notify_tenant immediately with safety instructions (call 911 / the gas utility for gas or CO; shut off water at the main for flooding), then go straight to contractors. No DIY for emergencies.
2. Try to solve it first: if a tenant can safely fix it (clogged drain, running toilet, reset a tripped breaker, replace a furnace filter), call suggest_diy_fix with clear steps and a YouTube search, then wait_for_tenant. If tenant_answer is "fixed", notify_tenant with a short thanks and stop. Otherwise continue to contractors.
   If it can't be fixed by the tenant but there's a safe way to limit damage (close the valve under the sink, put a bucket down), call suggest_diy_fix with interim_only=true and continue to contractors without waiting.
3. Otherwise search_contractors, then contact_contractor for 3-5 of the best options (rating x reviews, distance), one call each. Never contact more than policy allows.
4. wait_for_quotes (about 20 seconds) so contractors can answer. If not everyone has quoted, wait again (at most 3 waits total).
5. propose_booking on its own for the best overall option, weighing quoted price, availability, rating and reviews. Always include estimate_cents from a real quote and the contractor's quoted time as proposed_window. Minor jobs under the limit book automatically; major repairs and emergencies pause while the landlord is phoned.
6. Once booked: notify_tenant with kind="booking_confirmed", then notify_landlord with kind="booking_confirmed" (both get a full written/spoken summary automatically). Then finish with a one-line summary.
In triage set major_repair=true for flooding, water damage, no heat, electrical hazards, structural issues, mould or sewage.
If a tool is blocked by policy, do not try to work around it; explain and stop.
Never claim an action succeeded unless the tool result says so. Keep messages to tenants short and calm.`;

function plannerKind(): "claude" | "scripted" {
  return process.env.ANTHROPIC_API_KEY ? "claude" : "scripted";
}

export async function startRun(opts: { orgId: ObjectId; ticketId: ObjectId; startedBy: { userId: string; role: string; name: string } }) {
  const db = await getDb();
  const ticket = await db.collection(C.tickets).findOne({ _id: opts.ticketId, orgId: opts.orgId });
  if (!ticket) throw new Error("Ticket not found");
  const property = await db.collection(C.properties).findOne({ _id: ticket.propertyId });
  const unit = await db.collection(C.units).findOne({ _id: ticket.unitId });
  const first: Msg = {
    role: "user",
    content: redact(
      `New maintenance request ${String(ticket._id).slice(-6).toUpperCase()}\n` +
        `Property: ${property?.name}, ${property?.address}, ${property?.city} (unit ${unit?.label})\n` +
        `Title: ${ticket.title}\nTenant description: ${ticket.description}\n` +
        `Tenant availability: ${ticket.availability || "not given"}`
    ),
  };
  const run = {
    orgId: opts.orgId,
    ticketId: opts.ticketId,
    agent: AGENT_NAME,
    planner: plannerKind(),
    status: "running",
    stopRequested: false,
    authority: opts.startedBy,
    messages: [first],
    step: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const r = await db.collection(C.runs).insertOne(run);
  await db.collection(C.tickets).updateOne({ _id: opts.ticketId }, { $set: { agentRunId: r.insertedId, status: "ai_triage", updatedAt: new Date() } });
  await writeAudit({
    orgId: opts.orgId,
    runId: r.insertedId,
    ticketId: opts.ticketId,
    actor: { type: "user", id: opts.startedBy.userId, name: opts.startedBy.name },
    action: "agent.run.started",
    reason: `Planner: ${run.planner}`,
    result: { status: "confirmed" },
  });
  return r.insertedId;
}

/** Fire-and-forget wrapper used by route handlers / server actions. */
export function kickRun(runId: ObjectId) {
  runAgent(runId).catch(async (e) => {
    console.error("[agent] run failed", e);
    const db = await getDb();
    await db.collection(C.runs).updateOne({ _id: runId }, { $set: { status: "failed", error: String(e?.message || e), lockedUntil: null, updatedAt: new Date() } });
  });
}

async function nextAssistantMessage(run: any): Promise<Anthropic.ContentBlockParam[]> {
  if (run.planner === "scripted") return scriptedNext(run);
  const anthropic = new Anthropic();
  const resp = await anthropic.messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
    max_tokens: 1500,
    system: SYSTEM,
    tools: TOOL_DEFS,
    messages: run.messages,
  });
  return resp.content.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text } as const;
    if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input as Record<string, unknown> } as const;
    return { type: "text", text: "" } as const;
  }).filter((b) => !(b.type === "text" && !b.text));
}

/**
 * Executes one tool call through the policy gate. Idempotent: if this tool_use id
 * already produced a sent/confirmed result (e.g. we crashed after sending an SMS),
 * the stored result is reused instead of re-executing.
 */
async function gatedCall(run: any, tu: ToolUse, approved: boolean): Promise<{ result?: ToolResult; pause?: boolean; wait?: Date }> {
  const db = await getDb();
  const prior = await db.collection(C.audit).findOne({
    runId: run._id,
    toolUseId: tu.id,
    "result.status": { $in: ["sent", "confirmed", "simulated"] },
  });
  if (prior) {
    return { result: { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ replayed: true, ...(prior.result?.detail ?? {}) }) } };
  }

  const policy = await loadPolicy(run.orgId);
  const freshRun = await db.collection(C.runs).findOne({ _id: run._id });
  const ticket = await db.collection(C.tickets).findOne({ _id: run.ticketId });
  const decision = evaluate(policy, tu.name, { estimateCents: tu.input.estimate_cents }, {
    runStopRequested: !!freshRun?.stopRequested,
    contractorsContactedSoFar: ticket?.contacts?.length ?? 0,
    approved,
    minorJob: !!ticket && !ticket.majorRepair && ticket.priority !== "emergency",
  });

  const auditId = await writeAudit({
    orgId: run.orgId,
    runId: run._id,
    ticketId: run.ticketId,
    actor: { type: "agent", id: `agent:${AGENT_NAME}`, name: `Maintenance agent (${run.planner})` },
    onBehalfOf: { userId: run.authority.userId, role: run.authority.role },
    action: `tool.${tu.name}`,
    tool: tu.name,
    toolUseId: tu.id,
    input: tu.input,
    decision: decision.decision,
    policyRule: decision.rule,
    policyVersion: policy.version,
    reason: decision.reason,
    result: { status: decision.decision === "denied" ? "blocked" : decision.decision === "needs_approval" ? "awaiting_approval" : "pending" },
  });

  if (decision.decision === "denied") {
    return { result: { type: "tool_result", tool_use_id: tu.id, is_error: true, content: JSON.stringify({ blocked_by_policy: true, rule: decision.rule, reason: decision.reason }) } };
  }

  if (decision.decision === "needs_approval") {
    const ins = await db.collection(C.approvals).insertOne({
      orgId: run.orgId,
      runId: run._id,
      ticketId: run.ticketId,
      toolUseId: tu.id,
      tool: tu.name,
      input: tu.input,
      reason: decision.reason,
      policyVersion: policy.version,
      auditId,
      status: "pending",
      requestedAt: new Date(),
    });
    await db.collection(C.tickets).updateOne({ _id: run.ticketId }, { $set: { status: "awaiting_approval", updatedAt: new Date() } });
    // Ring the landlord (press 1 to approve / 2 to decline). Fire-and-forget; failures are audited.
    void import("../approvals").then((m) => m.phoneLandlordsForApproval(run.orgId, ins.insertedId)).catch((e) => console.error("[approval call]", e));
    return { pause: true };
  }

  if (tu.name === "wait_for_tenant") {
    const until = new Date(Date.now() + 10 * 60 * 1000);
    await db.collection(C.tickets).updateOne({ _id: run.ticketId }, { $set: { awaitingTenant: true } });
    await updateAuditResult(auditId, { status: "confirmed", detail: { waitingForTenantUntil: until.toISOString() } });
    return { wait: until };
  }
  if (tu.name === "wait_for_quotes") {
    const secs = Math.max(15, Math.min(120, Number(tu.input.seconds) || 45));
    const until = new Date(Date.now() + secs * 1000);
    await updateAuditResult(auditId, { status: "confirmed", detail: { sleepingUntil: until.toISOString() } });
    return { wait: until };
  }

  const exec = EXECUTORS[tu.name];
  const ctx = { orgId: run.orgId, ticketId: run.ticketId, runId: run._id, agentName: AGENT_NAME };
  let outcome;
  try {
    outcome = exec ? await exec(tu.input, ctx) : { status: "failed" as const, output: { error: "Unknown tool" }, isError: true };
  } catch (e) {
    outcome = { status: "failed" as const, output: { error: (e as Error).message }, isError: true };
  }
  await updateAuditResult(auditId, { status: outcome.status, detail: outcome.output, providerId: outcome.providerId });
  return { result: { type: "tool_result", tool_use_id: tu.id, is_error: outcome.isError, content: JSON.stringify(outcome.output) } };
}

export async function runAgent(runId: ObjectId) {
  const db = await getDb();
  // Lease-based lock so two requests can't drive the same run concurrently.
  const now = new Date();
  const locked = await db.collection(C.runs).findOneAndUpdate(
    { _id: runId, status: "running", $or: [{ lockedUntil: null }, { lockedUntil: { $exists: false } }, { lockedUntil: { $lt: now } }] },
    { $set: { lockedUntil: new Date(now.getTime() + 90_000) } },
    { returnDocument: "after" }
  );
  if (!locked) return;
  let run: any = locked;

  const persist = async (set: Record<string, unknown>) => {
    await db.collection(C.runs).updateOne({ _id: runId }, { $set: { ...set, updatedAt: new Date(), lockedUntil: new Date(Date.now() + 90_000) } });
    run = { ...run, ...set };
  };
  const finish = async (status: string, extra: Record<string, unknown> = {}) => {
    await db.collection(C.runs).updateOne({ _id: runId }, { $set: { status, ...extra, lockedUntil: null, updatedAt: new Date() } });
  };

  // ---- Resume after a human decision on a pending approval ----
  if (run.pending) {
    const approval = await db.collection(C.approvals).findOne({ runId, toolUseId: run.pending.toolUse.id });
    if (!approval || approval.status === "pending") return finish("awaiting_approval");
    const results: ToolResult[] = [...run.pending.priorResults];
    if (approval.status === "approved") {
      const tu: ToolUse = { ...run.pending.toolUse, input: { ...run.pending.toolUse.input, ...(approval.overrideInput || {}) } };
      const r = await gatedCall(run, tu, true);
      results.push(r.result!);
    } else {
      results.push({ type: "tool_result", tool_use_id: run.pending.toolUse.id, is_error: true, content: JSON.stringify({ rejected_by_landlord: true, note: approval.note || "" }) });
    }
    for (const d of run.pending.deferred as ToolUse[])
      results.push({ type: "tool_result", tool_use_id: d.id, is_error: true, content: JSON.stringify({ deferred: "Not executed because an approval was pending. Re-issue if still needed." }) });
    await persist({ messages: [...run.messages, { role: "user", content: results }], pending: null });
  }

  // ---- Resume after sleeping for contractor quotes ----
  if (run.waiting) {
    if (new Date(run.waiting.until) > new Date()) return finish("waiting", { resumeAt: run.waiting.until });
    const ticket = await db.collection(C.tickets).findOne({ _id: run.ticketId });
    const names = new Map(
      (await db.collection(C.contractors).find({ _id: { $in: (ticket?.candidateContractorIds ?? []) } }).toArray()).map((c) => [String(c._id), c.name])
    );
    const quotes = (ticket?.quotes ?? []).map((q: any) => ({
      contractor_id: String(q.contractorId),
      contractor: names.get(String(q.contractorId)),
      amount_cents: q.amountCents,
      availability: q.availability,
      said: q.raw,
      source: q.source,
    }));
    const waitedFor = run.waiting.toolUse.name;
    const payload =
      waitedFor === "wait_for_tenant"
        ? { tenant_answer: ticket?.diyResult ?? "no_answer" }
        : { quotes, contacted: ticket?.contacts?.length ?? 0 };
    if (waitedFor === "wait_for_tenant") await db.collection(C.tickets).updateOne({ _id: run.ticketId }, { $set: { awaitingTenant: false } });
    const results: ToolResult[] = [...run.waiting.priorResults, { type: "tool_result", tool_use_id: run.waiting.toolUse.id, content: JSON.stringify(payload) }];
    for (const d of run.waiting.deferred as ToolUse[])
      results.push({ type: "tool_result", tool_use_id: d.id, is_error: true, content: JSON.stringify({ deferred: "Not executed during wait. Re-issue if still needed." }) });
    await persist({ messages: [...run.messages, { role: "user", content: results }], waiting: null, resumeAt: null });
  }

  // ---- Crash recovery: last checkpoint is an assistant turn whose tool calls never got results.
  // Re-drive them through the gate; any call that already took effect is reused, not re-sent.
  const last = run.messages[run.messages.length - 1];
  if (last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b: any) => b.type === "tool_use")) {
    const tus = last.content.filter((b: any) => b.type === "tool_use") as ToolUse[];
    const results: ToolResult[] = [];
    for (let j = 0; j < tus.length; j++) {
      const r = await gatedCall(run, tus[j], false);
      if (r.pause) {
        await persist({ pending: { toolUse: tus[j], priorResults: results, deferred: tus.slice(j + 1) } });
        return finish("awaiting_approval");
      }
      if (r.wait) {
        await persist({ waiting: { toolUse: tus[j], priorResults: results, deferred: tus.slice(j + 1), until: r.wait } });
        return finish("waiting", { resumeAt: r.wait });
      }
      results.push(r.result!);
    }
    await writeAudit({ orgId: run.orgId, runId, ticketId: run.ticketId, actor: { type: "system", id: "runner", name: "Agent runner" }, action: "agent.run.recovered", reason: `Recovered ${tus.length} in-flight tool call(s) from checkpoint`, result: { status: "confirmed" } });
    await persist({ messages: [...run.messages, { role: "user", content: results }] });
  }

  for (let i = 0; i < MAX_STEPS; i++) {
    const fresh = await db.collection(C.runs).findOne({ _id: runId }, { projection: { stopRequested: 1 } });
    if (fresh?.stopRequested) {
      await writeAudit({ orgId: run.orgId, runId, ticketId: run.ticketId, actor: { type: "system", id: "runner", name: "Agent runner" }, action: "agent.run.halted", reason: "Stop requested by a human; no further actions taken.", result: { status: "confirmed" } });
      return finish("stopped");
    }

    const content = await nextAssistantMessage(run);
    const messages: Msg[] = [...run.messages, { role: "assistant", content }];
    await persist({ messages, step: (run.step ?? 0) + 1 }); // checkpoint before acting

    const toolUses = content.filter((b): b is ToolUse => b.type === "tool_use") as ToolUse[];
    if (!toolUses.length) {
      const text = content.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
      await writeAudit({ orgId: run.orgId, runId, ticketId: run.ticketId, actor: { type: "agent", id: `agent:${AGENT_NAME}`, name: "Maintenance agent" }, action: "agent.run.completed", reason: text.slice(0, 500), result: { status: "confirmed" } });
      return finish("completed", { summary: text });
    }

    const results: ToolResult[] = [];
    for (let j = 0; j < toolUses.length; j++) {
      const r = await gatedCall(run, toolUses[j], false);
      if (r.pause) {
        await persist({ pending: { toolUse: toolUses[j], priorResults: results, deferred: toolUses.slice(j + 1) } });
        return finish("awaiting_approval");
      }
      if (r.wait) {
        await persist({ waiting: { toolUse: toolUses[j], priorResults: results, deferred: toolUses.slice(j + 1), until: r.wait } });
        return finish("waiting", { resumeAt: r.wait });
      }
      results.push(r.result!);
    }
    await persist({ messages: [...messages, { role: "user", content: results }] });
  }
  return finish("failed", { error: `Exceeded ${MAX_STEPS} steps` });
}
