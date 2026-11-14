"use server";
import Anthropic from "@anthropic-ai/sdk";
import { requireRole, orgFilter } from "@/lib/auth";
import { C, getDb } from "@/lib/db";

const $ = (c: number) => `$${Math.round(c / 100).toLocaleString("en-CA")}`;

/** Landlord asks a question about their portfolio; Bedley answers from live MongoDB data only. */
export async function askBedley(_prev: unknown, fd: FormData): Promise<{ q?: string; answer?: string }> {
  const s = await requireRole("landlord", "admin");
  const q = String(fd.get("q") || "").trim().slice(0, 300);
  if (!q) return {};
  const db = await getDb();
  const f = orgFilter(s);
  const period = new Date().toISOString().slice(0, 7);
  const [tickets, tenants, units, props, rent, leases] = await Promise.all([
    db.collection(C.tickets).find(f).sort({ createdAt: -1 }).limit(40).toArray(),
    db.collection(C.tenants).find(f).project({ name: 1, unitId: 1 }).toArray(),
    db.collection(C.units).find(f).toArray(),
    db.collection(C.properties).find(f).toArray(),
    db.collection(C.rent).find({ ...f, period }).toArray(),
    db.collection(C.leases).find({ tenantId: { $in: [] as any[] } }).toArray().catch(() => []),
  ]);
  void leases;
  const tn = new Map(tenants.map((t) => [String(t._id), t.name]));
  const un = new Map(units.map((u) => [String(u._id), u]));
  const pn = new Map(props.map((p) => [String(p._id), p.name]));
  const open = tickets.filter((t) => !["closed", "completed", "cancelled"].includes(t.status));
  const needsOk = open.filter((t) => t.status === "awaiting_approval");
  const spend = tickets.reduce((a, t) => a + (t.finalCostCents ?? t.booking?.approvedCents ?? 0), 0);
  const expected = rent.reduce((a, r) => a + r.amountCents, 0);
  const collected = rent.filter((r) => r.status === "paid").reduce((a, r) => a + r.amountCents, 0);
  const unpaid = rent.filter((r) => r.status !== "paid").map((r) => `${tn.get(String(r.tenantId))} owes ${$(r.amountCents)}`);
  const facts = [
    `Properties: ${props.map((p) => p.name).join(", ")}. Tenants: ${tenants.map((t) => `${t.name} (${pn.get(String(un.get(String(t.unitId))?.propertyId))}, unit ${un.get(String(t.unitId))?.label})`).join("; ")}.`,
    `Rent this month: ${$(collected)} collected of ${$(expected)}. ${unpaid.length ? "Unpaid: " + unpaid.join("; ") : "Everyone has paid."}`,
    `Repair requests (${tickets.length} total, ${open.length} open, ${needsOk.length} waiting for landlord approval):`,
    ...tickets.slice(0, 15).map((t) => `- "${t.title}" from ${tn.get(String(t.tenantId))}: status ${t.status}, priority ${t.priority ?? "n/a"}${t.booking ? `, booked ${t.booking.contractorName} ${t.booking.window}${t.booking.approvedCents ? " for " + $(t.booking.approvedCents) : ""}` : ""}${t.finalCostCents ? `, final cost ${$(t.finalCostCents)}` : ""}`),
    `Total repair spend booked or invoiced: ${$(spend)}.`,
  ].join("\n");

  const fallback = `${open.length} open repair request${open.length === 1 ? "" : "s"}${needsOk.length ? `, ${needsOk.length} waiting for your OK` : ""}. Rent: ${$(collected)} of ${$(expected)} collected this month${unpaid.length ? ` (${unpaid.join("; ")})` : ""}. Repairs booked so far: ${$(spend)}.`;
  if (!process.env.ANTHROPIC_API_KEY) return { q, answer: fallback };
  try {
    const r = await new Anthropic({ timeout: 12000, maxRetries: 0 }).messages.create({
      model: process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-5-5",
      max_tokens: 300,
      system: `You are Bedley, an assistant for a landlord in Toronto. Answer the question in 1-4 short plain sentences using ONLY the facts below. If the facts don't cover it, say so. No markdown.\n\n${facts}`,
      messages: [{ role: "user", content: q }],
    });
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join(" ").trim();
    return { q, answer: text || fallback };
  } catch {
    return { q, answer: fallback };
  }
}
