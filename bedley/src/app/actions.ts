"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { C, getClient, getDb, oid } from "@/lib/db";
import { createSession, destroySession, requireRole, getSession } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { startRun } from "@/lib/agent/runner";
import { applyApprovalDecision } from "@/lib/approvals";
import { firstResponse } from "@/lib/firstResponse";
import { nudgeWorker } from "@/lib/agent/worker";
import { savePolicy, loadPolicy } from "@/lib/policy";
import { decrypt, encryptDeterministic, encryptRandom, normalizePhone } from "@/lib/encryption";
import { postMessage, Channel } from "@/lib/messaging";
import { callAndSay, contractorDestination, sendSms, startBridgedCall } from "@/lib/integrations/twilio";
import { stripe } from "@/lib/integrations/stripe";
import { luhnValid } from "@/lib/redact";

const base = () => (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

// ---------------------------------------------------------------- auth
export async function login(_prev: unknown, fd: FormData): Promise<{ error?: string }> {
  const email = String(fd.get("email") || "").toLowerCase().trim();
  const password = String(fd.get("password") || "");
  const db = await getDb();
  const user = await db.collection(C.users).findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return { error: "Incorrect email or password." };
  await createSession({
    userId: String(user._id),
    orgId: String(user.orgId),
    role: user.role,
    name: user.name,
    tenantId: user.tenantId ? String(user.tenantId) : undefined,
  });
  await db.collection(C.users).updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  redirect(user.role === "tenant" ? "/tenant" : "/landlord");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

// ---------------------------------------------------------------- tenant: report issue
const TicketSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().min(10).max(4000),
  availability: z.string().max(200).optional(),
});

