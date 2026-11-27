import type { ReactNode } from "react";
import { formatIst } from "@/lib/format";
import type { AuthUser } from "@/server/auth/require-role";
import { listApprovals } from "@/server/services/approvals";
import { getHealth } from "@/server/services/health";
import { LogoutButton } from "./logout-button";
import { SideNav } from "./side-nav";

const SERVICE_NAMES = { commerce: "Commerce API", payments: "Payment API", shipping: "Shipping API" } as const;

// The chrome of every logged-in page, rendered once by app/(app)/layout.tsx so it stays put on navigation: sidebar
// nav, top bar with the user and role, a banner per unreachable service (local DB only).
export function AppChrome({ user, children }: { user: AuthUser; children: ReactNode }) {
  const down = getHealth().filter((h) => h.status === "down");
  const pending = listApprovals().filter((a) => a.status === "pending").length;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">N</span>
          <span>
            NovaCommerce
            <small>Operations console</small>
          </span>
        </div>
        <SideNav pendingApprovals={pending} />
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="topbar-user">
            <span className="email">{user.email}</span>
            <span className={`role ${user.role}`}>{user.role}</span>
          </div>
          <LogoutButton />
        </header>
        {down.map((h) => (
          <p key={h.service} className="banner" role="alert">
            {SERVICE_NAMES[h.service]} unreachable. Showing data from {h.lastOkAt ? formatIst(h.lastOkAt) : "before the first sync"}
            {h.lastError ? ` (${h.lastError})` : ""}
          </p>
        ))}
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

// One page inside the chrome: title block, then content. `user` is accepted for older call sites; the layout owns it.
export function AppShell({ title, subtitle, crumb, actions, children }: {
  user?: AuthUser;
  title: ReactNode;
  subtitle?: ReactNode;
  crumb?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="page-head">
        <div>
          {crumb}
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </>
  );
}
