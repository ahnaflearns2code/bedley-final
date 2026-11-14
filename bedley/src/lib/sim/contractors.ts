/**
 * DEMO MODE contractor market (DEMO_SIMULATE_CONTRACTORS != "0").
 * Fictional local businesses that "answer" the AI's calls with realistic quotes a few seconds apart,
 * so the full workflow can be shown without phoning real companies. Every record is tagged
 * source: "demo_simulated" and simulated: true in the audit log.
 */

const NAMES: Record<string, string[]> = {
  plumber: ["Rapid Rooter Plumbing", "Malvern Plumbing & Drain", "Scarborough Pipe Pros", "Lakeshore Plumbing Co.", "Agincourt Plumbing Services"],
  electrician: ["BrightLine Electric", "Scarborough Electrical Services", "Volt Pro Electricians", "Kennedy Road Electric", "Safe Circuit Electric"],
  hvac: ["Comfort Air Heating & Cooling", "Northside HVAC", "Malvern Furnace & AC", "Climate Pros Toronto", "Polar Bear Heating"],
  appliance: ["Appliance Doctor Toronto", "FixIt Appliance Repair", "Scarborough Appliance Service", "Quick Fix Appliances"],
  pest: ["Shield Pest Control", "Green Guard Pest Services", "Scarborough Pest Pros", "Eastend Pest Experts"],
  locks: ["Key Masters Locksmith", "24/7 Lock & Key", "Malvern Locksmith", "Secure Entry Locksmiths"],
  handyman: ["Handy Andy Home Repair", "Scarborough Handyman Co.", "Mr. Fixit Toronto", "Reliable Property Services"],
};

const PRICE: Record<string, [number, number]> = {
  plumber: [165, 340],
  electrician: [180, 380],
  hvac: [190, 420],
  appliance: [140, 260],
  pest: [150, 300],
  locks: [120, 240],
  handyman: [110, 220],
};

export function tradeKey(trade: string): string {
  const t = trade.toLowerCase();
  if (/plumb|drain/.test(t)) return "plumber";
  if (/electric/.test(t)) return "electrician";
  if (/hvac|heat|furnace|gas|air/.test(t)) return "hvac";
  if (/appliance/.test(t)) return "appliance";
  if (/pest/.test(t)) return "pest";
  if (/lock/.test(t)) return "locks";
  return "handyman";
}

function rnd(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function simulatedContractors(trade: string, count = 4, seed = Date.now()) {
  const k = tradeKey(trade);
  const r = rnd(seed);
  const names = [...NAMES[k]].sort(() => r() - 0.5).slice(0, count);
  return names.map((name) => ({
    name,
    rating: Math.round((4.2 + r() * 0.7) * 10) / 10,
    reviews: Math.round(30 + r() * 380),
    distanceKm: Math.round((1 + r() * 8) * 10) / 10,
    trade: k,
  }));
}

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function slot(r: () => number, urgent: boolean) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Toronto" }));
  const d = new Date(now);
  if (urgent && now.getHours() < 18 && r() < 0.6) {
    const h = Math.min(20, now.getHours() + 2 + Math.floor(r() * 3));
    return { when: `today between ${fmt(h)} and ${fmt(h + 2)}`, days: 0 };
  }
  let add = 1 + Math.floor(r() * 3);
  d.setDate(d.getDate() + add);
  while (d.getDay() === 0) { d.setDate(d.getDate() + 1); add++; }
  const h = 8 + Math.floor(r() * 7);
  const label = add === 1 ? "tomorrow" : `${DAY[d.getDay()]}, ${d.toLocaleDateString("en-CA", { month: "long", day: "numeric" })}`;
  return { when: `${label} between ${fmt(h)} and ${fmt(h + 2)}`, days: add };
}
function fmt(h: number) {
  const hh = ((h + 11) % 12) + 1;
  return `${hh} ${h < 12 ? "a.m." : "p.m."}`;
}

/** What a simulated contractor "says" when the AI calls. */
export function simulatedQuote(trade: string, urgent: boolean, seed: number) {
  const k = tradeKey(trade);
  const r = rnd(seed);
  const [lo, hi] = PRICE[k];
  const base = Math.round((lo + r() * (hi - lo)) / 5) * 5;
  const callout = r() < 0.5 ? 0 : Math.round((40 + r() * 50) / 5) * 5;
  const s = slot(r, urgent);
  const total = base + callout;
  const said =
    callout > 0
      ? `About ${base} dollars for the job plus a ${callout} dollar call-out fee. We can come ${s.when}`
      : `We'd charge around ${base} dollars all in. Earliest we can do is ${s.when}`;
  return { amountCents: total * 100, availability: s.when, daysOut: s.days, raw: said };
}