export async function createTicket(_prev: unknown, fd: FormData): Promise<{ error?: string; reply?: string; steps?: string[]; ticketId?: string; title?: string; description?: string; priority?: string; major?: boolean }> {
  const s = await requireRole("tenant");
  const parsed = TicketSchema.safeParse({
    title: fd.get("title"),
    description: fd.get("description"),
    availability: fd.get("availability") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const db = await getDb();
  const tenant = await db.collection(C.tenants).findOne({ _id: oid(s.tenantId!), orgId: oid(s.orgId) });
  if (!tenant) return { error: "Tenant record not found." };
  const unit = await db.collection(C.units).findOne({ _id: tenant.unitId });

  let photo: { name: string; type: string; dataUrl: string } | null = null;
  const file = fd.get("photo");
  if (file && file instanceof File && file.size > 0) {
    if (!/^image\/(jpeg|png|webp|heic)$/.test(file.type)) return { error: "Photo must be JPEG, PNG, WebP or HEIC." };
    if (file.size > 3_000_000) return { error: "Photo must be under 3 MB." };
    const buf = Buffer.from(await file.arrayBuffer());
    photo = { name: file.name, type: file.type, dataUrl: `data:${file.type};base64,${buf.toString("base64")}` };
  }

  const r = await db.collection(C.tickets).insertOne({
    orgId: oid(s.orgId),
    propertyId: unit!.propertyId,
    unitId: tenant.unitId,
    tenantId: tenant._id,
    ...parsed.data,
    photos: photo ? [photo] : [],
    status: "new",
    priority: null,
    createdBy: s.userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await writeAudit({
    orgId: oid(s.orgId),
    ticketId: r.insertedId,
    actor: { type: "user", id: s.userId, name: s.name },
    action: "ticket.created",
    input: parsed.data,
    result: { status: "confirmed" },
  });
  // Instant answer for the tenant on the same page, while the always-on agent picks up the ticket.
  const property = await db.collection(C.properties).findOne({ _id: unit!.propertyId });
  const fr = await firstResponse({ title: parsed.data.title, description: parsed.data.description, property: property?.name });
  await db.collection(C.tickets).updateOne({ _id: r.insertedId }, { $set: { aiFirstResponse: fr } });
  await postMessage({
    orgId: oid(s.orgId),
    tenantId: tenant._id,
    ticketId: r.insertedId,
    channel: "in_app",
    body: fr.reply + (fr.steps.length ? "\n\nRight now:\n" + fr.steps.map((x, i) => `${i + 1}. ${x}`).join("\n") : ""),
    sender: { type: "agent", id: "agent:first-response", name: "Bedley AI" },
  });
  nudgeWorker();
  return { reply: fr.reply, steps: fr.steps, ticketId: String(r.insertedId), title: parsed.data.title, description: parsed.data.description, priority: fr.priority, major: fr.major };
}

/** Tenant reports whether the AI's DIY fix worked. Wakes the sleeping agent immediately. */
export async function tenantDiyAnswer(fd: FormData) {
  const s = await requireRole("tenant");
  const db = await getDb();
  const id = oid(String(fd.get("ticketId")));
  const answer = fd.get("answer") === "fixed" ? "fixed" : "not_fixed";
  const t = await db.collection(C.tickets).findOne({ _id: id, orgId: oid(s.orgId), tenantId: oid(s.tenantId!) });
  if (!t) throw new Error("Not found");
  await db.collection(C.tickets).updateOne(
    { _id: id },
    { $set: { diyResult: answer, awaitingTenant: false, status: answer === "fixed" ? "completed" : "contractor_search", updatedAt: new Date() } }
  );
  if (t.agentRunId) await db.collection(C.runs).updateOne({ _id: t.agentRunId, status: "waiting" }, { $set: { resumeAt: new Date(), "waiting.until": new Date() } });
  await writeAudit({ orgId: oid(s.orgId), ticketId: id, runId: t.agentRunId, actor: { type: "user", id: s.userId, name: s.name }, action: answer === "fixed" ? "tenant.diy_fixed" : "tenant.diy_not_fixed", result: { status: "confirmed" } });
  nudgeWorker();
  revalidatePath(`/tenant/tickets/${id}`);
}

export async function tenantConfirmFixed(fd: FormData) {
  const s = await requireRole("tenant");
  const db = await getDb();
  const id = oid(String(fd.get("ticketId")));
  const fixed = fd.get("fixed") === "yes";
  const r = await db.collection(C.tickets).updateOne(
    { _id: id, orgId: oid(s.orgId), tenantId: oid(s.tenantId!) },
    { $set: { status: fixed ? "completed" : "in_progress", tenantConfirmedFixed: fixed, updatedAt: new Date() } }
  );
  if (r.matchedCount)
    await writeAudit({ orgId: oid(s.orgId), ticketId: id, actor: { type: "user", id: s.userId, name: s.name }, action: fixed ? "ticket.tenant_confirmed_fixed" : "ticket.tenant_reported_not_fixed", result: { status: "confirmed" } });
  revalidatePath(`/tenant/tickets/${id}`);
}

// ---------------------------------------------------------------- landlord: approvals & run control
export async function decideApproval(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const approvalId = oid(String(fd.get("approvalId")));
  const decision = String(fd.get("decision"));
  if (!["approved", "rejected"].includes(decision)) throw new Error("Bad decision");
  const approval = await db.collection(C.approvals).findOne({ _id: approvalId, orgId: oid(s.orgId), status: "pending" });
  if (!approval) throw new Error("Approval not found or already decided");

  const override: Record<string, unknown> = {};
  const chosen = String(fd.get("contractorId") || "");
  if (chosen && chosen !== approval.input.contractor_id) {
    const c = await db.collection(C.contractors).findOne({ _id: oid(chosen), orgId: oid(s.orgId) });
    if (!c) throw new Error("Contractor not in your organisation");
    override.contractor_id = chosen;
  }
  const est = String(fd.get("estimate") || "").trim();
  if (est) {
    const cents = Math.round(parseFloat(est.replace(/[$,]/g, "")) * 100);
    if (!Number.isFinite(cents) || cents < 0) throw new Error("Bad amount");
    override.estimate_cents = cents;
  }
  const window = String(fd.get("window") || "").trim();
  if (window) override.proposed_window = window.slice(0, 120);

  const r = await applyApprovalDecision({
    approvalId,
    orgId: oid(s.orgId),
    decision: decision as "approved" | "rejected",
    by: { userId: s.userId, name: s.name },
    via: "dashboard",
    override,
    note: String(fd.get("note") || ""),
  });
  if (!r.ok) throw new Error(r.error);
  revalidatePath(`/landlord/tickets/${approval.ticketId}`);
}

export async function stopRun(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const runId = oid(String(fd.get("runId")));
  const run = await db.collection(C.runs).findOneAndUpdate(
    { _id: runId, orgId: oid(s.orgId) },
    { $set: { stopRequested: true, stoppedBy: { userId: s.userId, name: s.name }, updatedAt: new Date() } }
  );
  if (!run) throw new Error("Run not found");
  // If idle (awaiting approval), stop immediately; if running, the runner halts before its next step.
  if (run.status !== "running") await db.collection(C.runs).updateOne({ _id: runId }, { $set: { status: "stopped" } });
  await db.collection(C.approvals).updateMany({ runId, status: "pending" }, { $set: { status: "rejected", note: "Run stopped", decidedAt: new Date() } });
  await writeAudit({ orgId: oid(s.orgId), runId, ticketId: run.ticketId, actor: { type: "user", id: s.userId, name: s.name }, action: "agent.run.stop_requested", result: { status: "confirmed" } });
  revalidatePath(`/landlord/tickets/${run.ticketId}`);
}

/** Resume a run whose worker died mid-flight (lock expired). Picks up from the last checkpoint; completed tool calls are not replayed. */
export async function resumeRun(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const runId = oid(String(fd.get("runId")));
  const run = await db.collection(C.runs).findOne({ _id: runId, orgId: oid(s.orgId) });
  if (!run) throw new Error("Run not found");
  await db.collection(C.runs).updateOne({ _id: runId }, { $set: { status: "running", lockedUntil: null, stopRequested: false } });
  await writeAudit({ orgId: oid(s.orgId), runId, ticketId: run.ticketId, actor: { type: "user", id: s.userId, name: s.name }, action: "agent.run.resumed", reason: `Resumed from step ${run.step ?? 0}`, result: { status: "confirmed" } });
  nudgeWorker();
  revalidatePath(`/landlord/tickets/${run.ticketId}`);
}

export async function restartAgent(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const ticketId = oid(String(fd.get("ticketId")));
  const db = await getDb();
  const t = await db.collection(C.tickets).findOne({ _id: ticketId, orgId: oid(s.orgId) });
  if (!t) throw new Error("Ticket not found");
  await startRun({ orgId: oid(s.orgId), ticketId, startedBy: { userId: s.userId, role: s.role, name: s.name } });
  nudgeWorker();
  revalidatePath(`/landlord/tickets/${ticketId}`);
}

export async function recordQuote(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const ticketId = oid(String(fd.get("ticketId")));
  const contractorId = oid(String(fd.get("contractorId")));
  const amount = Math.round(parseFloat(String(fd.get("amount") || "").replace(/[$,]/g, "")) * 100);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter an amount");
  const quote = {
    contractorId,
    amountCents: amount,
    callOutCents: fd.get("callout") ? Math.round(parseFloat(String(fd.get("callout"))) * 100) : null,
    availability: String(fd.get("availability") || "").slice(0, 120),
    source: "landlord_entered",
    kind: String(fd.get("kind") || "verbal_estimate"),
    receivedAt: new Date(),
    enteredBy: s.name,
  };
  const r = await db.collection(C.tickets).updateOne({ _id: ticketId, orgId: oid(s.orgId) }, { $push: { quotes: quote } as any });
  if (!r.matchedCount) throw new Error("Ticket not found");
  await writeAudit({ orgId: oid(s.orgId), ticketId, actor: { type: "user", id: s.userId, name: s.name }, action: "quote.recorded", input: quote, result: { status: "confirmed" } });
  revalidatePath(`/landlord/tickets/${ticketId}`);
}

/** Compensating action: rolls back a booking and tells the contractor. */
export async function cancelBooking(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const ticketId = oid(String(fd.get("ticketId")));
  const t = await db.collection(C.tickets).findOne({ _id: ticketId, orgId: oid(s.orgId) });
  if (!t?.booking) throw new Error("No booking to cancel");
  const c = await db.collection(C.contractors).findOne({ _id: t.booking.contractorId });
  const dest = contractorDestination(c);
  const cancelText = `Hello, this is the automated A.I. assistant for your recent booking. The property manager has cancelled the booking for ${t.booking.window}. Sorry for any inconvenience.`;
  const sms = dest.to
    ? process.env.TWILIO_SMS_ENABLED === "1"
      ? await sendSms(dest.to, cancelText)
      : await callAndSay(dest.to, cancelText)
    : { status: "failed" as const, detail: "No phone" };
  await db.collection(C.tickets).updateOne({ _id: ticketId }, { $set: { status: "contractor_search", updatedAt: new Date(), previousBooking: t.booking }, $unset: { booking: "" } });
  await writeAudit({
    orgId: oid(s.orgId),
    ticketId,
    actor: { type: "user", id: s.userId, name: s.name },
    action: "booking.cancelled (compensating action)",
    input: { contractor: t.booking.contractorName, window: t.booking.window },
    result: { status: sms.status, detail: sms.detail, providerId: (sms as any).providerId },
  });
  revalidatePath(`/landlord/tickets/${ticketId}`);
}

export async function closeTicket(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const ticketId = oid(String(fd.get("ticketId")));
  const finalCost = String(fd.get("finalCost") || "").trim();
  const cents = finalCost ? Math.round(parseFloat(finalCost.replace(/[$,]/g, "")) * 100) : null;
  await db.collection(C.tickets).updateOne(
    { _id: ticketId, orgId: oid(s.orgId) },
    { $set: { status: "closed", finalCostCents: cents, resolutionNotes: String(fd.get("notes") || ""), closedAt: new Date(), updatedAt: new Date() } }
  );
  await writeAudit({ orgId: oid(s.orgId), ticketId, actor: { type: "user", id: s.userId, name: s.name }, action: "ticket.closed", input: { finalCostCents: cents }, result: { status: "confirmed" } });
  revalidatePath(`/landlord/tickets/${ticketId}`);
}

// ---------------------------------------------------------------- policy
export async function savePolicyAction(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const cur = await loadPolicy(oid(s.orgId));
  const tools: Record<string, "allow" | "approval" | "deny"> = { ...cur.tools };
  for (const k of Object.keys(tools)) {
    const v = String(fd.get(`tool_${k}`) || tools[k]);
    if (["allow", "approval", "deny"].includes(v)) tools[k] = v as any;
  }
  tools.propose_booking = tools.propose_booking === "allow" ? "approval" : tools.propose_booking; // bookings can never be auto-approved
  const dollars = (n: string, d: number) => {
    const v = parseFloat(String(fd.get(n) || ""));
    return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : d;
  };
  const next = {
    killSwitch: fd.get("killSwitch") === "on",
    spendingLimitCents: dollars("spendingLimit", cur.spendingLimitCents),
    hardCapCents: dollars("hardCap", cur.hardCapCents),
    maxContractorsContacted: Math.max(0, Math.min(10, parseInt(String(fd.get("maxContractors") || cur.maxContractorsContacted)))),
    autoBookMinor: fd.get("autoBookMinor") === "on",
    tools,
  };
  const version = await savePolicy(oid(s.orgId), next, s.userId);
  await writeAudit({ orgId: oid(s.orgId), actor: { type: "user", id: s.userId, name: s.name }, action: "policy.updated", input: next, policyVersion: version, result: { status: "confirmed" } });
  revalidatePath("/landlord/settings");
}

export async function toggleKillSwitch(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const cur = await loadPolicy(oid(s.orgId));
  const on = fd.get("on") === "1";
  const { version: _v, ...rest } = cur;
  const version = await savePolicy(oid(s.orgId), { ...rest, killSwitch: on }, s.userId);
  if (on) {
    const db = await getDb();
    await db.collection(C.runs).updateMany({ orgId: oid(s.orgId), status: { $in: ["running", "awaiting_approval"] } }, { $set: { stopRequested: true } });
  }
  await writeAudit({ orgId: oid(s.orgId), actor: { type: "user", id: s.userId, name: s.name }, action: on ? "policy.kill_switch.on" : "policy.kill_switch.off", policyVersion: version, result: { status: "confirmed" } });
  revalidatePath("/landlord");
  revalidatePath("/landlord/settings");
}

// ---------------------------------------------------------------- contractors directory
export async function addContractor(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const name = String(fd.get("name") || "").trim();
  const phone = normalizePhone(String(fd.get("phone") || ""));
  const trade = String(fd.get("trade") || "").toLowerCase().trim();
  if (!name || !trade) throw new Error("Name and trade required");
  const db = await getDb();
  await db.collection(C.contractors).insertOne({
    orgId: oid(s.orgId),
    name,
    phone,
    trades: [trade],
    source: "saved",
    verification: fd.get("verified") === "on" ? "landlord_verified" : "unverified",
    rating: null,
    reviews: null,
    createdAt: new Date(),
  });
  revalidatePath("/landlord/settings");
}

// ---------------------------------------------------------------- sensitive data
const SensitiveSchema = z.object({
  tenantId: z.string(),
  sin: z.string().optional(),
  dob: z.string().optional(),
  phone: z.string().optional(),
  consent: z.string().optional(),
});

export async function updateSensitive(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: string }> {
  const s = await requireRole("landlord", "admin", "tenant");
  const p = SensitiveSchema.parse(Object.fromEntries(fd));
  const tenantId = oid(p.tenantId);
  if (s.role === "tenant" && s.tenantId !== p.tenantId) return { error: "Not allowed." };
  const db = await getDb();
  const tenant = await db.collection(C.tenants).findOne({ _id: tenantId, orgId: oid(s.orgId) });
  if (!tenant) return { error: "Tenant not found." };

  const set: Record<string, unknown> = { updatedAt: new Date() };
  const changed: string[] = [];
  if (p.sin) {
    const d = p.sin.replace(/\D/g, "");
    if (d.length !== 9 || !luhnValid(d)) return { error: "That is not a valid SIN." };
    if (p.consent !== "on") return { error: "Record the tenant's consent before storing a SIN (it is optional)." };
    set.sinEnc = await encryptRandom(d);
    set.sinLast3 = d.slice(-3);
    set.sinPurpose = "credit_check";
    set.sinDeleteAfter = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    changed.push("sin");
    await db.collection(C.consents).insertOne({ orgId: oid(s.orgId), tenantId, field: "sin", purpose: "credit_check", recordedBy: s.userId, at: new Date() });
  }
  if (p.dob) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dob)) return { error: "Date of birth must be YYYY-MM-DD." };
    set.dobEnc = await encryptRandom(p.dob);
    changed.push("dob");
  }
  if (p.phone) {
    const n = normalizePhone(p.phone);
    set.phoneEnc = await encryptDeterministic(n);
    set.phoneLast4 = n.slice(-4);
    changed.push("phone");
  }
  if (!changed.length) return { error: "Nothing to save." };
  await db.collection(C.tenants).updateOne({ _id: tenantId }, { $set: set });
  await writeAudit({ orgId: oid(s.orgId), actor: { type: "user", id: s.userId, name: s.name }, action: "pii.updated", input: { tenantId: p.tenantId, fields: changed }, result: { status: "confirmed" } });
  revalidatePath(`/landlord/tenants/${p.tenantId}`);
  return { ok: `Encrypted and saved: ${changed.join(", ")}` };
}

export async function revealSin(_prev: unknown, fd: FormData): Promise<{ value?: string; error?: string }> {
  const s = await requireRole("landlord", "admin", "tenant");
  const tenantId = String(fd.get("tenantId"));
  const reason = String(fd.get("reason") || "").trim();
  const password = String(fd.get("password") || "");
  if (s.role === "tenant" && s.tenantId !== tenantId) return { error: "Not allowed." };
  if (s.role !== "tenant" && reason.length < 8) return { error: "Enter a reason (8+ characters). It is recorded in the audit ledger." };
  const db = await getDb();
  const user = await db.collection(C.users).findOne({ _id: oid(s.userId) });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    await writeAudit({ orgId: oid(s.orgId), actor: { type: "user", id: s.userId, name: s.name }, action: "pii.reveal.denied", input: { tenantId, field: "sin" }, reason: "Re-authentication failed", result: { status: "blocked" } });
    return { error: "Password incorrect." };
  }
  const tenant = await db.collection(C.tenants).findOne({ _id: oid(tenantId), orgId: oid(s.orgId) });
  if (!tenant?.sinEnc) return { error: "No SIN on file." };
  const value = await decrypt(tenant.sinEnc);
  await writeAudit({ orgId: oid(s.orgId), actor: { type: "user", id: s.userId, name: s.name }, action: "pii.revealed", input: { tenantId, field: "sin" }, reason: reason || "Tenant viewed own record", result: { status: "confirmed" } });
  return { value: value ? `${value.slice(0, 3)} ${value.slice(3, 6)} ${value.slice(6)}` : undefined };
}

