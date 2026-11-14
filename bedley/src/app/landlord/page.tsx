export const maxDuration = 60; // AI replies can take a few seconds on Vercel
import Link from "next/link";
import { ObjectId } from "mongodb";
import { requireRole, orgFilter } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { loadPolicy } from "@/lib/policy";
import { decideApproval, toggleKillSwitch } from "@/app/actions";
import { Empty, StatusPill, money, when } from "@/components/ui";
import { AskBedley } from "@/components/AskBedley";

/* eslint-disable @typescript-eslint/no-explicit-any */
function greeting() {
  const h = Number(new Date().toLocaleString("en-CA", { hour: "numeric", hour12: false, timeZone: "America/Toronto" }));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default async function LandlordOverview() {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const f = orgFilter(s);
  const period = new Date().toISOString().slice(0, 7);

  const updates = await db.collection("landlord_updates").find(f).sort({ ts: -1 }).limit(4).toArray();
  const [approvals, tickets, rent, policy, properties, units, tenants, beat] = await Promise.all([
    db.collection(C.approvals).find({ ...f, status: "pending" }).sort({ requestedAt: -1 }).toArray(),
    db.collection(C.tickets).find({ ...f, status: { $nin: ["closed"] } }).sort({ updatedAt: -1 }).limit(8).toArray(),
    db.collection(C.rent).find({ ...f, period }).toArray(),
    loadPolicy(f.orgId),
    db.collection(C.properties).find(f).toArray(),
    db.collection(C.units).find(f).toArray(),
    db.collection(C.tenants).find(f).toArray(),
    db.collection("agent_worker").findOne({ _id: "maintenance-agent" as any }),
  ]);
  const online = beat && Date.now() - new Date(beat.lastBeat).getTime() < 15000;
  const tenantById = new Map(tenants.map((t) => [String(t._id), t]));
  const unitById = new Map(units.map((u) => [String(u._id), u]));
  const propById = new Map(properties.map((p) => [String(p._id), p]));

  const expected = rent.reduce((a, r) => a + r.amountCents, 0);
  const collected = rent.filter((r) => r.status === "paid").reduce((a, r) => a + r.amountCents, 0);
  const openCount = tickets.filter((t) => !["completed", "closed", "cancelled"].includes(t.status)).length;

  // Build approval cards: contractor name + price in plain words
  const contractorIds = approvals.map((a) => a.input?.contractor_id).filter((x) => x && ObjectId.isValid(x)).map((x) => new ObjectId(x));
  const contractors = contractorIds.length ? await db.collection(C.contractors).find({ _id: { $in: contractorIds } }).toArray() : [];
  const cName = new Map(contractors.map((c) => [String(c._id), c.name]));
  const ticketIds = approvals.map((a) => a.ticketId);
  const approvalTickets = ticketIds.length ? await db.collection(C.tickets).find({ _id: { $in: ticketIds } }).toArray() : [];
  const tById = new Map(approvalTickets.map((t) => [String(t._id), t]));

  const [callsMade, checked, blockedN, autoBooked, bookedTickets] = await Promise.all([
    db.collection(C.audit).countDocuments({ ...f, action: "tool.contact_contractor" }),
    db.collection(C.audit).countDocuments({ ...f, decision: { $in: ["allowed", "denied", "needs_approval"] } }),
    db.collection(C.audit).countDocuments({ ...f, decision: "denied" }),
    db.collection(C.audit).countDocuments({ ...f, policyRule: { $regex: "^autoBookMinor" } }),
    db.collection(C.tickets).find({ ...f, "booking.bookedAt": { $exists: true } }).project({ createdAt: 1, booking: 1 }).toArray(),
  ]);
  const mins = bookedTickets.map((t) => (new Date(t.booking.bookedAt).getTime() - new Date(t.createdAt).getTime()) / 60000).filter((m) => m >= 0);
  const avgMin = mins.length ? mins.reduce((a, b) => a + b, 0) / mins.length : null;
  const agentOn = online && !policy.killSwitch;
  const me = await db.collection(C.users).findOne({ _id: new ObjectId(s.userId) }, { projection: { phoneLast4: 1, phoneEnc: 1 } });
  const noPhone = !me?.phoneEnc && !process.env.DEMO_LANDLORD_PHONE;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{greeting()}, {s.name.split(" ")[0]}</h1>
          <p className="mt-1 text-sm text-ink-faint">{properties.length} properties · {tenants.length} tenants</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${agentOn ? "border-forest/20 bg-forest-50 text-forest" : "border-red-200 bg-red-50 text-danger"}`}>
            <span className={`h-2 w-2 rounded-full ${agentOn ? "bg-emerald-accent" : "bg-danger"}`} />
            {policy.killSwitch ? "AI assistant paused" : online ? "AI assistant is on" : "AI assistant offline"}
          </span>
          <form action={toggleKillSwitch}>
            <input type="hidden" name="on" value={policy.killSwitch ? "0" : "1"} />
            <button className="text-xs text-ink-soft underline-offset-2 hover:underline">{policy.killSwitch ? "Resume" : "Pause"}</button>
          </form>
        </div>
      </div>

      {noPhone && (
        <Link href="/landlord/settings" className="panel block border-red-300 bg-red-50 px-5 py-3 text-sm text-danger hover:bg-red-100">
          <b>Add your phone number</b> so Bedley can call you about emergencies and big repairs →
        </Link>
      )}

      {approvals.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Needs your OK</h2>
          <div className="space-y-3">
            {approvals.map((a) => {
              const t: any = tById.get(String(a.ticketId));
              const tenant = t && tenantById.get(String(t.tenantId));
              const unit = t && unitById.get(String(t.unitId));
              const prop = unit && propById.get(String(unit.propertyId));
              return (
                <div key={String(a._id)} className="panel flex flex-wrap items-center justify-between gap-4 border-amber-300 px-5 py-4">
                  <div className="min-w-0">
                    <div className="text-xs text-ink-faint">{tenant?.name} · {prop?.name}, unit {unit?.label}</div>
                    <div className="mt-0.5 font-medium">{t?.title}</div>
                    <div className="mt-1 text-sm">
                      AI recommends <b>{cName.get(String(a.input.contractor_id)) ?? "a contractor"}</b>
                      {a.input.estimate_cents ? <> for <b>{money(a.input.estimate_cents)}</b></> : null}
                      {a.input.proposed_window ? <span className="text-ink-soft"> · {a.input.proposed_window}</span> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Link href={`/landlord/tickets/${a.ticketId}`} className="btn">Review</Link>
                    <form action={decideApproval}>
                      <input type="hidden" name="approvalId" value={String(a._id)} />
                      <button name="decision" value="approved" className="btn btn-primary">Approve</button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {updates.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Updates from Bedley</h2>
          <div className="panel divide-y divide-line">
            {updates.map((u) => (
              <Link key={String(u._id)} href={u.ticketId ? `/landlord/tickets/${u.ticketId}` : "/landlord"} className="flex gap-3 px-5 py-3.5 hover:bg-stone-50">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-forest text-[10px] font-bold text-white">B</span>
                <div className="min-w-0 text-sm">
                  <p>{u.text}</p>
                  <p className="mt-0.5 text-xs text-ink-faint">{when(u.ts)}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Link href="/landlord/rent" className="panel block px-5 py-4 hover:bg-stone-50">
          <div className="text-xs text-ink-faint">Rent collected this month</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{money(collected)}</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
            <div className="h-full bg-forest" style={{ width: `${expected ? Math.round((collected / expected) * 100) : 0}%` }} />
          </div>
          <div className="mt-1 text-xs text-ink-faint">of {money(expected)}</div>
        </Link>
        <Link href="/landlord/rent" className="panel block px-5 py-4 hover:bg-stone-50">
          <div className="text-xs text-ink-faint">Outstanding</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{money(expected - collected)}</div>
          <div className="mt-1 text-xs text-ink-faint">{rent.filter((r) => r.status !== "paid").length} unpaid this month</div>
        </Link>
        <Link href="/landlord/tickets" className="panel block px-5 py-4 hover:bg-stone-50">
          <div className="text-xs text-ink-faint">Open repair requests</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{openCount}</div>
          <div className="mt-1 text-xs text-ink-faint">{approvals.length} waiting on you</div>
        </Link>
      </div>

      <section className="overflow-hidden rounded-xl bg-forest text-white">
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="text-sm font-semibold">Bedley&apos;s work for you</h2>
          <Link href="/landlord/audit" className="text-xs text-white/70 hover:text-white">See every action →</Link>
        </div>
        <div className="grid grid-cols-2 gap-px px-5 py-4 sm:grid-cols-4">
          {[
            [String(callsMade), "contractor calls made"],
            [avgMin == null ? "—" : avgMin < 1 ? "<1 min" : `${Math.round(avgMin)} min`, "avg. report → booked"],
            [String(autoBooked), "small jobs booked without bothering you"],
            [`${checked}`, `actions checked against your rules · ${blockedN} blocked`],
          ].map(([n, l]) => (
            <div key={l} className="pr-4">
              <div className="text-2xl font-semibold tabular-nums">{n}</div>
              <div className="mt-0.5 text-xs text-white/70">{l}</div>
            </div>
          ))}
        </div>
      </section>

      <AskBedley />

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Repair requests</h2>
          <Link href="/landlord/tickets" className="text-xs text-forest hover:underline">View all</Link>
        </div>
        <div className="panel divide-y divide-line">
          {tickets.length === 0 && <Empty>No open requests. The AI assistant picks up new ones automatically.</Empty>}
          {tickets.map((t) => {
            const tenant = tenantById.get(String(t.tenantId));
            const unit = unitById.get(String(t.unitId));
            const prop = unit && propById.get(String(unit.propertyId));
            return (
              <Link key={String(t._id)} href={`/landlord/tickets/${t._id}`} className="flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-stone-50">
                <div className="min-w-0">
                  <div className="truncate font-medium">{t.title}</div>
                  <div className="text-xs text-ink-faint">{tenant?.name} · {prop?.name}, unit {unit?.label} · {when(t.createdAt)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {t.priority === "emergency" && <StatusPill status="emergency" />}
                  <StatusPill status={t.status} />
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Your properties</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {properties.map((p) => {
            const pUnits = units.filter((u) => String(u.propertyId) === String(p._id));
            return (
              <div key={String(p._id)} className="panel px-5 py-4">
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-ink-faint">{p.address}, {p.city}</div>
                <div className="mt-3 space-y-1.5">
                  {pUnits.map((u) => {
                    const tenant = tenants.find((t) => String(t.unitId) === String(u._id));
                    const r = rent.find((x) => String(x.unitId) === String(u._id));
                    return (
                      <div key={String(u._id)} className="flex items-center justify-between text-sm">
                        <span>Unit {u.label} · {tenant ? <Link className="text-forest hover:underline" href={`/landlord/tenants/${tenant._id}`}>{tenant.name}</Link> : <span className="text-ink-faint">Vacant</span>}</span>
                        <span className={`text-xs ${r?.status === "paid" ? "text-forest" : "text-warn"}`}>{money(u.rentCents)} · {r?.status === "paid" ? "paid" : "due"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
