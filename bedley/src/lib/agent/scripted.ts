import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";

/**
 * Deterministic fallback planner used when ANTHROPIC_API_KEY is not set.
 * It emits the same tool calls as the Claude planner would, so every call still
 * goes through the policy gate and audit ledger. The UI labels runs "scripted".
 */

type Block = Anthropic.ContentBlockParam;

function toolUse(name: string, input: Record<string, unknown>): Block {
  return { type: "tool_use", id: `toolu_s_${randomUUID().replace(/-/g, "").slice(0, 20)}`, name, input };
}

function isMajor(text: string, priority: string) {
  return priority === "emergency" || /flood|burst|ceiling|mou?ld|sewage|no heat|furnace|boiler|spark|gas|carbon monoxide|structural|crack in (the )?wall|water damage/.test(text.toLowerCase());
}

function classify(text: string) {
  const t = text.toLowerCase();
  if (/gas|carbon monoxide|co alarm/.test(t)) return { category: "hvac", trade: "gas technician", priority: "emergency" };
  if (/flood|burst|gushing/.test(t)) return { category: "plumbing", trade: "emergency plumber", priority: "emergency" };
  if (/spark|burning smell|outlet|breaker|electric/.test(t)) return { category: "electrical", trade: "electrician", priority: /spark|burning/.test(t) ? "emergency" : "high" };
  if (/leak|drip|sink|toilet|pipe|drain|clog/.test(t)) return { category: "plumbing", trade: "plumber", priority: /leak|pipe/.test(t) ? "high" : "normal" };
  if (/heat|furnace|boiler|ac\b|air condition/.test(t)) return { category: "hvac", trade: "HVAC technician", priority: "high" };
  if (/mice|mouse|roach|cockroach|bed ?bug|pest/.test(t)) return { category: "pest", trade: "pest control", priority: "normal" };
  if (/fridge|stove|oven|dishwasher|washer|dryer/.test(t)) return { category: "appliance", trade: "appliance repair", priority: "normal" };
  if (/lock|key|door/.test(t)) return { category: "locks", trade: "locksmith", priority: "high" };
  return { category: "other", trade: "handyman", priority: "normal" };
}

const DIY: Array<{ match: RegExp; interim: boolean; steps: string[]; video: string }> = [
  {
    match: /leak|drip|pipe|burst/,
    interim: true,
    steps: [
      "Turn the shut-off valve(s) under the sink clockwise until they stop.",
      "Put a bucket or pot under the drip and towels on the floor.",
      "Keep the cabinet doors open so it can dry out.",
      "If water keeps coming after the valve is closed, tell us right away.",
    ],
    video: "how to shut off water valve under kitchen sink",
  },
  {
    match: /clog|drain|slow|backed up|won.?t drain/,
    interim: false,
    steps: [
      "Remove the drain stopper and clear any food or hair you can see.",
      "Pour a kettle of hot (not boiling) water down the drain.",
      "Use a cup plunger: put about 5 cm of water in the sink, cover the overflow hole with a wet cloth, and plunge firmly 15-20 times.",
      "Run hot water for a minute to check it drains.",
      "Please don't use chemical drain cleaners — they can damage the pipes.",
    ],
    video: "how to unclog a kitchen sink with a plunger",
  },
  {
    match: /toilet.*(run|running|keeps)|running toilet/,
    interim: false,
    steps: [
      "Lift the tank lid and check the flapper chain isn't tangled or too tight.",
      "Jiggle the handle and press the rubber flapper down so it seals.",
      "Water should stop about 2 cm below the overflow tube — if higher, lower the float.",
      "If it still runs, turn the valve behind the toilet clockwise and let us know.",
    ],
    video: "how to fix a running toilet flapper",
  },
  {
    match: /breaker|lost power|no power in|outlet.*(dead|not working)/,
    interim: false,
    steps: [
      "Unplug the devices in the room that lost power.",
      "Open the electrical panel and find the breaker that's in the middle or OFF position.",
      "Push it fully OFF, then back ON.",
      "If it trips again right away, leave it off and tell us — don't keep resetting it.",
    ],
    video: "how to reset a tripped circuit breaker",
  },
];

function toolsCalled(messages: any[]) {
  const names: string[] = [];
  for (const m of messages) if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_use") names.push(b.name);
  return names;
}

function lastResultFor(messages: any[], tool: string): any {
  let id: string | null = null;
  for (const m of messages) if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_use" && b.name === tool) id = b.id;
  if (!id) return null;
  for (const m of messages)
    if (m.role === "user" && Array.isArray(m.content))
      for (const b of m.content) if (b.type === "tool_result" && b.tool_use_id === id) {
        try { return { ...JSON.parse(b.content), _isError: !!b.is_error }; } catch { return null; }
      }
  return null;
}

