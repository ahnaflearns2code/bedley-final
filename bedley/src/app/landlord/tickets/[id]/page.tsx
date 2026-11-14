export const maxDuration = 60; // AI replies can take a few seconds on Vercel
import Link from "next/link";
import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { requireRole, orgFilter } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { cancelBooking, closeTicket, decideApproval, recordQuote, restartAgent, resumeRun, stopRun } from "@/app/actions";
import { Badge, StatusPill, money, when } from "@/components/ui";
import { AuditRows } from "@/components/AuditRows";
import { Story } from "@/components/Story";

/* eslint-disable @typescript-eslint/no-explicit-any */
const RUN_LABEL: Record<string, string> = {
  running: "Working on it",
  waiting: "Waiting for replies",
  awaiting_approval: "Waiting for your OK",
  completed: "Done",
  stopped: "Stopped",
  failed: "Hit a problem",
};

export default async function TicketDetail({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireRole("landlord", "admin");
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();
  const db = await getDb();
  const f = orgFilter(s);
  const t: any = await db.collection(C.tickets).findOne({ _id: new ObjectId(id), ...f });
  if (!t) notFound();

  const [tenant, unit, property, run, approvals, audit] = await Promise.all([
    db.collection(C.tenants).findOne({ _id: t.tenantId }, { projection: { name: 1 } }),
    db.collection(C.units).findOne({ _id: t.unitId }),
    db.collection(C.properties).findOne({ _id: t.propertyId }),
    t.agentRunId ? db.collection(C.runs).findOne({ _id: t.agentRunId }, { projection: { messages: 0 } }) : null,
    db.collection(C.approvals).find({ ticketId: t._id }).sort({ requestedAt: -1 }).toArray(),
    db.collection(C.audit).find({ ...f, ticketId: t._id }).sort({ ts: 1 }).toArray(),
  ]);
  const calls = await db.collection("voice_calls").find({ ticketId: t._id, userId: new ObjectId(s.userId), "transcript.0": { $exists: true } }).sort({ createdAt: 1 }).toArray();
  const candidateIds: ObjectId[] = t.candidateContractorIds ?? [];
  const contractors = candidateIds.length ? await db.collection(C.contractors).find({ _id: { $in: candidateIds }, ...f }).toArray() : [];
  const names = new Map<string, string>(contractors.map((c) => [String(c._id), c.name as string]));
  const pending = approvals.find((a) => a.status === "pending");
  const quotesBy = new Map<string, any[]>();
  for (const q of t.quotes ?? []) quotesBy.set(String(q.contractorId), [...(quotesBy.get(String(q.contractorId)) ?? []), q]);
  const contactBy = new Map<string, any>((t.contacts ?? []).map((c: any) => [String(c.contractorId), c]));
  const pick = pending && contractors.find((c) => String(c._id) === pending.input.contractor_id);
  const runActive = run && ["running", "awaiting_approval", "waiting"].includes(run.status) && !run.stopRequested;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link href="/landlord/tickets" className="text-xs text-ink-faint hover:underline">← Requests</Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
          {t.priority === "emergency" && <StatusPill status="emergency" />}
          <StatusPill status={t.status} />
        </div>
        <p className="mt-1 text-sm text-ink-faint">
          {tenant?.name} · {property?.name}, unit {unit?.label} · reported {when(t.createdAt)}
        </p>
      </div>

      {t.priority === "emergency" && (
        <div className="panel border-red-300 bg-red-50 px-5 py-3 text-sm text-danger">
          <b>Emergency.</b> {t.emergencyInstructions || "The tenant has been sent safety instructions."}
        </div>
      )}

      {pending && (
        <div className="panel border-amber-300 bg-amber-50/40 px-5 py-4">
          <div className="text-xs font-medium uppercase tracking-wide text-amber-800">Needs your OK</div>
          <div className="mt-1 text-lg">
            AI recommends <b>{pick?.name ?? "a contractor"}</b>
            {pending.input.estimate_cents ? <> for <b>{money(pending.input.estimate_cents)}</b></> : null}
            {pending.input.proposed_window ? <span className="text-ink-soft"> · {pending.input.proposed_window}</span> : null}
          </div>
          {pick && (
            <div className="mt-1 text-sm text-ink-soft">
              {pick.rating ? `${pick.rating} ★ (${pick.reviews} reviews)` : ""}{pick.verification === "landlord_verified" ? " · verified by you" : " · licence & insurance not verified yet"}
            </div>
          )}
          <form action={decideApproval} className="mt-3">
            <input type="hidden" name="approvalId" value={String(pending._id)} />
            <div className="flex flex-wrap gap-2">
              <button name="decision" value="approved" className="btn btn-primary px-5">Approve &amp; book</button>
              <button name="decision" value="rejected" className="btn">Decline</button>
            </div>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-xs text-ink-soft">Pick a different contractor or change the price</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <select name="contractorId" defaultValue={pending.input.contractor_id} className="input">
                  {contractors.map((c) => <option key={String(c._id)} value={String(c._id)}>{c.name}</option>)}
                </select>
                <input name="estimate" className="input" placeholder={pending.input.estimate_cents ? `$${(pending.input.estimate_cents / 100).toFixed(0)}` : "Max price $"} />
                <input name="window" className="input" defaultValue={pending.input.proposed_window} />
              </div>
              <p className="mt-1 text-xs text-ink-faint">Change these, then press Approve &amp; book.</p>
            </details>
          </form>
        </div>
      )}

      {t.booking && (
        <div className="panel flex flex-wrap items-center justify-between gap-3 border-forest/30 bg-forest-50/50 px-5 py-4">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-forest">Booked</div>
            <div className="mt-1 text-lg"><b>{t.booking.contractorName}</b> <span className="text-ink-soft">· {t.booking.window}{t.booking.approvedCents ? ` · up to ${money(t.booking.approvedCents)}` : ""}</span></div>
          </div>
          <form action={cancelBooking}><input type="hidden" name="ticketId" value={String(t._id)} /><button className="btn">Cancel booking</button></form>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <section>
            <h2 className="mb-2 text-sm font-semibold">What the AI assistant did</h2>
            <div className="panel"><Story audit={audit} names={names} audience="landlord" /></div>
          </section>

          {contractors.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">Quotes {contractors.some((c) => c.source === "demo_simulated") && <Badge>Demo contractor market</Badge>}</h2>
              <div className="panel divide-y divide-line">
                {contractors.map((c) => {
                  const q = (quotesBy.get(String(c._id)) ?? []).at(-1);
                  const contacted = contactBy.get(String(c._id));
                  const booked = t.booking && String(t.booking.contractorId) === String(c._id);
                  return (
                    <div key={String(c._id)} className="flex items-start justify-between gap-4 px-5 py-3.5">
                      <div className="min-w-0">
                        <div className="font-medium">{c.name} {booked && <Badge tone="green">booked</Badge>}</div>
                        <div className="text-xs text-ink-faint">
                          {c.rating ? `${c.rating} ★ · ${c.reviews} reviews · ` : ""}{c.verification === "landlord_verified" ? "verified by you" : "not verified"}
                        </div>
                        {q?.raw && <div className="mt-1 text-xs italic text-ink-soft">&ldquo;{q.raw}&rdquo;</div>}
                      </div>
                      <div className="shrink-0 text-right">
                        {q?.amountCents ? (
                          <>
                            <div className="font-semibold tabular-nums">{money(q.amountCents)}</div>
                            <div className="text-xs text-ink-faint">{q.availability}</div>
                          </>
                        ) : (
                          <div className="text-xs text-ink-faint">{contacted ? "Waiting for price" : "Not contacted"}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-ink-soft">Got a price over the phone? Add it</summary>
                <form action={recordQuote} className="mt-2 flex flex-wrap items-end gap-2 text-sm">
                  <input type="hidden" name="ticketId" value={String(t._id)} />
                  <select name="contractorId" className="input w-48">
                    {contractors.map((c) => <option key={String(c._id)} value={String(c._id)}>{c.name}</option>)}
                  </select>
                  <input name="amount" placeholder="Price $" className="input w-28" required />
                  <input name="availability" placeholder="When" className="input w-40" />
                  <input type="hidden" name="kind" value="verbal_estimate" />
                  <button className="btn">Add</button>
                </form>
              </details>
            </section>
          )}
          {calls.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold">Your calls with Bedley</h2>
              <div className="space-y-3">
                {calls.map((c) => (
                  <div key={String(c._id)} className="panel p-4">
                    <div className="mb-2 text-xs text-ink-faint">{c.kind === "approval" ? "Approval call" : "Urgent briefing"} · {when(c.createdAt)}</div>
                    <div className="space-y-1.5">
                      {c.transcript.map((l: any, i: number) => (
                        <div key={i} className={`flex ${l.who === "landlord" ? "justify-end" : ""}`}>
                          <div className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm ${l.who === "landlord" ? "bg-forest text-white" : "bg-stone-100"}`}>{l.text}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="space-y-6">
          <section>
            <h2 className="mb-2 text-sm font-semibold">Tenant&apos;s report</h2>
            <div className="panel p-4 text-sm">
              <p className="whitespace-pre-wrap">{t.description}</p>
              {t.availability && <p className="mt-2 text-xs text-ink-faint">Home: {t.availability}</p>}
              {t.photos?.length > 0 && (
                <div className="mt-3 flex gap-2">
                  {t.photos.map((p: any, i: number) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={i} src={p.dataUrl} alt={p.name} className="h-24 rounded border border-line object-cover" />
                  ))}
                </div>
              )}
            </div>
          </section>

          {t.diySteps?.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold">{t.diyInterim ? "Steps sent to limit damage" : "Fix sent to tenant"}</h2>
              <div className="panel p-4 text-sm">
                <ol className="list-decimal space-y-1 pl-4 text-ink-soft">{t.diySteps.map((d: string, i: number) => <li key={i}>{d}</li>)}</ol>
                {t.videos?.length > 0 && <p className="mt-2 text-xs text-ink-faint">+ {t.videos.length} YouTube guide{t.videos.length > 1 ? "s" : ""}</p>}
                {t.diyResult && <p className="mt-2 text-xs font-medium">{t.diyResult === "fixed" ? "Tenant: that fixed it ✓" : "Tenant: still broken"}</p>}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-2 text-sm font-semibold">AI assistant</h2>
            <div className="panel space-y-3 p-4 text-sm">
              {run ? (
                <div className="flex items-center justify-between">
                  <span>{RUN_LABEL[run.status] ?? run.status}</span>
                  {run.planner === "claude" && <span className="text-xs text-ink-faint">Claude</span>}
                </div>
              ) : <p className="text-ink-faint">Not started yet.</p>}
              {run?.status === "waiting" && run.resumeAt && <p className="text-xs text-ink-faint">Checks back at {when(run.resumeAt)}</p>}
              {run?.status === "failed" && run.error && <p className="text-xs text-danger">{run.error}</p>}
              {runActive && (
                <form action={stopRun}><input type="hidden" name="runId" value={String(run!._id)} /><button className="btn w-full justify-center">Stop the AI on this request</button></form>
              )}
              {run && (run.status === "stopped" || run.status === "failed") && (
                <form action={resumeRun}><input type="hidden" name="runId" value={String(run._id)} /><button className="btn w-full justify-center">Continue where it left off</button></form>
              )}
              {(!run || run.status === "completed") && t.status !== "closed" && (
                <form action={restartAgent}><input type="hidden" name="ticketId" value={String(t._id)} /><button className="btn w-full justify-center">Ask the AI to take another look</button></form>
              )}
            </div>
          </section>

          {t.status !== "closed" ? (
            <details className="panel">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">Close this request</summary>
              <form action={closeTicket} className="space-y-2 border-t border-line p-4">
                <input type="hidden" name="ticketId" value={String(t._id)} />
                {t.tenantConfirmedFixed && <p className="text-xs text-forest">Tenant confirmed it&apos;s fixed.</p>}
                <input name="finalCost" placeholder="Final cost $" className="input" />
                <textarea name="notes" placeholder="Notes (optional)" className="input" rows={2} />
                <button className="btn btn-primary w-full justify-center">Close request</button>
              </form>
            </details>
          ) : (
            <div className="panel p-4 text-sm">Closed {when(t.closedAt)}{t.finalCostCents ? ` · ${money(t.finalCostCents)}` : ""}</div>
          )}
        </aside>
      </div>

      <details className="panel">
        <summary className="cursor-pointer px-5 py-3 text-xs text-ink-faint">Technical log: every AI action, the rule that allowed it, and the result ({audit.length})</summary>
        <div className="overflow-x-auto border-t border-line"><AuditRows rows={audit} showInput /></div>
      </details>
    </div>
  );
}
