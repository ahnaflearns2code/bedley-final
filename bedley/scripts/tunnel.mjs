/**
 * YOU run this (in a second window) when you want Twilio to reach your laptop, so the AI can
 * hear answers on calls. It opens a free Cloudflare quick tunnel to localhost:3000 and saves the
 * public link to .public-url, which the running app picks up automatically. Ctrl+C closes it.
 */
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const port = process.env.PORT || "3000";
console.log(`Opening a public link to http://localhost:${port} … (first run downloads cloudflared, ~30s)`);
const child = spawn("npx", ["-y", "cloudflared", "tunnel", "--url", `http://localhost:${port}`], { shell: true });
let found = false;
const onData = (buf) => {
  const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !found) {
    found = true;
    writeFileSync(".public-url", m[0]);
    console.log(`\n✅ Public link: ${m[0]}\n   The app will use it within a few seconds. Keep this window open. Ctrl+C to close it.\n`);
  }
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);
const cleanup = () => { try { rmSync(".public-url"); } catch {} };
process.on("SIGINT", () => { cleanup(); child.kill(); process.exit(0); });
child.on("exit", (code) => { cleanup(); if (!found) console.log("Tunnel stopped. If it never printed a link, install cloudflared with:  winget install Cloudflare.cloudflared  and run this again."); process.exit(code ?? 0); });
