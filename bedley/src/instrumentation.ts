/** Runs once when the Next.js server starts: boots the always-on maintenance agent. */
export async function register() {
  // On Vercel there is no always-on process — run `npm run agent` on a laptop instead.
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL && process.env.AGENT_WORKER !== "0") {
    const { startAgentWorker } = await import("./lib/agent/worker");
    startAgentWorker();
  }
}