export function scriptedNext(run: any): Block[] {
  const msgs = run.messages;
  const called = toolsCalled(msgs);
  const report = typeof msgs[0].content === "string" ? msgs[0].content : "";
  const c = classify(report);

  if (!called.includes("triage_ticket")) {
    const emergency = c.priority === "emergency";
    return [
      { type: "text", text: `Triage: looks like a ${c.category} issue, priority ${c.priority}.` },
      toolUse("triage_ticket", {
        category: c.category,
        priority: c.priority,
        trade: c.trade,
        summary: `Tenant reports a ${c.category} problem (${c.priority} priority)${isMajor(report, c.priority) ? "; major repair — landlord will be called before booking" : "; minor job — can be booked within the auto-book limit"}.`,
        diy_safe: false,
        major_repair: isMajor(report, c.priority),
        ...(emergency ? { emergency_instructions: "If you smell gas or see sparking, leave the unit and call 911. For flooding, shut off the water main if it is safe to do so." } : {}),
      }),
    ];
  }

  const triage = lastResultFor(msgs, "triage_ticket");
  if (c.priority === "emergency" && called.filter((n) => n === "notify_tenant").length === 0) {
    return [toolUse("notify_tenant", { message: "We've flagged this as urgent and are finding a contractor now. If anyone is in danger, leave the unit and call 911." })];
  }
  if (triage?._isError) return [{ type: "text", text: "Stopping: triage could not be recorded." }];

  // Try to solve it first (or contain it) — never for emergencies
  const t = report.toLowerCase();
  const diy = c.priority !== "emergency" ? DIY.find((d) => d.match.test(t)) : undefined;
  if (diy && !called.includes("suggest_diy_fix")) {
    return [
      { type: "text", text: diy.interim ? "Sending the tenant safe steps to limit damage while I find a contractor." : "This may be fixable without a contractor. Sending the tenant steps and a video." },
      toolUse("suggest_diy_fix", { steps: diy.steps, video_search: diy.video, interim_only: diy.interim }),
    ];
  }
  if (diy && !diy.interim) {
    if (!called.includes("wait_for_tenant")) return [toolUse("wait_for_tenant", {})];
    const ans = lastResultFor(msgs, "wait_for_tenant");
    if (ans?.tenant_answer === "fixed") {
      if (!called.includes("notify_tenant")) return [toolUse("notify_tenant", { message: "Great, glad that worked! We've closed this request. Message us any time if it comes back." })];
      return [{ type: "text", text: "Resolved by the tenant with the suggested fix. No contractor needed." }];
    }
  }

  if (!called.includes("search_contractors")) return [toolUse("search_contractors", { trade: c.trade, query: c.trade })];

  const search = lastResultFor(msgs, "search_contractors");
  if (!search || search._isError || !search.contractors?.length) return [{ type: "text", text: "No contractors available to contact; escalating to the landlord." }];

  const ranked = [...search.contractors].sort((a: any, b: any) => (b.rating ?? 0) * Math.log10((b.reviews ?? 0) + 10) - (a.rating ?? 0) * Math.log10((a.reviews ?? 0) + 10));
  const contacted = called.filter((n) => n === "contact_contractor").length;
  if (contacted < Math.min(4, ranked.length) && !called.includes("propose_booking")) {
    const next = ranked[contacted];
    return [toolUse("contact_contractor", { contractor_id: next.id, message: `We have a ${c.category} repair (${c.trade}) at a rental apartment in Scarborough.` })];
  }

  const waits = called.filter((n) => n === "wait_for_quotes").length;
  const waitResult = lastResultFor(msgs, "wait_for_quotes");
  const quotes: any[] = waitResult?.quotes ?? [];
  if (!called.includes("propose_booking") && waits < 3 && quotes.length < contacted) {
    return [
      { type: "text", text: `Waiting for contractors to call back (${quotes.length}/${contacted} quotes so far).` },
      toolUse("wait_for_quotes", { seconds: 20 }),
    ];
  }

  if (!called.includes("propose_booking")) {
    // Prefer the cheapest real quote (ties → better rating); fall back to best-rated if nobody quoted.
    const priced = quotes.filter((q) => q.amount_cents);
    priced.sort((a, b) => a.amount_cents - b.amount_cents);
    const q = priced[0];
    const best = q ? ranked.find((r: any) => r.id === q.contractor_id) ?? ranked[0] : ranked[0];
    return [
      toolUse("propose_booking", {
        contractor_id: best.id,
        ...(q ? { estimate_cents: q.amount_cents } : {}),
        proposed_window: q?.availability || "Earliest available, weekdays 9am-5pm",
        rationale: q
          ? `${best.name} quoted $${(q.amount_cents / 100).toFixed(2)} (${q.source?.replace("_", " ")}): "${String(q.said ?? "").slice(0, 120)}". Rating ${best.rating ?? "n/a"} from ${best.reviews ?? 0} reviews. ${priced.length} of ${contacted} contractors gave a price.`
          : `${best.name}: rating ${best.rating ?? "n/a"} from ${best.reviews ?? 0} reviews. No contractor gave a price yet — compare before approving.`,
      }),
    ];
  }

  const booking = lastResultFor(msgs, "propose_booking");
  if (booking && !booking._isError && booking.booked) {
    if (!called.includes("notify_tenant") || (c.priority === "emergency" && called.filter((n) => n === "notify_tenant").length < 2))
      return [toolUse("notify_tenant", { kind: "booking_confirmed" })];
    if (!called.includes("notify_landlord")) return [toolUse("notify_landlord", { kind: "booking_confirmed" })];
  }
  if (booking?.rejected_by_landlord) return [{ type: "text", text: "Landlord rejected the proposal. Run ends; landlord will choose next steps." }];
  return [{ type: "text", text: "Workflow complete." }];
}
