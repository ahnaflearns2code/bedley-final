import Anthropic from "@anthropic-ai/sdk";

export interface FirstResponse {
  reply: string;
  steps: string[];
  priority: "low" | "normal" | "high" | "emergency";
  major: boolean;
  trade: string;
  source: "claude" | "rules";
}

const SYSTEM = `You are Bedley, a friendly maintenance assistant for a residential building in Toronto, Ontario.
A tenant just reported a problem. Reply instantly, in plain warm language (2-4 short sentences), as if texting them:
- say what is most likely going on,
- if anything is unsafe, say exactly what to do right now (call 911 for gas/fire/CO; shut off water at the valve for leaks),
- say what happens next: you're contacting local contractors now and will update them with who is coming and when.
Then give up to 4 short, safe things they can do right now (no tools beyond a plunger/towel/valve; never electrical, gas or structural work).
Return ONLY JSON: {"reply": string, "steps": string[], "priority": "low"|"normal"|"high"|"emergency", "major": boolean, "trade": string}
"major" = flooding, water damage, no heat, electrical hazard, structural, mould, sewage, gas.`;

function rules(title: string, description: string): FirstResponse {
  const t = `${title} ${description}`.toLowerCase();
  if (/gas|carbon monoxide|co alarm/.test(t))
    return { reply: "This could be dangerous. Please leave the unit now and call 911 or Enbridge Gas at 1-866-763-5427 from outside. Don't use light switches or flames. I'm alerting your landlord and arranging a technician right away.", steps: ["Leave the unit now", "Call 911 from outside", "Don't touch switches or flames"], priority: "emergency", major: true, trade: "gas technician", source: "rules" };
  if (/flood|burst|gushing|pouring/.test(t))
    return { reply: "That sounds like an active leak, so let's stop the water first. Turn off the closest water valve (under the sink or behind the toilet), or the main shut-off if you can't find it. I'm calling your landlord and lining up an emergency plumber now.", steps: ["Close the nearest water shut-off valve", "Move valuables and unplug anything near the water", "Put towels and buckets down", "Take a photo for the record"], priority: "emergency", major: true, trade: "emergency plumber", source: "rules" };
  if (/leak|drip|pipe/.test(t))
    return { reply: "Sounds like a leaking pipe or connection under the sink — annoying, but usually a quick fix for a plumber. For now, close the small valve under the sink and put a bowl and towel down. I'm calling local plumbers right now and I'll let you know who's coming and when.", steps: ["Turn the valve under the sink clockwise until it stops", "Put a bowl under the drip and a towel on the floor", "Keep the cabinet doors open so it dries", "Tell me right away if water keeps coming"], priority: "high", major: false, trade: "plumber", source: "rules" };
  if (/clog|drain|slow/.test(t))
    return { reply: "A slow or clogged drain is usually a build-up near the stopper — often fixable in a few minutes. Try the steps below; if it's still slow, tell me and I'll book a plumber.", steps: ["Remove the stopper and clear any hair or debris", "Pour a kettle of hot (not boiling) water down", "Plunge firmly 15–20 times with a little water in the sink", "Skip chemical drain cleaners — they damage pipes"], priority: "normal", major: false, trade: "plumber", source: "rules" };
  if (/toilet/.test(t))
    return { reply: "A running toilet is usually the flapper inside the tank not sealing — often a 2-minute fix. Try the steps below. If it keeps running, I'll book a plumber for you.", steps: ["Lift the tank lid and check the chain isn't tangled", "Press the rubber flapper down so it seals", "If it still runs, turn the valve behind the toilet clockwise", "Tell me if it's still running and I'll send a plumber"], priority: "normal", major: false, trade: "plumber", source: "rules" };
  if (/heat|furnace|cold|boiler/.test(t))
    return { reply: "No heat is a priority in Toronto. Check the thermostat is set to HEAT a few degrees above room temperature and has working batteries. I'm calling your landlord and heating technicians now.", steps: ["Set thermostat to HEAT, 3°C above room temp", "Replace thermostat batteries if the screen is blank", "Make sure vents aren't blocked", "Use extra layers; avoid using the oven for heat"], priority: "high", major: true, trade: "HVAC technician", source: "rules" };
  if (/spark|burning|outlet|breaker|power/.test(t))
    return { reply: "Please don't touch the outlet or switch. If you see sparks or smell burning, turn off that breaker at the panel and call 911 if there's smoke. I'm arranging an electrician and letting your landlord know.", steps: ["Don't touch the outlet or switch", "Unplug nearby devices only if it's safe", "Turn off that circuit's breaker if you can", "Call 911 if there's smoke"], priority: "high", major: true, trade: "electrician", source: "rules" };
  return { reply: "Thanks for letting me know. I've logged this and I'm finding the right local contractor now — I'll update you with who's coming and when.", steps: [], priority: "normal", major: false, trade: "handyman", source: "rules" };
}

/** Instant tenant-facing answer shown on the same page right after they submit. */
export async function firstResponse(input: { title: string; description: string; property?: string }): Promise<FirstResponse> {
  if (!process.env.ANTHROPIC_API_KEY) return rules(input.title, input.description);
  try {
    const anthropic = new Anthropic({ timeout: 12000, maxRetries: 0 });
    const r = await anthropic.messages.create({
      model: process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-5-5",
      max_tokens: 500,
      system: SYSTEM,
      messages: [{ role: "user", content: `Issue: ${input.title}\nDetails: ${input.description}\nProperty: ${input.property ?? ""}` }],
    });
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const fallback = rules(input.title, input.description);
    return {
      reply: String(json.reply || fallback.reply),
      steps: Array.isArray(json.steps) ? json.steps.map(String).slice(0, 4) : fallback.steps,
      priority: ["low", "normal", "high", "emergency"].includes(json.priority) ? json.priority : fallback.priority,
      major: typeof json.major === "boolean" ? json.major : fallback.major,
      trade: String(json.trade || fallback.trade),
      source: "claude",
    };
  } catch (e) {
    console.warn("[firstResponse] falling back to rules:", (e as Error).message);
    return rules(input.title, input.description);
  }
}
