import { ObjectId } from "mongodb";
import { C, getClient, getDb } from "./db";
import { writeAudit } from "./audit";
import { decrypt } from "./encryption";
import { callAndSay } from "./integrations/twilio";
import { nudgeWorker } from "./agent/worker";

/**
 * One code path for every approval decision — from the dashboard button or from the landlord
 * pressing 1/2 on the phone. Approval + ticket update happen in one transaction, then the agent wakes.
 */
export async function applyApprovalDecision(opts: {
  approvalId: ObjectId;
  orgId: ObjectId;
  decision: "approved" | "rejected";
  by: { userId: string; name: string };
  via: "dashboard" | "phone";
  override?: Record<string, unknown>;
  note?: string;
}) {
  const db = await getDb();
  const approval = await db.collection(C.approvals).findOne({ _id: opts.approvalId, orgId: opts.orgId, status: "pending" });
  if (!approval) return { ok: false as const, error: "Approval not found or already decided" };
  const override = opts.override ?? {};

  const session = (await getClient()).startSession();
  try {
    await session.withTransaction(async () => {
      await db.collection(C.approvals).updateOne(
        { _id: opts.approvalId, status: "pending" },
        { $set: { status: opts.decision, decidedBy: opts.by, decidedVia: opts.via, decidedAt: new Date(), overrideInput: override, note: opts.note ?? "" } },
        { session }
      );
      await db.collection(C.tickets).updateOne(
        { _id: approval.ticketId },
        { $set: { status: opts.decision === "approved" ? "contractor_booked" : "contractor_search", updatedAt: new Date() } },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  await writeAudit({
    orgId: opts.orgId,
    runId: approval.runId,
    ticketId: approval.ticketId,
    actor: { type: "user", id: opts.by.userId, name: opts.by.name },
    action: `approval.${opts.decision}`,
    tool: approval.tool,
    toolUseId: approval.toolUseId,
    input: { ...approval.input, ...override, via: opts.via },
    reason: opts.note || (opts.via === "phone" ? "Decided by phone keypad" : undefined),
    result: { status: "confirmed" },
  });
  await db.collection(C.runs).updateOne({ _id: approval.runId }, { $set: { status: "running", updatedAt: new Date() } });
  nudgeWorker();
  return { ok: true as const, ticketId: approval.ticketId };
}

/** Plain-language summary of a pending approval (used for the phone conversation and the dashboard). */
export async function approvalSummary(approvalId: ObjectId) {
  const db = await getDb();
  const a = await db.collection(C.approvals).findOne({ _id: approvalId });
  if (!a) return null;
  const [ticket, contractor] = await Promise.all([
    db.collection(C.tickets).findOne({ _id: a.ticketId }),
    ObjectId.isValid(a.input.contractor_id) ? db.collection(C.contractors).findOne({ _id: new ObjectId(a.input.contractor_id) }) : null,
  ]);
  const [tenant, property, unit] = await Promise.all([
    ticket ? db.collection(C.tenants).findOne({ _id: ticket.tenantId }) : null,
    ticket ? db.collection(C.properties).findOne({ _id: ticket.propertyId }) : null,
    ticket ? db.collection(C.units).findOne({ _id: ticket.unitId }) : null,
  ]);
  const n = ticket?.contacts?.length ?? 0;
  const price = a.input.estimate_cents ? ` for ${Math.round(a.input.estimate_cents / 100)} dollars` : "";
  const urgent = ticket?.priority === "emergency" ? "an urgent issue" : "a major repair";
  const others = (ticket?.quotes ?? []).filter((q: any) => q.amountCents && String(q.contractorId) !== a.input.contractor_id).length;
  const text =
    `I'm calling about ${urgent} at ${property?.name ?? "your property"}, unit ${unit?.label ?? ""}. ` +
    `${tenant?.name ?? "Your tenant"} reported: ${ticket?.title ?? "a maintenance issue"}. ` +
    (n ? `I called ${n} local contractors${others ? ` and got ${others + 1} quotes` : ""}. ` : "") +
    `The best option is ${contractor?.name ?? "a contractor"}${contractor?.rating ? `, rated ${contractor.rating} stars,` : ""}${price}, and they can come ${String(a.input.proposed_window ?? "soon").replace(/\.+$/, "")}. ` +
    `Because it's a ${ticket?.priority === "emergency" ? "safety issue" : "bigger job"}, I wanted your OK before booking.`;
  return { approval: a, ticket, contractor, tenant, property, unit, text };
}

/** Phone the landlord(s) who asked to be called for approvals. Press 1 to approve, 2 to decline. */
export async function phoneLandlordsForApproval(orgId: ObjectId, approvalId: ObjectId) {
  const db = await getDb();
  const sum = await approvalSummary(approvalId);
  if (!sum) return;
  const urgent = sum.ticket?.priority === "emergency" || sum.ticket?.majorRepair;

  const landlords = (await db.collection(C.users).find({ orgId, role: "landlord" }).toArray()).filter((l) => urgent || l.callForApprovals !== false);
  for (const l of landlords) {
    const phone = l.phoneEnc ? await decrypt(l.phoneEnc) : process.env.DEMO_LANDLORD_PHONE || null;
    if (!phone) continue;
    const res = await callAndSay(
      phone,
      `Hi ${String(l.name).split(" ")[0]}, it's Bedley again${sum.ticket?.landlordBriefedAt ? ", calling back as promised" : ""}. ${sum.text}`,
      undefined,
      {
        action: `/api/voice/landlord?a=${approvalId}&u=${l._id}&turn=1`,
        prompt: "Would you like me to book them? You can say yes or no, ask me a question, or press 1 to approve and 2 to decline. I'm also calling you in the Bedley app.",
        input: "speech dtmf",
      },
      { allowTemplate: true }
    );
    await writeAudit({
      orgId,
      runId: sum.approval.runId,
      ticketId: sum.approval.ticketId,
      actor: { type: "system", id: "notifier", name: "Approval notifier" },
      action: "landlord.phoned_for_approval",
      input: { landlord: l.name },
      result: { status: res.status, detail: res.detail, providerId: res.providerId },
    });
  }
  // Then ring inside the Bedley app for the full conversation
  const { ringLandlordInApp } = await import("./browserCalls");
  await ringLandlordInApp({
    orgId,
    ticketId: sum.approval.ticketId,
    kind: "approval",
    approvalId,
    script: `Hi, it's Bedley again${sum.ticket?.landlordBriefedAt ? ", calling back as promised" : ""}. ${sum.text} Would you like me to book them?`,
  });
}

/**
 * Emergency / major-repair briefing: the moment triage flags it, Bedley phones the landlord and
 * explains what's happening — before any contractor is found. Always calls (ignores the
 * "call me for approvals" toggle), because the landlord must know about emergencies.
 */
export async function briefLandlordsNow(orgId: ObjectId, ticketId: ObjectId) {
  const db = await getDb();
  const t = await db.collection(C.tickets).findOne({ _id: ticketId, orgId });
  if (!t || t.landlordBriefedAt) return;
  await db.collection(C.tickets).updateOne({ _id: ticketId }, { $set: { landlordBriefedAt: new Date() } });
  const [tenant, unit, property] = await Promise.all([
    db.collection(C.tenants).findOne({ _id: t.tenantId }),
    db.collection(C.units).findOne({ _id: t.unitId }),
    db.collection(C.properties).findOne({ _id: t.propertyId }),
  ]);
  const landlords = await db.collection(C.users).find({ orgId, role: "landlord" }).toArray();
  const urgent = t.priority === "emergency";
  const tenantName = tenant?.name ?? "Your tenant";
  const tenantFirst = String(tenantName).split(" ")[0];
  const said = String(t.description || "").slice(0, 220).replace(/[.\s]+$/, "");
  const trade = String(t.trade || "contractors");
  const safety = urgent
    ? t.emergencyInstructions || "I've told them how to stay safe."
    : t.diySteps?.length
    ? `I've sent ${tenantFirst} steps to limit the damage in the meantime.`
    : `I've let ${tenantFirst} know help is on the way.`;

  let reached = 0;
  for (const l of landlords) {
    const phone = l.phoneEnc ? await decrypt(l.phoneEnc) : process.env.DEMO_LANDLORD_PHONE || null;
    if (!phone) continue;
    const script =
      `Hi ${String(l.name).split(" ")[0]}, this is Bedley, your property assistant, with ${urgent ? "an urgent" : "an important"} update. ` +
      `${tenantName} at ${property?.name ?? "your property"}, unit ${unit?.label ?? ""}, just reported: ${t.title}. ` +
      `In their words: ${said}. ` +
      `${safety} ` +
      `I'm calling local ${trade}s right now and I'll call you back in about a minute with the best quote so you can approve it. ` +
      `You'll also see everything in your Bedley dashboard.`;
    // Phone alert first (rings the landlord's real phone). On a Twilio trial this may play Twilio's
    // generic message, but it still rings — then Bedley calls in the app with the full conversation.
    const res = await callAndSay(
      phone,
      `${script} I'm also calling you in the Bedley app right now so we can talk it through.`,
      undefined,
      undefined,
      { allowTemplate: true }
    );
    reached++;
    await writeAudit({
      orgId,
      ticketId,
      runId: t.agentRunId,
      actor: { type: "system", id: "notifier", name: "Emergency notifier" },
      action: "landlord.briefed_by_phone",
      input: { landlord: l.name, urgent },
      result: { status: res.status, detail: res.detail, providerId: res.providerId },
    });
  }
  // Also ring the landlord inside the Bedley dashboard (works without a paid phone plan).
  const inAppScript =
    `Hi, this is Bedley with ${urgent ? "an urgent" : "an important"} update. ${tenantName} at ${property?.name ?? "your property"}, unit ${unit?.label ?? ""}, just reported: ${t.title}. ` +
    `In their words: ${said}. ${safety} I'm calling local ${trade}s right now and I'll call you back shortly with the best quote so you can approve it. Do you have any questions?`;
  const { ringLandlordInApp } = await import("./browserCalls");
  await ringLandlordInApp({ orgId, ticketId, kind: "briefing", script: inAppScript });
  reached += landlords.length;
  const { postLandlordUpdate } = await import("./landlordUpdates");
  await postLandlordUpdate(
    orgId,
    ticketId,
    `${urgent ? "Urgent" : "Major repair"}: ${tenantName} at ${property?.name ?? "your property"}, unit ${unit?.label ?? ""} reported "${t.title}". ` +
      (reached ? "Bedley called you about it and is getting quotes now." : "Bedley couldn't call you — add your phone number in Settings so it can reach you in emergencies.")
  );
}
