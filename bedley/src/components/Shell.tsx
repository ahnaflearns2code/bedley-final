import Link from "next/link";
import type { ReactNode } from "react";
import { Home, LayoutDashboard, MessageSquare, ScrollText, Settings, UserRound, Users, Wallet, Wrench } from "lucide-react";
import type { Session } from "@/lib/auth";
import { logout } from "@/app/actions";
import { LiveRefresh } from "./LiveRefresh";
import { NavLink } from "./NavLink";
import { BedleyCall } from "./BedleyCall";

const I = "h-4 w-4 shrink-0";
const LANDLORD_NAV = [
  { href: "/landlord", label: "Overview", icon: <LayoutDashboard className={I} /> },
  { href: "/landlord/tickets", label: "Requests", icon: <Wrench className={I} /> },
  { href: "/landlord/tenants", label: "Tenants", icon: <Users className={I} /> },
  { href: "/landlord/rent", label: "Rent", icon: <Wallet className={I} /> },
  { href: "/landlord/messages", label: "Messages", icon: <MessageSquare className={I} /> },
  { href: "/landlord/settings", label: "Settings", icon: <Settings className={I} /> },
  { href: "/landlord/audit", label: "Activity log", icon: <ScrollText className={I} /> },
];
const TENANT_NAV = [
  { href: "/tenant", label: "Home", icon: <Home className={I} /> },
  { href: "/tenant/messages", label: "Messages", icon: <MessageSquare className={I} /> },
  { href: "/tenant/profile", label: "My details", icon: <UserRound className={I} /> },
];

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-forest text-xs font-bold text-white">B</span>
      <span className="text-[15px] font-semibold tracking-tight">Bedley</span>
    </Link>
  );
}

export function Shell({ session, children }: { session: Session; children: ReactNode }) {
  const nav = session.role === "tenant" ? TENANT_NAV : LANDLORD_NAV;
  const initials = session.name.split(" ").map((x) => x[0]).slice(0, 2).join("");
  const links = nav.map((n) => <NavLink key={n.href} href={n.href}>{n.icon}{n.label}</NavLink>);
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-white md:flex">
        <div className="px-4 py-4"><Brand /></div>
        <nav className="flex-1 space-y-0.5 px-2">{links}</nav>
        <div className="flex items-center gap-2.5 border-t border-line p-3">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-forest-50 text-xs font-semibold text-forest">{initials}</span>
          <div className="min-w-0 flex-1 text-xs">
            <div className="truncate font-medium">{session.name}</div>
            <div className="capitalize text-ink-faint">{session.role}</div>
          </div>
          <form action={logout}><button className="text-xs text-ink-soft underline-offset-2 hover:underline">Sign out</button></form>
        </div>
      </aside>
      <header className="border-b border-line bg-white md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Brand />
          <form action={logout}><button className="text-xs text-ink-soft">Sign out</button></form>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2">{links}</nav>
      </header>
      <main className="min-w-0 flex-1">
        <div className="hidden h-11 items-center justify-end border-b border-line bg-white/60 px-6 md:flex"><LiveRefresh /></div>
        <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">{children}</div>
        {session.role !== "tenant" && <BedleyCall />}
      </main>
    </div>
  );
}
