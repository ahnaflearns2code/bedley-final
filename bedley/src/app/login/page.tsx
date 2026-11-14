import { PhoneCall, ShieldCheck, Wrench, Zap } from "lucide-react";
import { LoginForm } from "./LoginForm";

const POINTS = [
  [Zap, "Answers tenants in seconds", "Bedley diagnoses the problem and tells the tenant exactly what to do right now."],
  [Wrench, "Gets the quotes for you", "It calls local contractors, compares price and availability, and books the best one."],
  [PhoneCall, "Calls you when it matters", "Emergencies and big repairs ring you for a real conversation before anything is booked."],
  [ShieldCheck, "Every action is on the record", "Each step is checked against your rules first and logged in MongoDB Atlas."],
] as const;

export default function LoginPage() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-forest p-12 text-white lg:flex">
        <div className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)", backgroundSize: "24px 24px" }} />
        <div className="relative flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-white text-sm font-bold text-forest">B</span>
          <span className="text-lg font-semibold">Bedley</span>
        </div>
        <div className="relative max-w-lg">
          <h1 className="text-4xl font-semibold leading-tight">The property manager that never sleeps.</h1>
          <p className="mt-3 text-white/70">An AI assistant for landlords and tenants that handles repairs from the first message to the booked contractor.</p>
          <div className="mt-8 space-y-5">
            {POINTS.map(([Icon, t, d]) => (
              <div key={t} className="flex gap-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/10"><Icon className="h-4 w-4" /></span>
                <div><div className="font-medium">{t}</div><div className="text-sm text-white/65">{d}</div></div>
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-white/45">Built for Ontario tenancies · MongoDB Agents in Context, Toronto</p>
      </div>
      <div className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-forest text-sm font-bold text-white">B</span>
            <span className="text-lg font-semibold">Bedley</span>
          </div>
          <h1 className="text-2xl font-semibold">Welcome back</h1>
          <p className="mb-6 mt-1 text-sm text-ink-faint">Sign in as a landlord or a tenant.</p>
          <LoginForm />
          <div className="panel mt-8 divide-y divide-line text-xs">
            <div className="px-4 py-2.5 font-medium text-ink-soft">Demo accounts · password <span className="mono">demo1234</span></div>
            <div className="px-4 py-2.5"><span className="mono">landlord@bedley.demo</span> · Priya, landlord</div>
            <div className="px-4 py-2.5"><span className="mono">tenant@bedley.demo</span> · Marcus, Midland Commons 2B</div>
            <div className="px-4 py-2.5"><span className="mono">tenant2@bedley.demo</span> · Aisha, Birchmount Terrace 1A</div>
          </div>
        </div>
      </div>
    </div>
  );
}
