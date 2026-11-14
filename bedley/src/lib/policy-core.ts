/**
 * Pure policy evaluation (no DB) so it can be unit tested.
 * The gate runs BEFORE every agent tool call.
 */

export type ToolMode = "allow" | "approval" | "deny";

export interface PolicyDoc {
  version: number;
  killSwitch: boolean;
  /** Bookings at or under this amount still need approval if tool mode is "approval"; above hardCap they are denied. */
  spendingLimitCents: number;
  hardCapCents: number;
  tools: Record<string, ToolMode>;
  maxContractorsContacted: number;
  /** Book small, non-urgent jobs under the approval threshold without a call; the landlord is told afterwards. */
  autoBookMinor: boolean;
}

export const DEFAULT_POLICY: PolicyDoc = {
  version: 1,
  killSwitch: false,
  spendingLimitCents: 50000,
  hardCapCents: 200000,
  maxContractorsContacted: 5,
  autoBookMinor: true,
  tools: {
    triage_ticket: "allow",
    suggest_diy_fix: "allow",
    wait_for_tenant: "allow",
    search_contractors: "allow",
    contact_contractor: "allow",
    wait_for_quotes: "allow",
    propose_booking: "approval",
    notify_tenant: "allow",
    notify_landlord: "allow",
    charge_payment: "deny",
    refund_payment: "deny",
  },
};

export interface GateContext {
  runStopRequested: boolean;
  contractorsContactedSoFar: number;
  /** True when this exact call was already approved by a human. */
  approved?: boolean;
  /** True when the job is minor (not emergency, not a major repair). */
  minorJob?: boolean;
}

export interface Decision {
  decision: "allowed" | "denied" | "needs_approval";
  rule: string;
  reason: string;
}

export function evaluate(policy: PolicyDoc, tool: string, input: Record<string, unknown>, ctx: GateContext): Decision {
  if (policy.killSwitch) return { decision: "denied", rule: "org.killSwitch", reason: "Organisation-wide agent kill switch is ON." };
  if (ctx.runStopRequested) return { decision: "denied", rule: "run.stopRequested", reason: "A human stopped this run." };

  const mode: ToolMode = policy.tools[tool] ?? "deny";
  if (mode === "deny") return { decision: "denied", rule: `tools.${tool}=deny`, reason: `Tool "${tool}" is not permitted for agents.` };

  if (tool === "contact_contractor" && ctx.contractorsContactedSoFar >= policy.maxContractorsContacted) {
    return {
      decision: "denied",
      rule: "maxContractorsContacted",
      reason: `Already contacted ${ctx.contractorsContactedSoFar} contractors (limit ${policy.maxContractorsContacted}).`,
    };
  }

  const amount = Number(input.estimateCents ?? 0);
  if (amount > policy.hardCapCents) {
    return { decision: "denied", rule: "hardCapCents", reason: `Estimate $${(amount / 100).toFixed(2)} exceeds hard cap $${(policy.hardCapCents / 100).toFixed(2)}.` };
  }

  if (mode === "approval") {
    if (ctx.approved) return { decision: "allowed", rule: `tools.${tool}=approval (approved)`, reason: "Approved by authorised human." };
    const over = amount > policy.spendingLimitCents;
    if (tool === "propose_booking" && policy.autoBookMinor && ctx.minorJob && amount > 0 && !over) {
      return {
        decision: "allowed",
        rule: "autoBookMinor (under approval threshold)",
        reason: `Minor job, $${(amount / 100).toFixed(2)} is under your $${(policy.spendingLimitCents / 100).toFixed(2)} auto-book limit — landlord notified instead of called.`,
      };
    }
    return {
      decision: "needs_approval",
      rule: `tools.${tool}=approval`,
      reason: over
        ? `Requires landlord approval (estimate exceeds $${(policy.spendingLimitCents / 100).toFixed(2)} limit).`
        : "Requires landlord approval before any booking or financial commitment.",
    };
  }
  return { decision: "allowed", rule: `tools.${tool}=allow`, reason: "Permitted by policy." };
}
