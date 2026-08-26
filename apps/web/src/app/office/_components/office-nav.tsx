"use client";

/*
 * Nav tab row — split out from OfficeLayout (a Server Component) into its
 * own Client Component leaf so it can read the current path with
 * usePathname() and highlight the active tab. Same "Server Component
 * parent, Client Component leaf" split as logout-button.tsx.
 *
 * The nav item list is defined here, inside the Client Component, rather
 * than passed down as a prop from OfficeLayout — passing lucide-react icon
 * components as plain object props across the Server/Client boundary
 * fails RSC serialization ("Functions cannot be passed directly to Client
 * Components"). The list is static either way, so this is the simpler fix,
 * not a workaround.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Briefcase, Store, Users, Receipt, Smartphone, LifeBuoy } from "lucide-react";

const NAV = [
  { href: "/office", label: "Dashboard", icon: LayoutDashboard },
  { href: "/office/jobs", label: "Trabalhos", icon: Briefcase },
  { href: "/office/suppliers", label: "Fornecedores", icon: Store },
  { href: "/office/clients", label: "Clientes", icon: Users },
  { href: "/office/quotes", label: "Orçamentos", icon: Receipt },
  { href: "/office/technicians", label: "Técnicos", icon: Smartphone },
  { href: "/office/support", label: "Suporte", icon: LifeBuoy },
];

export function OfficeNav() {
  const pathname = usePathname();

  return (
    <nav className="max-w-6xl mx-auto px-4 flex gap-1 overflow-x-auto">
      {NAV.map((n) => {
        // "/office" (Dashboard) should only be active on an exact match —
        // otherwise it would light up for every other tab, since they all
        // start with "/office" too.
        const active =
          n.href === "/office" ? pathname === "/office" : pathname.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 whitespace-nowrap transition-colors ${
              active
                ? "border-cyan-400 text-white"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
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
