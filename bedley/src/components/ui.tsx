import Link from "next/link";
import type { ReactNode } from "react";

const TONES: Record<string, string> = {
  green: "bg-forest-50 text-forest border-forest/20",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  red: "bg-red-50 text-danger border-red-200",
  gray: "bg-stone-100 text-ink-soft border-stone-200",
  blue: "bg-sky-50 text-sky-800 border-sky-200",
};

export function Badge({ tone = "gray", children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>{children}</span>;
}

const STATUS_TONE: Record<string, keyof typeof TONES> = {
  new: "gray",
  ai_triage: "blue",
  ai_troubleshooting: "blue",
  contractor_search: "blue",
  awaiting_approval: "amber",
  contractor_booked: "green",
  in_progress: "green",
  completed: "green",
  closed: "gray",
  emergency: "red",
  cancelled: "gray",
  // runs
  running: "blue",
  waiting: "blue",
  stopped: "red",
  failed: "red",
  // results
  confirmed: "green",
  sent: "blue",
  simulated: "amber",
  blocked: "red",
  pending: "gray",
  allowed: "green",
  denied: "red",
  needs_approval: "amber",
  approved: "green",
  rejected: "red",
  // rent
  due: "amber",
  paid: "green",
  processing: "blue",
  overdue: "red",
};

export function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  return <Badge tone={STATUS_TONE[status] ?? "gray"}>{status.replace(/_/g, " ")}</Badge>;
}

export function PriorityBadge({ p }: { p?: string }) {
  if (!p) return null;
  const tone = p === "emergency" ? "red" : p === "high" ? "amber" : "gray";
  return <Badge tone={tone}>{p}</Badge>;
}

export function Section({ title, action, children, className = "" }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="h2">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, href }: { label: string; value: ReactNode; sub?: ReactNode; href?: string }) {
  const inner = (
    <div className="px-4 py-3">
      <div className="text-xs text-ink-faint">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-ink-faint">{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="block hover:bg-stone-50">{inner}</Link> : inner;
}

export const money = (cents?: number | null) =>
  cents == null ? "—" : (cents / 100).toLocaleString("en-CA", { style: "currency", currency: "CAD" });

export const when = (d?: Date | string | null) =>
  d ? new Date(d).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" }) : "—";

export const shortId = (id: unknown) => String(id).slice(-6).toUpperCase();

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-6 text-center text-sm text-ink-faint">{children}</div>;
}

const FRIENDLY: Record<string, [string, keyof typeof TONES]> = {
  new: ["New", "gray"],
  ai_triage: ["AI is assessing", "blue"],
  ai_troubleshooting: ["AI helping tenant", "blue"],
  contractor_search: ["Finding a contractor", "blue"],
  awaiting_approval: ["Needs your OK", "amber"],
  contractor_booked: ["Contractor booked", "green"],
  in_progress: ["In progress", "green"],
  completed: ["Fixed", "green"],
  closed: ["Closed", "gray"],
  emergency: ["Emergency", "red"],
  cancelled: ["Cancelled", "gray"],
};

/** Plain-language status for people (not the raw database value). */
export function StatusPill({ status }: { status?: string | null }) {
  if (!status) return null;
  const [label, tone] = FRIENDLY[status] ?? [status.replace(/_/g, " "), "gray"];
  return <Badge tone={tone}>{label}</Badge>;
}
