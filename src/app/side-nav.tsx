"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/queues", label: "Work queues" },
  { href: "/orders", label: "Orders" },
  { href: "/customers", label: "Customers" },
  { href: "/tickets", label: "Tickets" },
  { href: "/approvals", label: "Approvals" },
  { href: "/assistant", label: "Assistant" },
  { href: "/workflows", label: "Workflows" },
  { href: "/integrations", label: "Integrations" },
  { href: "/audit", label: "Audit log" },
];

export function SideNav({ pendingApprovals }: { pendingApprovals: number }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((i) => (
        <Link key={i.href} href={i.href} aria-current={active(i.href) ? "page" : undefined}>
          {i.label}
          {i.href === "/approvals" && pendingApprovals > 0 && (
            <span className="nav-count" aria-label={`${pendingApprovals} pending`}>
              {pendingApprovals}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}
