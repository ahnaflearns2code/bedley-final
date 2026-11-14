import { ObjectId } from "mongodb";
import { requireRole, orgFilter } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { loadPolicy } from "@/lib/policy";
import { addContractor, connectStripe, saveLandlordContact, savePolicyAction, updateContractor } from "@/app/actions";
import { Badge, Section, when } from "@/components/ui";

const TOOL_HELP: Record<string, string> = {
  triage_ticket: "Classify a request and write the diagnosis",
  suggest_diy_fix: "Send the tenant safe fix steps + YouTube tutorials",
  wait_for_tenant: "Wait for the tenant to say if the fix worked",
  search_contractors: "Search Google Places and your directory",
  contact_contractor: "Phone (ElevenLabs voice) or text contractors for a quote",
  wait_for_quotes: "Sleep until contractors answer, then continue",
  propose_booking: "Book a contractor (always needs your approval)",
  notify_tenant: "Message or call the tenant with updates",
  notify_landlord: "Post an update on your dashboard",
  charge_payment: "Charge a tenant or landlord",
  refund_payment: "Issue a refund",
};

const INTEGRATIONS = [
  ["MongoDB Atlas", "MONGODB_URI"],
  ["Field-level encryption key", "ENCRYPTION_MASTER_KEY"],
  ["Claude (agent planner)", "ANTHROPIC_API_KEY"],
  ["Google Places (contractor search)", "GOOGLE_PLACES_API_KEY"],
  ["YouTube tutorials", "YOUTUBE_API_KEY"],
  ["Twilio SMS/voice", "TWILIO_AUTH_TOKEN"],
  ["ElevenLabs voice", "ELEVENLABS_API_KEY"],
  ["Public link so the AI can hear answers", "APP_BASE_URL"],
  ["Twilio WhatsApp", "TWILIO_WHATSAPP_NUMBER"],
  ["Stripe", "STRIPE_SECRET_KEY"],
  ["Stripe webhooks", "STRIPE_WEBHOOK_SECRET"],
  ["Email (Resend)", "RESEND_API_KEY"],
] as const;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ stripe?: string }> }) {
  const s = await requireRole("landlord", "admin");
  const sp = await searchParams;
  const db = await getDb();
  const me = await db.collection(C.users).findOne({ _id: new ObjectId(s.userId) });
  const [policy, history, org, contractors] = await Promise.all([
    loadPolicy(orgFilter(s).orgId),
    db.collection(C.policies).find(orgFilter(s)).sort({ version: -1 }).limit(5).toArray(),
    db.collection(C.orgs).findOne({ _id: orgFilter(s).orgId }),
    db.collection(C.contractors).find({ ...orgFilter(s), source: "saved", blacklisted: { $ne: true } }).toArray(),
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <Section title="Your contact details">
        <form action={saveLandlordContact} className="panel grid gap-4 p-4 text-sm sm:grid-cols-3">
          <div>
            <label className="label">Name</label>
            <input name="name" defaultValue={me?.name} className="input" />
          </div>
          <div>
            <label className="label">Your phone {me?.phoneLast4 ? `(saved · ends ${me.phoneLast4})` : "(not set)"}</label>
            <input name="phone" className="input" placeholder={me?.phoneLast4 ? "Type a new number to change it" : "416-555-0123"} />
          </div>
          <div className="flex flex-col justify-between gap-2">
            <label className="flex items-center gap-2"><input type="checkbox" name="callForApprovals" defaultChecked={me?.callForApprovals !== false} /> Phone me when the AI needs my approval (press 1 to approve)</label>
            <button className="btn btn-primary self-start">Save details</button>
          </div>
        </form>
      </Section>

      <Section title="Your contractors">
        <div className="panel overflow-hidden">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Trade</th><th>Phone the AI will call</th><th></th></tr></thead>
            <tbody>
              {contractors.map((c) => (
                <tr key={String(c._id)}>
                  <td className="font-medium">{c.name}</td>
                  <td className="capitalize">{c.trades?.join(", ")}</td>
                  <td colSpan={2}>
                    <form action={updateContractor} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="contractorId" value={String(c._id)} />
                      <input name="phone" defaultValue={c.phone} className="input w-40 py-1" />
                      <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="verified" defaultChecked={c.verification === "landlord_verified"} /> verified</label>
                      <button className="btn py-1 text-xs">Save</button>
                      <button name="remove" value="1" className="btn btn-danger py-1 text-xs">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form action={addContractor} className="flex flex-wrap items-end gap-2 border-t border-line p-3 text-sm">
            <input name="name" placeholder="Business name" className="input w-48" required />
            <input name="trade" placeholder="Trade (plumber)" className="input w-36" required />
            <input name="phone" placeholder="+1 416…" className="input w-36" />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="verified" /> I verified licence & insurance</label>
            <button className="btn">Add</button>
          </form>
        </div>
      </Section>

      <details className="panel">
        <summary className="cursor-pointer px-5 py-3.5 text-sm font-medium">What the AI is allowed to do <span className="font-normal text-ink-faint">· checked before every action · v{policy.version}</span></summary>
        <div className="border-t border-line p-4">

      <div>
        <form action={savePolicyAction} className="panel divide-y divide-line">
          <table className="tbl">
            <thead><tr><th>Tool</th><th>What it does</th><th className="w-44">Agent may…</th></tr></thead>
            <tbody>
              {Object.entries(policy.tools).map(([tool, mode]) => (
                <tr key={tool}>
                  <td className="mono">{tool}</td>
                  <td className="text-ink-soft">{TOOL_HELP[tool] ?? ""}</td>
                  <td>
                    <select name={`tool_${tool}`} defaultValue={mode} className="input py-1">
                      {tool !== "propose_booking" && <option value="allow">Run automatically</option>}
                      <option value="approval">Ask me first</option>
                      <option value="deny">Never</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid gap-4 p-4 sm:grid-cols-3">
            <div><label className="label">Approval threshold (CAD)</label><input name="spendingLimit" defaultValue={policy.spendingLimitCents / 100} className="input" /></div>
            <div><label className="label">Hard cap — always denied above (CAD)</label><input name="hardCap" defaultValue={policy.hardCapCents / 100} className="input" /></div>
            <div><label className="label">Max contractors contacted per job</label><input name="maxContractors" defaultValue={policy.maxContractorsContacted} className="input" /></div>
          </div>
          <div className="flex items-center justify-between p-4">
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="autoBookMinor" defaultChecked={policy.autoBookMinor} /> Let Bedley book small, non-urgent repairs under the threshold without calling me</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="killSwitch" defaultChecked={policy.killSwitch} /> Kill switch — deny every agent action</label>
            </div>
            <button className="btn btn-primary">Save as v{policy.version + 1}</button>
          </div>
        </form>
        {history.length > 0 && (
          <p className="mt-2 text-xs text-ink-faint">History: {history.map((h) => `v${h.version} (${when(h.createdAt)})`).join(" · ")}</p>
        )}
      </div>
        </div>
      </details>

      <details className="panel">
        <summary className="cursor-pointer px-5 py-3.5 text-sm font-medium">Payments &amp; connections</summary>
        <div className="border-t border-line p-4">
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Payments — Stripe Connect">
          <div className="panel space-y-3 p-4 text-sm">
            {org?.stripeAccountId ? (
              <p>Connected account <span className="mono">{org.stripeAccountId}</span> {org.stripeChargesEnabled ? <Badge tone="green">charges enabled</Badge> : <Badge tone="amber">onboarding incomplete</Badge>}</p>
            ) : (
              <p className="text-ink-soft">Connect a Stripe Express account so rent is paid directly to your bank. Until then, test payments settle to the platform test account.</p>
            )}
            {sp.stripe === "not_configured" && <p className="text-xs text-danger">STRIPE_SECRET_KEY is not set.</p>}
            <form action={connectStripe}><button className="btn">{org?.stripeAccountId ? "Continue Stripe onboarding" : "Connect Stripe"}</button></form>
            <p className="text-xs text-ink-faint">No card surcharges are added to tenants. Autopay is optional for tenants under Ontario law.</p>
          </div>
        </Section>

        <Section title="Integrations">
          <div className="panel divide-y divide-line text-sm">
            {INTEGRATIONS.map(([name, env]) => (
              <div key={env} className="flex items-center justify-between px-4 py-2">
                <span>{name} <span className="mono text-ink-faint">{env}</span></span>
                {process.env[env] && !(env === "APP_BASE_URL" && /localhost/.test(process.env[env]!)) ? <Badge tone="green">connected</Badge> : <Badge>not connected</Badge>}
              </div>
            ))}
            {process.env.DEMO_CONTRACTOR_PHONE && (
              <div className="bg-amber-50 px-4 py-2 text-xs text-amber-900">Demo safety on: every contractor SMS goes to DEMO_CONTRACTOR_PHONE, never to real businesses.</div>
            )}
          </div>
        </Section>
      </div>


        </div>
      </details>
    </div>
  );
}