export async function deleteSin(fd: FormData) {
  const s = await requireRole("landlord", "admin", "tenant");
  const tenantId = String(fd.get("tenantId"));
  if (s.role === "tenant" && s.tenantId !== tenantId) throw new Error("Not allowed");
  const db = await getDb();
  await db.collection(C.tenants).updateOne({ _id: oid(tenantId), orgId: oid(s.orgId) }, { $unset: { sinEnc: "", sinLast3: "", sinPurpose: "", sinDeleteAfter: "" } });
  await writeAudit({ orgId: oid(s.orgId), actor: { type: "user", id: s.userId, name: s.name }, action: "pii.deleted", input: { tenantId, field: "sin" }, result: { status: "confirmed" } });
  revalidatePath(`/landlord/tenants/${tenantId}`);
  revalidatePath(`/tenant/profile`);
}

export async function updateChannelPrefs(fd: FormData) {
  const s = await requireRole("tenant");
  const db = await getDb();
  const pref = String(fd.get("preferredChannel"));
  if (!["in_app", "call", "sms", "whatsapp", "email"].includes(pref)) throw new Error("Bad channel");
  const set: Record<string, unknown> = {
    preferredChannel: pref,
    optIn: { call: fd.get("optCall") === "on", sms: fd.get("optSms") === "on", whatsapp: fd.get("optWhatsapp") === "on", email: true },
    updatedAt: new Date(),
  };
  const phoneRaw = String(fd.get("phone") || "").trim();
  if (phoneRaw) {
    const n = normalizePhone(phoneRaw);
    if (!/^\+\d{10,15}$/.test(n)) throw new Error("Enter a valid phone number, e.g. 647-555-0123");
    set.phoneEnc = await encryptDeterministic(n);
    set.phoneLast4 = n.slice(-4);
  }
  await db.collection(C.tenants).updateOne({ _id: oid(s.tenantId!), orgId: oid(s.orgId) }, { $set: set });
  await writeAudit({ orgId: oid(s.orgId), actor: { type: "user", id: s.userId, name: s.name }, action: "consent.contact_details_updated", input: { tenantId: s.tenantId, pref, phoneChanged: !!phoneRaw, call: fd.get("optCall") === "on", sms: fd.get("optSms") === "on" }, result: { status: "confirmed" } });
  revalidatePath("/tenant/profile");
}

