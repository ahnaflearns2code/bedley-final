import { ObjectId } from "mongodb";
import { C, getDb } from "./db";
import { writeAudit } from "./audit";
import { applyApprovalDecision, approvalSummary } from "./approvals";
import { YES, NO, answer } from "./conversation";

/**
 * In-app voice calls: Bedley "rings" the landlord inside the dashboard, speaks with the ElevenLabs
 * voice and listens through the browser microphone. Free alternative to phone calls on a Twilio trial.
 * Every turn is stored in voice_calls and in the audit ledger.
 */
export async function ringLandlordInApp(opts: { orgId: ObjectId; ticketId: ObjectId; kind: "briefing" | "approval"; script: string; approvalId?: ObjectId }) {
  const db = await getDb();
  const landlords = await db.collection(C.users).find({ orgId: opts.orgId, role: "landlord" }).toArray();
  for (const l of landlords) {
    await db.collection("voice_calls").insertOne({
      orgId: opts.orgId,
      userId: l._id,
      ticketId: opts.ticketId,
      approvalId: opts.approvalId ?? null,
      kind: opts.kind,
      script: opts.script,
      status: "ringing",
      transcript: [],
      createdAt: new Date(),
    });
  }
  const t = await db.collection(C.tickets).findOne({ _id: opts.ticketId });
  await writeAudit({
    orgId: opts.orgId,
    ticketId: opts.ticketId,
    runId: t?.agentRunId,
    actor: { type: "system", id: "notifier", name: "In-app call" },
    action: opts.kind === "briefing" ? "landlord.briefed_in_app" : "landlord.called_in_app_for_approval",
    input: { landlords: landlords.length },
    result: { status: landlords.length ? "sent" : "failed" },
  });
}

const ENDS = /\b(no(pe)?( questions)?|that'?s (all|it)|thanks|thank you|bye|goodbye|nothing|i'?m good|all good)\b/i;

/** One turn of an in-app call. Returns what Bedley says next and whether the call is over. */
export async function inAppTurn(callId: ObjectId, userId: ObjectId, heard: string): Promise<{ say: string; done: boolean }> {
  const db = await getDb();
  const call = await db.collection("voice_calls").findOne({ _id: callId, userId });
  if (!call) return { say: "Sorry, this call has ended.", done: true };
  const landlord = await db.collection(C.users).findOne({ _id: userId });
  const push = async (who: string, text: string) =>
    db.collection("voice_calls").updateOne({ _id: callId }, { $push: { transcript: { who, text, ts: new Date() } } as any });
  await push("landlord", heard);
  const t = await db.collection(C.tickets).findOne({ _id: call.ticketId });
  await writeAudit({
    orgId: call.orgId,
    ticketId: call.ticketId,
    runId: t?.agentRunId,
    actor: { type: "user", id: String(userId), name: `${landlord?.name ?? "Landlord"} (in-app call)` },
    action: "landlord.said",
    input: { heard, via: "in_app_call" },
    result: { status: "confirmed" },
  });
  const turns = (call.transcript?.length ?? 0) / 2;
  let out: { say: string; done: boolean };

  if (call.kind === "approval" && call.approvalId) {
    const sum = await approvalSummary(call.approvalId);
    if (!sum || sum.approval.status !== "pending") out = { say: "That one's already been handled. Thanks!", done: true };
    else if (YES.test(heard) && !NO.test(heard.replace(/no problem/i, ""))) {
      await applyApprovalDecision({ approvalId: sum.approval._id, orgId: sum.approval.orgId, decision: "approved", by: { userId: String(userId), name: landlord?.name ?? "Landlord" }, via: "phone", note: `Said on the in-app call: "${heard}"` });
      const tenantFirst = String(sum.tenant?.name ?? "the tenant").split(" ")[0];
      out = { say: `Great, I'm booking ${sum.contractor?.name ?? "them"} for ${String(sum.approval.input.proposed_window ?? "the earliest time").replace(/\.+$/, "")}. I'll let ${tenantFirst} know right away. Thanks, bye!`, done: true };
    } else if (NO.test(heard)) {
      await applyApprovalDecision({ approvalId: sum.approval._id, orgId: sum.approval.orgId, decision: "rejected", by: { userId: String(userId), name: landlord?.name ?? "Landlord" }, via: "phone", note: `Said on the in-app call: "${heard}"` });
      out = { say: "No problem, I won't book anyone. It's waiting in your dashboard if you'd like a different contractor. Bye!", done: true };
    } else if (turns >= 5) out = { say: "I'll leave this in your dashboard so you can decide there. Bye for now!", done: true };
    else out = { say: `${await answer(heard, sum.text)} Should I go ahead and book them?`, done: false };
  } else {
    if (ENDS.test(heard) || turns >= 4) out = { say: "Okay. I'll call you back shortly with the best quote. Talk soon!", done: true };
    else out = { say: `${await answer(heard, call.script)} Anything else you'd like to know?`, done: false };
  }
  await push("bedley", out.say);
  if (out.done) await db.collection("voice_calls").updateOne({ _id: callId }, { $set: { status: "ended", endedAt: new Date() } });
  return out;
}
