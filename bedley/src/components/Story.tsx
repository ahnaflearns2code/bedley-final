import { money, when } from "./ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Line = { text: string; tone: "ai" | "you" | "tenant" | "contractor" | "warn" | "done"; note?: string };

const DOT: Record<Line["tone"], string> = {
  ai: "bg-sky-500",
  you: "bg-forest",
  tenant: "bg-stone-400",
  contractor: "bg-amber-500",
  warn: "bg-danger",
  done: "bg-emerald-accent",
};

function line(a: any, names: Map<string, string>, audience: "landlord" | "tenant"): Line | null {
  const inp = a.input || {};
  const det = a.result?.detail || {};
  const sim = audience === "landlord" && a.result?.status === "simulated" ? "Not sent: phone service not connected" : undefined;
  const failed = audience === "landlord" && a.result?.status === "failed" ? `Didn't go through: ${det.error || det.detail || "see technical log"}` : undefined;
  const nm = (id: string) => names.get(String(id)) || "a contractor";

  if (a.decision === "denied") return audience === "landlord" ? { text: `Blocked by your agent policy: ${a.reason}`, tone: "warn" } : null;

  switch (a.action) {
    case "ticket.created":
      return { text: `${a.actor?.name} reported the problem`, tone: "tenant" };
    case "agent.run.started":
      return { text: "AI assistant started working on it", tone: "ai" };
    case "landlord.briefed_by_phone":
      return audience === "landlord"
        ? {
            text: `Phoned you right away about the ${inp.urgent ? "emergency" : "major repair"}`,
            tone: "warn",
            note: sim || failed || (/template/.test(String(a.result?.detail)) ? "Your phone rang as an alert (Twilio trial plays its own message)" : undefined),
          }
        : { text: "Called your landlord right away", tone: "ai" };
    case "landlord.briefed_in_app":
      return audience === "landlord" ? { text: "Called you in the Bedley app to explain", tone: "warn" } : null;
    case "landlord.called_in_app_for_approval":
      return audience === "landlord" ? { text: "Called you in the Bedley app with the best quote", tone: "ai" } : null;
    case "landlord.answered_in_app_call":
      return audience === "landlord" ? { text: "You answered Bedley's call", tone: "you" } : null;
    case "landlord.phoned_for_approval":
      return audience === "landlord" ? { text: "Called you back with the best quote to approve", tone: "ai", note: sim || failed } : { text: "Asked your landlord to approve the booking", tone: "ai" };
    case "tool.triage_ticket":
      return { text: `Assessed it: ${inp.category}, ${inp.priority} priority${inp.priority === "emergency" ? " — safety instructions sent" : ""}`, tone: inp.priority === "emergency" ? "warn" : "ai" };
    case "tool.suggest_diy_fix":
      return {
        text: inp.interim_only
          ? `Sent ${audience === "tenant" ? "you" : "the tenant"} steps to limit the damage${det.videos?.length ? ` + ${det.videos.length} video guide${det.videos.length > 1 ? "s" : ""}` : ""}`
          : `Sent ${audience === "tenant" ? "you" : "the tenant"} a do-it-yourself fix${det.videos?.length ? ` with ${det.videos.length} YouTube tutorial${det.videos.length > 1 ? "s" : ""}` : ""}`,
        tone: "ai",
      };
    case "tool.wait_for_tenant":
      return { text: `Waiting for ${audience === "tenant" ? "you" : "the tenant"} to try the fix`, tone: "ai" };
    case "tenant.diy_fixed":
      return { text: `${audience === "tenant" ? "You" : "Tenant"} said the fix worked 🎉`, tone: "done" };
    case "tenant.diy_not_fixed":
      return { text: `${audience === "tenant" ? "You" : "Tenant"} said it's still broken — finding a contractor`, tone: "tenant" };
    case "tool.search_contractors": {
      const list = (det.contractors || []).map((c: any) => c.name);
      if (!list.length) return { text: "Searched for contractors", tone: "ai", note: failed };
      return {
        text: audience === "tenant" ? `Found ${list.length} local contractors` : `Found ${list.length} contractors: ${list.slice(0, 4).join(", ")}`,
        tone: "ai",
        note: audience === "landlord" && det.placesError ? "Google search not connected — used your saved contractors" : undefined,
      };
    }
    case "tool.contact_contractor":
      return { text: `Called ${audience === "tenant" ? "a local contractor" : nm(inp.contractor_id)} for a quote`, tone: "ai", note: sim || failed };
    case "tool.wait_for_quotes":
      return { text: "Waiting for contractors to reply", tone: "ai" };
    case "quote.received":
      return {
        text: audience === "tenant" ? `A contractor quoted · available ${inp.availability ?? "soon"}` : `${nm(inp.contractorId)} quoted ${inp.amountCents ? money(inp.amountCents) : "(no price heard)"}${inp.availability ? ` · ${inp.availability}` : ""}`,
        tone: "contractor",
        note: audience === "landlord" && inp.raw ? `“${inp.raw}”` : undefined,
      };
    case "tool.propose_booking":
      if (a.decision === "allowed" && a.policyRule?.startsWith("autoBookMinor"))
        return {
          text: audience === "tenant" ? `Booked ${nm(inp.contractor_id) || "a contractor"} · ${inp.proposed_window}` : `Booked ${nm(inp.contractor_id)}${inp.estimate_cents ? ` for ${money(inp.estimate_cents)}` : ""} · ${inp.proposed_window}`,
          tone: "done",
          note: audience === "landlord" ? "Small job under your auto-book limit, so no call needed" : undefined,
        };
      if (a.decision === "needs_approval")
        return {
          text: audience === "tenant" ? "Sent a recommendation to your landlord for approval" : `Recommends ${nm(inp.contractor_id)}${inp.estimate_cents ? ` for ${money(inp.estimate_cents)}` : ""} — needs your OK`,
          tone: "you",
          note: audience === "landlord" ? inp.rationale : undefined,
        };
      return { text: `Booked ${audience === "tenant" ? "a contractor" : nm(inp.contractor_id)} · ${inp.proposed_window}`, tone: "done", note: sim || failed };
    case "approval.approved":
      return { text: `${audience === "tenant" ? "Landlord" : a.actor?.name} approved the booking`, tone: "you" };
    case "approval.rejected":
      return { text: `${audience === "tenant" ? "Landlord" : a.actor?.name} turned down the recommendation`, tone: "you" };
    case "tool.notify_tenant":
      return audience === "landlord"
        ? { text: inp.kind === "booking_confirmed" ? `${det.channel === "call" ? "Called" : "Messaged"} the tenant with the booking details` : "Updated the tenant", tone: "ai", note: sim || failed }
        : inp.kind === "booking_confirmed"
        ? { text: `Told you who's coming and when${det.channel === "call" ? " (phone call)" : ""}`, tone: "done" }
        : null;
    case "tool.notify_landlord":
      return { text: audience === "landlord" ? "Sent you a summary" : "Let your landlord know", tone: "ai" };
    case "landlord.said":
      return audience === "landlord" ? { text: inp.heard ? `You said on the phone: “${inp.heard}”` : `You pressed ${inp.digit}`, tone: "you" } : null;
    case "agent.run.halted":
    case "agent.run.stop_requested":
      return { text: "AI assistant stopped", tone: "warn" };
    case "agent.run.completed":
      return { text: "AI assistant finished", tone: "done" };
    case "booking.cancelled (compensating action)":
      return { text: "Booking cancelled", tone: "warn" };
    case "ticket.closed":
      return { text: `Closed${inp.finalCostCents ? ` · final cost ${money(inp.finalCostCents)}` : ""}`, tone: "done" };
    default:
      return null;
  }
}

export function Story({ audit, names, audience }: { audit: any[]; names: Map<string, string>; audience: "landlord" | "tenant" }) {
  const lines = audit.map((a) => ({ a, l: line(a, names, audience) })).filter((x) => x.l) as { a: any; l: Line }[];
  if (!lines.length) return <p className="px-4 py-4 text-sm text-ink-faint">Getting started…</p>;
  return (
    <ol className="relative px-4 py-3">
      {lines.map(({ a, l }, i) => (
        <li key={String(a._id)} className="relative flex gap-3 pb-4 last:pb-0">
          {i < lines.length - 1 && <span className="absolute left-[5px] top-4 h-full w-px bg-line" />}
          <span className={`relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full ${DOT[l.tone]}`} />
          <div className="min-w-0">
            <div className="text-sm">{l.text}</div>
            {l.note && <div className="mt-0.5 text-xs text-ink-faint">{l.note}</div>}
            <div className="text-[11px] text-ink-faint">{when(a.ts)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