/** Landlord's own contact details — Twilio rings this number for approvals. */
export async function saveLandlordContact(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const set: Record<string, unknown> = { callForApprovals: fd.get("callForApprovals") === "on", updatedAt: new Date() };
  const name = String(fd.get("name") || "").trim();
  if (name) set.name = name.slice(0, 80);
  const phoneRaw = String(fd.get("phone") || "").trim();
  if (phoneRaw) {
    const n = normalizePhone(phoneRaw);
    if (!/^\+\d{10,15}$/.test(n)) throw new Error("Enter a valid phone number, e.g. 416-555-0123");
    set.phoneEnc = await encryptDeterministic(n);
    set.phoneLast4 = n.slice(-4);
  }
  await db.collection(C.users).updateOne({ _id: oid(s.userId), orgId: oid(s.orgId) }, { $set: set });
  await writeAudit({ orgId: oid(s.orgId), actor: { type: "user", id: s.userId, name: s.name }, action: "landlord.contact_details_updated", input: { phoneChanged: !!phoneRaw, callForApprovals: set.callForApprovals }, result: { status: "confirmed" } });
  revalidatePath("/landlord/settings");
}

export async function updateContractor(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const id = oid(String(fd.get("contractorId")));
  if (fd.get("remove") === "1") {
    await db.collection(C.contractors).updateOne({ _id: id, orgId: oid(s.orgId) }, { $set: { blacklisted: true, source: "removed" } });
  } else {
    const phone = normalizePhone(String(fd.get("phone") || ""));
    await db.collection(C.contractors).updateOne(
      { _id: id, orgId: oid(s.orgId) },
      { $set: { phone, verification: fd.get("verified") === "on" ? "landlord_verified" : "unverified", updatedAt: new Date() } }
    );
  }
  revalidatePath("/landlord/settings");
}

