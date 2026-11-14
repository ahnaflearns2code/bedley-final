import Link from "next/link";
import { requireRole, orgFilter } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { Empty, StatusPill, when } from "@/components/ui";

const FILTERS: Array<[string, string, string[] | null]> = [
  ["all", "All", null],
  ["attention", "Needs your OK", ["awaiting_approval", "emergency"]],
  ["active", "In progress", ["new", "ai_triage", "ai_troubleshooting", "contractor_search", "contractor_booked", "in_progress"]],
  ["done", "Done", ["completed", "closed", "cancelled"]],
];

export default async function TicketsPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const s = await requireRole("landlord", "admin");
  const { f = "all" } = await searchParams;
  const db = await getDb();
  const q: Record<string, unknown> = orgFilter(s);
  const sel = FILTERS.find(([k]) => k === f)?.[2];
  if (sel) q.status = { $in: sel };
  const [tickets, tenants, units, properties] = await Promise.all([
    db.collection(C.tickets).find(q).sort({ updatedAt: -1 }).limit(100).toArray(),
    db.collection(C.tenants).find(orgFilter(s)).project({ name: 1 }).toArray(),
    db.collection(C.units).find(orgFilter(s)).toArray(),
    db.collection(C.properties).find(orgFilter(s)).toArray(),
  ]);
  const tn = new Map(tenants.map((t) => [String(t._id), t.name]));
  const un = new Map(units.map((u) => [String(u._id), u]));
  const pn = new Map(properties.map((p) => [String(p._id), p.name]));
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Repair requests</h1>
      <div className="flex gap-1">
        {FILTERS.map(([k, label]) => (
          <Link key={k} href={`/landlord/tickets?f=${k}`} className={`rounded-full border px-3 py-1 text-xs ${f === k ? "border-forest bg-forest text-white" : "border-line bg-white text-ink-soft hover:bg-stone-50"}`}>{label}</Link>
        ))}
      </div>
      <div className="panel divide-y divide-line">
        {tickets.length === 0 && <Empty>Nothing here.</Empty>}
        {tickets.map((t) => {
          const u = un.get(String(t.unitId));
          return (
            <Link key={String(t._id)} href={`/landlord/tickets/${t._id}`} className="flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-stone-50">
              <div className="min-w-0">
                <div className="truncate font-medium">{t.title}</div>
                <div className="text-xs text-ink-faint">{tn.get(String(t.tenantId))} · {pn.get(String(u?.propertyId))}, unit {u?.label} · {when(t.createdAt)}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                {t.priority === "emergency" && <StatusPill status="emergency" />}
                <StatusPill status={t.status} />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
