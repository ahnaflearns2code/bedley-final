"use client";
import { useActionState, useRef } from "react";
import { askBedley } from "@/app/ask";

const IDEAS = ["What needs my attention?", "Who hasn't paid rent?", "How much have repairs cost?"];

export function AskBedley() {
  const [state, action, pending] = useActionState(askBedley, null);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  return (
    <section className="panel p-5">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-forest text-[10px] font-bold text-white">B</span>
        <h2 className="text-sm font-semibold">Ask Bedley</h2>
        <span className="text-xs text-ink-faint">answers from your live data</span>
      </div>
      <form ref={form} action={action} className="mt-3 flex gap-2">
        <input ref={input} name="q" className="input" placeholder="Ask anything about your properties, rent or repairs…" autoComplete="off" />
        <button className="btn btn-primary" disabled={pending}>{pending ? "Thinking…" : "Ask"}</button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {IDEAS.map((q) => (
          <button key={q} type="button" onClick={() => { if (input.current) input.current.value = q; form.current?.requestSubmit(); }} className="rounded-full border border-line px-3 py-1 text-xs text-ink-soft hover:bg-stone-50">{q}</button>
        ))}
      </div>
      {state?.answer && (
        <div className="mt-4 rounded-lg bg-forest-50 px-4 py-3 text-sm">
          <div className="text-xs text-ink-faint">{state.q}</div>
          <p className="mt-1">{state.answer}</p>
        </div>
      )}
    </section>
  );
}