// ---------------------------------------------------------------- messaging
export async function sendMessageAction(fd: FormData) {
  const s = await getSession();
  if (!s) redirect("/login");
  const body = String(fd.get("body") || "").trim().slice(0, 2000);
  if (!body) return;
  const db = await getDb();
  const convo = await db.collection(C.conversations).findOne({ _id: oid(String(fd.get("conversationId"))), orgId: oid(s.orgId) });
  if (!convo) throw new Error("Conversation not found");
  if (s.role === "tenant" && String(convo.tenantId) !== s.tenantId) throw new Error("Not allowed");
  const channel = (s.role === "tenant" ? "in_app" : String(fd.get("channel") || "in_app")) as Channel;
  if (!["in_app", "sms", "whatsapp", "email"].includes(channel)) throw new Error("Bad channel");
  const r = await postMessage({ orgId: oid(s.orgId), tenantId: convo.tenantId, body, channel, sender: { type: "user", id: s.userId, name: s.name, role: s.role } });
  if (channel !== "in_app")
    await writeAudit({ orgId: oid(s.orgId), actor: { type: "user", id: s.userId, name: s.name }, action: `message.sent.${channel}`, input: { conversationId: String(convo._id) }, result: { status: r.delivery?.status ?? "confirmed", detail: r.delivery?.detail, providerId: r.delivery?.providerId } });
  revalidatePath(s.role === "tenant" ? "/tenant/messages" : "/landlord/messages");
}

