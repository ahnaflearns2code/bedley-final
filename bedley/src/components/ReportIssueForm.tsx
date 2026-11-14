"use client";
import Link from "next/link";
import { useActionState, useRef, useEffect } from "react";
import { createTicket } from "@/app/actions";

export function ReportIssueForm() {
  const [state, action, pending] = useActionState(createTicket, null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.reply) formRef.current?.reset();
  }, [state]);

  return (
    <div className="space-y-4">
      {state?.reply && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-lg rounded-br-sm bg-forest px-4 py-2.5 text-sm text-white">
              <div className="font-medium">{state.title}</div>
              <div className="text-white/80">{state.description}</div>
            </div>
          </div>
          <div className="flex gap-2.5">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-forest text-xs font-bold text-white">B</span>
            <div className={`max-w-[90%] rounded-lg rounded-tl-sm border px-4 py-3 text-sm ${state.priority === "emergency" ? "border-red-300 bg-red-50" : "border-line bg-white"}`}>
              <p>{state.reply}</p>
              {state.steps && state.steps.length > 0 && (
                <>
                  <div className="mt-3 text-xs font-medium uppercase tracking-wide text-ink-faint">Right now</div>
                  <ol className="mt-1 list-decimal space-y-1 pl-5">{state.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                </>
              )}
              <div className="mt-3 flex items-center gap-2 border-t border-line pt-2.5 text-xs text-ink-soft">
                <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" /></span>
                Calling local contractors now{state.major ? " and phoning your landlord" : ""}.
                <Link href={`/tenant/tickets/${state.ticketId}`} className="ml-auto font-medium text-forest hover:underline">Follow along →</Link>
              </div>
            </div>
          </div>
        </div>
      )}

      <form ref={formRef} action={action} className="space-y-3">
        <div>
          <label className="label">What&apos;s wrong?</label>
          <input name="title" className="input" placeholder="Water leaking under the kitchen sink" required minLength={3} />
        </div>
        <div>
          <label className="label">Tell us more</label>
          <textarea name="description" className="input" rows={3} required minLength={10}
            placeholder="When did it start, how bad is it? If you smell gas or see sparks, leave and call 911 first." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">When are you home?</label>
            <input name="availability" className="input" placeholder="Weekdays after 5pm" />
          </div>
          <div>
            <label className="label">Photo (optional)</label>
            <input name="photo" type="file" accept="image/jpeg,image/png,image/webp,image/heic" className="input py-1 text-xs" />
          </div>
        </div>
        {state?.error && <p className="text-sm text-danger">{state.error}</p>}
        <button className="btn btn-primary" disabled={pending}>
          {pending ? (
            <span className="flex items-center gap-2"><span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Bedley is looking at it…</span>
          ) : state?.reply ? "Report another issue" : "Send to Bedley"}
        </button>
      </form>
    </div>
  );
}
