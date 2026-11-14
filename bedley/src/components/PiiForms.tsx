"use client";
import { useActionState, useEffect, useState } from "react";
import { revealSin, updateSensitive } from "@/app/actions";

export function RevealSin({ tenantId, self = false }: { tenantId: string; self?: boolean }) {
  const [state, action, pending] = useActionState(revealSin, null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (state?.value) {
      setVisible(true);
      const t = setTimeout(() => setVisible(false), 15000); // auto-hide
      return () => clearTimeout(t);
    }
  }, [state]);
  if (visible && state?.value)
    return (
      <div className="text-sm">
        <span className="mono text-base">{state.value}</span>
        <span className="ml-2 text-xs text-ink-faint">hides in 15s · this view was logged</span>
      </div>
    );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="tenantId" value={tenantId} />
      {!self && <input name="reason" className="input" placeholder="Reason for viewing (recorded)" required minLength={8} />}
      <div className="flex gap-2">
        <input name="password" type="password" className="input" placeholder="Re-enter your password" required />
        <button className="btn whitespace-nowrap" disabled={pending}>{pending ? "Checking…" : "Reveal SIN"}</button>
      </div>
      {state?.error && <p className="text-xs text-danger">{state.error}</p>}
    </form>
  );
}

export function SensitiveForm({ tenantId }: { tenantId: string }) {
  const [state, action, pending] = useActionState(updateSensitive, null);
  return (
    <form action={action} className="space-y-3 text-sm">
      <input type="hidden" name="tenantId" value={tenantId} />
      <div>
        <label className="label">SIN — optional</label>
        <input name="sin" className="input mono" placeholder="123 456 782" inputMode="numeric" autoComplete="off" />
        <p className="mt-1 text-[11px] text-ink-faint">
          A landlord cannot require a SIN. A tenant can give a credit report or date of birth instead. Only collect it with consent, for a stated purpose; it auto-deletes after 30 days.
        </p>
        <label className="mt-1 flex items-center gap-2 text-xs"><input type="checkbox" name="consent" /> Tenant consented to providing their SIN for a credit check</label>
      </div>
      <div>
        <label className="label">Date of birth</label>
        <input name="dob" type="date" className="input" />
      </div>
      <div>
        <label className="label">Phone</label>
        <input name="phone" className="input" placeholder="+1 416 555 0123" />
      </div>
      {state?.error && <p className="text-xs text-danger">{state.error}</p>}
      {state?.ok && <p className="text-xs text-forest">{state.ok}</p>}
      <button className="btn btn-primary" disabled={pending}>Encrypt & save</button>
    </form>
  );
}
