import Link from "next/link";
import { requireRole, orgFilter } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { AuditRows } from "@/components/AuditRows";

const FILTERS: Record<string, Record<string, unknown>> = {
  all: {},
  agent: { "actor.type": "agent" },
  human: { "actor.type": "user" },
  denied: { decision: "denied" },
  approvals: { $or: [{ decision: "needs_approval" }, { action: { $regex: "^approval\\." } }] },
  pii: { action: { $regex: "^pii\\." } },
  payments: { action: { $regex: "^payment\\." } },
  unconfirmed: { "result.status": { $in: ["sent", "pending", "simulated"] } },
};

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const s = await requireRole("landlord", "admin");
  const { f = "all" } = await searchParams;
  const db = await getDb();
  const q = { ...orgFilter(s), ...(FILTERS[f] ?? {}) };
  const [rows, stats] = await Promise.all([
    db.collection(C.audit).find(q).sort({ ts: -1 }).limit(200).toArray(),
    db.collection(C.audit).aggregate([
      { $match: { ...orgFilter(s), decision: { $exists: true } } },
      { $group: { _id: "$decision", n: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const st = Object.fromEntries(stats.map((x) => [x._id, x.n]));
  return (
    <div className="space-y-4">
      <div>
        <h1 className="h1">Audit ledger</h1>
        <p className="text-sm text-ink-faint">
          Every agent tool call is checked against your policy before it runs and recorded here with the identity, authority, policy version and verified result.
          {" "}Allowed {st.allowed ?? 0} · needed approval {st.needs_approval ?? 0} · denied {st.denied ?? 0}.
        </p>
      </div>
      <div className="flex flex-wrap gap-1">
        {Object.keys(FILTERS).map((k) => (
          <Link key={k} href={`/landlord/audit?f=${k}`} className={`rounded border px-2 py-1 text-xs ${f === k ? "border-forest bg-forest-50 text-forest" : "border-line bg-white text-ink-soft"}`}>{k}</Link>
        ))}
      </div>
      <p className="text-xs text-ink-faint">
        Result states: <b>sent</b> = provider accepted it; <b>confirmed</b> = verified as delivered/applied (Twilio status callback, Stripe webhook, or DB write acknowledged); <b>simulated</b> = integration not configured, nothing left the platform.
      </p>
      <div className="panel overflow-hidden"><AuditRows rows={rows} showInput /></div>
    </div>
  );
}
