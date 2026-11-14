import { requireRole, orgFilter } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { markRentPaidManually } from "@/app/actions";
import { Section, StatusBadge, money, when } from "@/components/ui";

export default async function RentPage() {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const f = orgFilter(s);
  const [records, monthly, tenants] = await Promise.all([
    db.collection(C.rent).find(f).sort({ dueDate: -1 }).limit(60).toArray(),
    db.collection(C.rent).aggregate([
      { $match: f },
      { $group: { _id: "$period", expected: { $sum: "$amountCents" }, collected: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amountCents", 0] } } } },
      { $sort: { _id: -1 } },
      { $limit: 6 },
    ]).toArray(),
    db.collection(C.tenants).find(f).project({ name: 1 }).toArray(),
  ]);
  const tn = Object.fromEntries(tenants.map((t) => [String(t._id), t.name]));
  return (
    <div className="space-y-8">
      <div>
        <h1 className="h1">Rent</h1>
        <p className="text-sm text-ink-faint">
          Ontario: no automatic late fees or interest are applied. Autopay can be offered but never required (RTA s.108). Balances shown are records, not legal determinations.
        </p>
      </div>
      <Section title="By month">
        <div className="panel overflow-hidden">
          <table className="tbl">
            <thead><tr><th>Period</th><th className="text-right">Expected</th><th className="text-right">Collected</th><th className="text-right">Outstanding</th></tr></thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m._id}><td>{m._id}</td><td className="text-right tabular-nums">{money(m.expected)}</td><td className="text-right tabular-nums">{money(m.collected)}</td><td className="text-right tabular-nums">{money(m.expected - m.collected)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Ledger">
        <div className="panel overflow-hidden">
          <table className="tbl">
            <thead><tr><th>Tenant</th><th>Period</th><th>Due</th><th className="text-right">Amount</th><th>Status</th><th>Paid</th><th></th></tr></thead>
            <tbody>
              {records.map((r) => (
                <tr key={String(r._id)}>
                  <td>{tn[String(r.tenantId)]}</td>
                  <td>{r.period}</td>
                  <td className="text-ink-faint">{when(r.dueDate).split(",")[0]}</td>
                  <td className="text-right tabular-nums">{money(r.amountCents)}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="text-xs text-ink-faint">{r.paidAt ? `${when(r.paidAt)} · ${r.paidVia ?? "stripe"}` : "—"}</td>
                  <td>
                    {r.status !== "paid" && r.status !== "processing" && (
                      <form action={markRentPaidManually} className="flex gap-1">
                        <input type="hidden" name="rentId" value={String(r._id)} />
                        <select name="method" className="input w-28 py-1 text-xs"><option>e-transfer</option><option>cheque</option><option>cash</option></select>
                        <button className="btn py-1 text-xs">Record</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
