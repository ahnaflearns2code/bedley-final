"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const path = usePathname();
  const active = href === "/landlord" || href === "/tenant" ? path === href : path.startsWith(href);
  return (
    <Link
      href={href}
      className={`flex items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-sm transition ${active ? "bg-forest-50 font-medium text-forest" : "text-ink-soft hover:bg-stone-50 hover:text-ink"}`}
    >
      {children}
    </Link>
  );
}
