import Anthropic from "@anthropic-ai/sdk";

export const YES = /\b(yes|yeah|yep|yup|sure|ok(ay)?|approve[d]?|book (it|them)|go ahead|do it|sounds good|please do|confirm(ed)?|that'?s fine|perfect)\b/i;
export const NO = /\b(no|nope|don'?t|decline|cancel|not now|hold off|wait|reject)\b/i;

/** Answer a landlord's question about the job — Claude if available (fast model, hard time limit), otherwise a facts-based reply. */
export async function answer(question: string, facts: string): Promise<string> {
  const fallback = () => {
    const q = question.toLowerCase();
    if (/how much|price|cost|expensive|quote/.test(q)) return facts.match(/for \d+ dollars/)?.[0]?.replace("for", "The quote is") + "." || "I'll confirm the exact price in the dashboard.";
    if (/when|time|today|tomorrow|soon/.test(q)) return facts.match(/can come [^.]*/)?.[0]?.replace("can come", "They can come") + "." || "They can come at the earliest available time.";
    if (/who|which|company|rating|review|good/.test(q)) return facts.match(/best option is [^,]*/)?.[0]?.replace("best option is", "The contractor is") + ", and they're well reviewed." || "They're the best-rated local option I found.";
    if (/bad|serious|urgent|safe|danger|emergency/.test(q)) return /urgent/.test(facts) ? "It's urgent, so I've given the tenant safety steps and I'm treating it as top priority." : "It's a bigger repair, but nobody's in danger. I'm treating it as a priority and getting quotes now.";
    if (/tenant|who reported|aisha|marcus/.test(q)) return facts.match(/[A-Z][a-z]+ [A-Z][a-z]+ (at [^,]*, unit [^ ,.]+ )?(just )?reported[^.]*/)?.[0] + "." || "The tenant reported it through the Bedley app.";
    return "Good question. All the details are in your Bedley dashboard.";
  };
  if (!process.env.ANTHROPIC_API_KEY) return fallback();
  try {
    const anthropic = new Anthropic({ timeout: 3500, maxRetries: 0 });
    const r = await Promise.race([
      anthropic.messages.create({
        model: process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-5-5",
        max_tokens: 120,
        system: `You are Bedley, a property assistant talking with the landlord on a call. Answer their question in one or two short spoken sentences using only these facts. Don't make up numbers. Facts: ${facts}`,
        messages: [{ role: "user", content: question }],
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("slow")), 3500)),
    ]);
    const t = r.content.map((b) => (b.type === "text" ? b.text : "")).join(" ").trim();
    return t || fallback();
  } catch {
    return fallback();
  }
}