export async function startCallAction(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const convo = await db.collection(C.conversations).findOne({ _id: oid(String(fd.get("conversationId"))), orgId: oid(s.orgId) });
  if (!convo) throw new Error("Conversation not found");
  const me = await db.collection(C.users).findOne({ _id: oid(s.userId) });
  const tenant = await db.collection(C.tenants).findOne({ _id: convo.tenantId });
  const myPhone = me?.phoneEnc ? await decrypt(me.phoneEnc) : null;
  const tenantPhone = tenant?.phoneEnc ? await decrypt(tenant.phoneEnc) : null;
  let result;
  if (!myPhone || !tenantPhone) result = { status: "failed" as const, detail: "Both parties need a phone number on file." };
  else result = await startBridgedCall(myPhone, tenantPhone, String(convo._id));
  await db.collection(C.calls).insertOne({ orgId: oid(s.orgId), conversationId: convo._id, initiatedBy: s.userId, providerId: (result as any).providerId ?? null, status: result.status, detail: result.detail, recording: false, startedAt: new Date() });
  await postMessage({ orgId: oid(s.orgId), tenantId: convo.tenantId, body: `Call ${result.status === "sent" ? "started" : result.status}: ${result.detail ?? ""}`, channel: "call", direction: "outbound", sender: { type: "system", id: "calls", name: "Masked call" } });
  revalidatePath("/landlord/messages");
}

