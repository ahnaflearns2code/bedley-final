import Link from "next/link";
import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { requireRole } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { tenantConfirmFixed, tenantDiyAnswer } from "@/app/actions";
import { Badge, Section, StatusPill, when } from "@/components/ui";
import { Story } from "@/components/Story";

/* eslint-disable @typescript-eslint/no-explicit-any */
const STEPS = [
  ["new", "Received"],
  ["ai_triage", "Assessed"],
  ["contractor_search", "Finding a contractor"],
  ["awaiting_approval", "Landlord approving"],
  ["contractor_booked", "Booked"],
  ["completed", "Fixed"],
] as const;

export default async function TenantTicket({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireRole("tenant");
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();
  const db = await getDb();
  // Tenant isolation: tenantId comes from the session, never from the URL.
  const t: any = await db.collection(C.tickets).findOne({ _id: new ObjectId(id), orgId: new ObjectId(s.orgId), tenantId: new ObjectId(s.tenantId) });
  if (!t) notFound();
  const [audit, updates] = await Promise.all([
    db.collection(C.audit).find({ ticketId: t._id }).sort({ ts: 1 }).project({ action: 1, ts: 1, decision: 1, result: 1, input: 1, actor: 1 }).toArray(),
    db.collection(C.messages).find({ ticketId: t._id, tenantId: new ObjectId(s.tenantId) }).sort({ ts: 1 }).toArray(),
  ]);
  const statusKey = t.status === "emergency" ? "contractor_search" : t.status === "ai_troubleshooting" ? "ai_triage" : t.status === "closed" ? "completed" : t.status;
  const idx = Math.max(0, STEPS.findIndex(([k]) => k === statusKey));
  const askingTenant = t.awaitingTenant && !t.diyResult;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link href="/tenant" className="text-xs text-ink-faint hover:underline">← Home</Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
          {t.priority === "emergency" && <StatusPill status="emergency" />}
        </div>
      </div>

      {t.priority === "emergency" && (
        <div className="panel border-red-300 bg-red-50 px-4 py-3 text-sm text-danger">
          {t.emergencyInstructions || "If anyone is in danger, leave the unit and call 911."}
        </div>
      )}

      <ol className="panel flex flex-wrap divide-x divide-line text-xs">
        {STEPS.map(([k, label], i) => (
          <li key={k} className={`flex-1 px-3 py-2.5 ${i <= idx ? "font-medium text-forest" : "text-ink-faint"}`}>
            <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${i <= idx ? "bg-forest" : "bg-stone-300"}`} />{label}
          </li>
        ))}
      </ol>

      {(t.diySteps?.length > 0 || t.videos?.length > 0) && (
        <Section title={t.diyInterim ? "While we arrange a repair, please do this" : "Let's try to fix it together"}>
          <div className={`panel p-4 ${askingTenant ? "border-sky-300" : ""}`}>
            <ol className="list-decimal space-y-1.5 pl-5 text-sm">{t.diySteps.map((d: string, i: number) => <li key={i}>{d}</li>)}</ol>
            {t.videos?.length > 0 && (
              <div className="mt-4">
                <div className="label">Video guides</div>
                <div className="flex flex-wrap gap-3">
                  {t.videos.map((v: any) => (
                    <a key={v.id} href={v.url} target="_blank" rel="noreferrer" className="w-52 text-xs hover:underline">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={v.thumbnail} alt="" className="mb-1 w-full rounded border border-line" />
                      <div className="font-medium text-ink">{v.title}</div>
                      <div className="text-ink-faint">{v.channel}</div>
                    </a>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-ink-faint">Videos are general guides from YouTube, not a substitute for a professional. Stop if anything feels unsafe.</p>
              </div>
            )}
            {askingTenant && (
              <form action={tenantDiyAnswer} className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                <input type="hidden" name="ticketId" value={String(t._id)} />
                <span className="text-sm font-medium">Did that fix it?</span>
                <button name="answer" value="fixed" className="btn btn-primary">Yes, it&apos;s fixed</button>
                <button name="answer" value="not_fixed" className="btn">No, still broken</button>
              </form>
            )}
            {t.diyResult === "fixed" && <p className="mt-3 text-sm text-forest">Glad that worked — this request is closed.</p>}
          </div>
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Progress">
          <div className="panel"><Story audit={audit} names={new Map()} audience="tenant" /></div>
        </Section>
        <div className="space-y-6">
          {t.booking && (
            <Section title="Appointment">
              <div className="panel p-4 text-sm">
                <div className="font-medium">{t.booking.contractorName}</div>
                <div className="text-ink-soft">{t.booking.window}</div>
              </div>
            </Section>
          )}
          {["contractor_booked", "in_progress"].includes(t.status) && (
            <Section title="Was the repair done?">
              <form action={tenantConfirmFixed} className="panel flex gap-2 p-4">
                <input type="hidden" name="ticketId" value={String(t._id)} />
                <button name="fixed" value="yes" className="btn btn-primary">Yes, it&apos;s fixed</button>
                <button name="fixed" value="no" className="btn">Not yet</button>
              </form>
            </Section>
          )}
          <Section title="Messages about this request">
            <div className="panel divide-y divide-line">
              {updates.length === 0 && <p className="px-4 py-3 text-sm text-ink-faint">No messages yet.</p>}
              {updates.map((m) => (
                <div key={String(m._id)} className="px-4 py-3 text-sm">
                  <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
                    {m.sender?.name} {m.sender?.type === "agent" && <Badge tone="blue">AI</Badge>} · {when(m.ts)}
                  </div>
                  <p className="whitespace-pre-wrap">{m.body}</p>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Your report">
            <div className="panel whitespace-pre-wrap p-4 text-sm">{t.description}</div>
          </Section>
        </div>
      </div>
    </div>
  );
}
