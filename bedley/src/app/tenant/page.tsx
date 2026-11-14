export const maxDuration = 60; // AI replies can take a few seconds on Vercel
import Link from "next/link";
import { ObjectId } from "mongodb";
import { requireRole } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { payRent } from "@/app/actions";
import { Empty, Section, StatusBadge, StatusPill, money, when } from "@/components/ui";
import { ReportIssueForm } from "@/components/ReportIssueForm";

const PAY_MSG: Record<string, string> = {
  success: "Payment submitted. It will show as paid once Stripe confirms it.",
  cancelled: "Payment cancelled — nothing was charged.",
  not_configured: "Online payment isn't set up yet. Use your usual payment method.",
  already: "That rent is already paid or processing.",
};

export default async function TenantHome({ searchParams }: { searchParams: Promise<{ pay?: string }> }) {
  const s = await requireRole("tenant");
  const { pay } = await searchParams;
  const db = await getDb();
  const tid = new ObjectId(s.tenantId);
  const tenant = await db.collection(C.tenants).findOne({ _id: tid, orgId: new ObjectId(s.orgId) });
  const [unit, lease, rent, tickets] = await Promise.all([
    db.collection(C.units).findOne({ _id: tenant!.unitId }),
    db.collection(C.leases).findOne({ tenantId: tid }),
    db.collection(C.rent).find({ tenantId: tid }).sort({ dueDate: -1 }).limit(6).toArray(),
    db.collection(C.tickets).find({ tenantId: tid }).sort({ createdAt: -1 }).limit(10).toArray(),
  ]);
  const property = unit ? await db.collection(C.properties).findOne({ _id: unit.propertyId }) : null;
  const open = rent.filter((r) => ["due", "overdue", "failed"].includes(r.status));
  const outstanding = open.reduce((a, r) => a + r.amountCents, 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Hi {s.name.split(" ")[0]}</h1>
        <p className="text-sm text-ink-faint">{property?.address}, unit {unit?.label} · lease until {lease ? new Date(lease.end).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" }) : "—"}</p>
      </div>
      {pay && PAY_MSG[pay] && <div className="panel px-4 py-2.5 text-sm">{PAY_MSG[pay]}</div>}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Section title="Report a maintenance issue">
            <div className="panel p-4"><ReportIssueForm /></div>
          </Section>
          <Section title="Your requests">
            <div className="panel overflow-hidden">
              {tickets.length === 0 ? <Empty>No requests yet.</Empty> : (
                <table className="tbl">
                  <tbody>
                    {tickets.map((t) => (
                      <tr key={String(t._id)} className="hover:bg-stone-50">
                        <td><Link className="font-medium text-forest hover:underline" href={`/tenant/tickets/${t._id}`}>{t.title}</Link></td>
                        <td><StatusPill status={t.status} /></td>
                        <td className="text-right text-ink-faint">{when(t.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Section>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Section title="Rent">
            <div className="panel">
              <div className="border-b border-line px-4 py-3">
                <div className="text-xs text-ink-faint">Monthly rent</div>
                <div className="text-lg font-semibold">{money(unit?.rentCents)}</div>
                <div className="text-xs text-ink-faint">Outstanding: {money(outstanding)}</div>
              </div>
              <table className="tbl">
                <tbody>
                  {rent.map((r) => (
                    <tr key={String(r._id)}>
                      <td>{r.period}<div className="text-xs text-ink-faint">due {when(r.dueDate).split(",")[0]}</div></td>
                      <td className="tabular-nums">{money(r.amountCents)}</td>
                      <td><StatusBadge status={r.status} /></td>
                      <td className="text-right">
                        {["due", "overdue", "failed"].includes(r.status) && (
                          <form action={payRent}><input type="hidden" name="rentId" value={String(r._id)} /><button className="btn btn-primary py-1 text-xs">Pay</button></form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-line px-4 py-2 text-[11px] text-ink-faint">Paying online is optional — your landlord can't require autopay. Card payments are processed by Stripe; we never see your card number.</p>
            </div>
          </Section>
          <Section title="Messages">
            <Link href="/tenant/messages" className="panel block px-4 py-3 text-sm hover:bg-stone-50">Message your landlord →</Link>
          </Section>
        </div>
      </div>
    </div>
  );
}