// ---------------------------------------------------------------- payments
export async function payRent(fd: FormData) {
  const s = await requireRole("tenant");
  const db = await getDb();
  const rentId = oid(String(fd.get("rentId")));
  // Amount comes from the DB, never from the browser.
  const rec = await db.collection(C.rent).findOne({ _id: rentId, orgId: oid(s.orgId), tenantId: oid(s.tenantId!) });
  if (!rec) throw new Error("Rent record not found");
  if (rec.status === "paid" || rec.status === "processing") redirect("/tenant?pay=already");
  const st = stripe();
  if (!st) redirect("/tenant?pay=not_configured");
  const org = await db.collection(C.orgs).findOne({ _id: oid(s.orgId) });
  const attempt = (rec.paymentAttempts ?? 0) + 1;
  await db.collection(C.rent).updateOne({ _id: rentId }, { $set: { paymentAttempts: attempt } });
  const session = await st.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: "cad", unit_amount: rec.amountCents, product_data: { name: `Rent — ${rec.period}` } } }],
      success_url: `${base()}/tenant?pay=success`,
      cancel_url: `${base()}/tenant?pay=cancelled`,
      metadata: { rentRecordId: String(rec._id), tenantId: s.tenantId!, orgId: s.orgId },
      payment_intent_data: {
        metadata: { rentRecordId: String(rec._id), tenantId: s.tenantId!, orgId: s.orgId },
        ...(org?.stripeAccountId && org?.stripeChargesEnabled ? { transfer_data: { destination: org.stripeAccountId } } : {}),
      },
    },
    { idempotencyKey: `rent_${rec._id}_${attempt}` }
  );
  await writeAudit({ orgId: oid(s.orgId), actor: { type: "user", id: s.userId, name: s.name }, action: "payment.checkout_started", input: { rentRecordId: String(rec._id), amountCents: rec.amountCents }, result: { status: "pending", providerId: session.id } });
  redirect(session.url!);
}

