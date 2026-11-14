import Link from "next/link";
import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { requireRole, orgFilter } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { maskSin } from "@/lib/encryption";
import { Section, money, when } from "@/components/ui";
import { RevealSin, SensitiveForm } from "@/components/PiiForms";
import { AuditRows } from "@/components/AuditRows";
import { deleteSin } from "@/app/actions";

export default async function TenantDetail({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireRole("landlord", "admin");
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();
  const db = await getDb();
  const t = await db.collection(C.tenants).findOne({ _id: new ObjectId(id), ...orgFilter(s) });
  if (!t) notFound();
  const [unit, lease, piiAudit] = await Promise.all([
    db.collection(C.units).findOne({ _id: t.unitId }),
    db.collection(C.leases).findOne({ tenantId: t._id }),
    db.collection(C.audit).find({ ...orgFilter(s), "input.tenantId": id, action: { $regex: "^pii\\." } }).sort({ ts: -1 }).limit(20).toArray(),
  ]);
  return (
    <div className="space-y-8">
      <div>
        <Link href="/landlord/tenants" className="text-xs text-ink-faint hover:underline">← Tenants</Link>
        <h1 className="h1 mt-1">{t.name}</h1>
        <p className="text-sm text-ink-faint">Unit {unit?.label} · {t.email} · lease {lease ? `${when(lease.start).split(",")[0]} – ${when(lease.end).split(",")[0]}` : "—"} · {money(unit?.rentCents)}/mo</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Sensitive information (field-level encrypted)">
          <div className="panel divide-y divide-line text-sm">
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="label">Social Insurance Number</div>
                <div className="mono">{maskSin(t.sinLast3)}</div>
                {t.sinDeleteAfter && <div className="text-[11px] text-ink-faint">Auto-deletes {when(t.sinDeleteAfter)} (purpose: {t.sinPurpose})</div>}
              </div>
              {t.sinEnc && (
                <form action={deleteSin}><input type="hidden" name="tenantId" value={id} /><button className="btn btn-danger text-xs">Delete SIN</button></form>
              )}
            </div>
            {t.sinEnc && <div className="px-4 py-3"><RevealSin tenantId={id} /></div>}
            <div className="px-4 py-3">
              <div className="label">Date of birth</div>
              <div className="mono">{t.dobEnc ? "Encrypted — not displayed" : "Not provided"}</div>
            </div>
            <div className="px-4 py-3">
              <div className="label">Phone</div>
              <div className="mono">{t.phoneLast4 ? `Encrypted (deterministic) · ends ${t.phoneLast4}` : "Not provided"}</div>
            </div>
            <div className="px-4 py-3 text-xs text-ink-faint">
              Stored in Atlas as BSON Binary subtype 6 ciphertext (MongoDB Client-Side Field Level Encryption). Atlas, backups and logs never see plaintext. Agents only ever receive masked values.
            </div>
          </div>
        </Section>

        <Section title="Update sensitive fields">
          <div className="panel p-4"><SensitiveForm tenantId={id} /></div>
        </Section>
      </div>

      <Section title="Access log for this tenant's personal information">
        <div className="panel overflow-hidden"><AuditRows rows={piiAudit} /></div>
      </Section>
    </div>
  );
}
