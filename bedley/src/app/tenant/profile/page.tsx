import { ObjectId } from "mongodb";
import { requireRole } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { maskSin } from "@/lib/encryption";
import { deleteSin, updateChannelPrefs } from "@/app/actions";
import { Section, when } from "@/components/ui";
import { RevealSin } from "@/components/PiiForms";
import { AuditRows } from "@/components/AuditRows";

export default async function TenantProfile() {
  const s = await requireRole("tenant");
  const db = await getDb();
  const t = await db.collection(C.tenants).findOne({ _id: new ObjectId(s.tenantId), orgId: new ObjectId(s.orgId) });
  const access = await db.collection(C.audit).find({ orgId: new ObjectId(s.orgId), "input.tenantId": s.tenantId, action: { $regex: "^pii\\." } }).sort({ ts: -1 }).limit(20).toArray();
  return (
    <div className="space-y-8">
      <h1 className="h1">Profile & privacy</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="My contact details">
          <form action={updateChannelPrefs} className="panel space-y-3 p-4 text-sm">
            <div>
              <label className="label">Phone number {t?.phoneLast4 ? `(saved · ends ${t.phoneLast4})` : "(not set)"}</label>
              <input name="phone" className="input" placeholder={t?.phoneLast4 ? "Type a new number to change it" : "647-555-0123"} />
              <p className="mt-1 text-[11px] text-ink-faint">Stored encrypted. Used only to reach you about your home.</p>
            </div>
            <div>
              <label className="label">How should we reach you with updates?</label>
              <select name="preferredChannel" defaultValue={t?.preferredChannel ?? "in_app"} className="input">
                <option value="call">Phone call</option>
                <option value="in_app">In the app only</option>
                <option value="sms">Text message</option>
                <option value="email">Email</option>
              </select>
            </div>
            <label className="flex items-center gap-2"><input type="checkbox" name="optCall" defaultChecked={t?.optIn?.call !== false} /> OK to call me about repairs</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="optSms" defaultChecked={!!t?.optIn?.sms} /> OK to text me about repairs</label>
            <button className="btn btn-primary">Save my details</button>
          </form>
        </Section>
        <Section title="Your Social Insurance Number">
          <div className="panel space-y-3 p-4 text-sm">
            <div className="mono">{maskSin(t?.sinLast3)}</div>
            {t?.sinEnc ? (
              <>
                <p className="text-xs text-ink-faint">Encrypted before storage. Scheduled for deletion {when(t.sinDeleteAfter)}. Every time your landlord views it, it appears in the log below.</p>
                <RevealSin tenantId={s.tenantId!} self />
                <form action={deleteSin}><input type="hidden" name="tenantId" value={s.tenantId} /><button className="btn btn-danger">Delete my SIN now</button></form>
              </>
            ) : (
              <p className="text-xs text-ink-faint">You haven&apos;t provided a SIN. You are never required to.</p>
            )}
          </div>
        </Section>
      </div>
      <Section title="Who accessed your personal information">
        <div className="panel overflow-hidden"><AuditRows rows={access} /></div>
      </Section>
    </div>
  );
}