export async function connectStripe() {
  const s = await requireRole("landlord");
  const st = stripe();
  if (!st) redirect("/landlord/settings?stripe=not_configured");
  const db = await getDb();
  const org = await db.collection(C.orgs).findOne({ _id: oid(s.orgId) });
  let accountId = org?.stripeAccountId as string | undefined;
  if (!accountId) {
    const acct = await st.accounts.create({ type: "express", country: "CA", capabilities: { card_payments: { requested: true }, transfers: { requested: true } } });
    accountId = acct.id;
    await db.collection(C.orgs).updateOne({ _id: oid(s.orgId) }, { $set: { stripeAccountId: accountId } });
  }
  const link = await st.accountLinks.create({ account: accountId, type: "account_onboarding", refresh_url: `${base()}/landlord/settings`, return_url: `${base()}/landlord/settings?stripe=returned` });
  redirect(link.url);
}

export async function markRentPaidManually(fd: FormData) {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const rentId = oid(String(fd.get("rentId")));
  const method = String(fd.get("method") || "e-transfer");
  const rec = await db.collection(C.rent).findOne({ _id: rentId, orgId: oid(s.orgId) });
  if (!rec || rec.status === "paid") return;
  await db.collection(C.payments).insertOne({ orgId: rec.orgId, rentRecordId: rec._id, tenantId: rec.tenantId, amountCents: rec.amountCents, method, recordedBy: s.userId, status: "succeeded", createdAt: new Date() });
  await db.collection(C.rent).updateOne({ _id: rentId }, { $set: { status: "paid", paidAt: new Date(), paidVia: method } });
  await writeAudit({ orgId: oid(s.orgId), actor: { type: "user", id: s.userId, name: s.name }, action: "payment.recorded_manually", input: { rentRecordId: String(rentId), method }, result: { status: "confirmed" } });
  revalidatePath("/landlord/rent");
}

