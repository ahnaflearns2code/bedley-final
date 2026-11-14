/**
 * Runs ONLY the always-on Bedley AI (no website). Use this when the website is hosted on Vercel:
 * keep this running on a laptop for the day — it watches the same Atlas database and handles every
 * new ticket, quote, approval and landlord call.
 *   npm run agent
 */
import { startAgentWorker } from "../src/lib/agent/worker";

if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI missing — run this from the bedley folder with your .env file.");
  process.exit(1);
}
console.log("Starting Bedley AI… (keep this window open; Ctrl+C to stop)");
console.log(`Public site for calls: ${process.env.APP_BASE_URL}`);
startAgentWorker();
setInterval(() => {}, 1 << 30); // keep the process alive
