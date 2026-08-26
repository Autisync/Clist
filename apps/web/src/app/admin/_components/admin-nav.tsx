"use client";

/*
 * Admin tab row — same "Server Component parent, Client Component leaf for
 * usePathname()" split as office's OfficeNav, now that /admin has a second
 * page (tickets) besides tenant onboarding.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, LifeBuoy } from "lucide-react";

const NAV = [
  { href: "/admin", label: "Empresas", icon: Building2 },
  { href: "/admin/tickets", label: "Suporte", icon: LifeBuoy },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className="max-w-4xl mx-auto px-4 flex gap-1">
      {NAV.map((n) => {
        const active = n.href === "/admin" ? pathname === "/admin" : pathname.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 whitespace-nowrap transition-colors ${
              active
                ? "border-amber-500 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <n.icon className="w-4 h-4" />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
