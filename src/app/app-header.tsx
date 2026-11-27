import Link from "next/link";
import { formatIst } from "@/lib/format";
import type { AuthUser } from "@/server/auth/require-role";
import { getHealth } from "@/server/services/health";
import { LogoutButton } from "./logout-button";

const SERVICE_NAMES = { commerce: "Commerce API", payments: "Payment API", shipping: "Shipping API" } as const;

// On every logged-in page: navigation, who is signed in, and a banner per unreachable service (read from the local DB).
export function AppHeader({ user }: { user: AuthUser }) {
  const down = getHealth().filter((h) => h.status === "down");
  return (
    <header>
      <nav>
        <Link href="/">Dashboard</Link> · <Link href="/orders">Orders</Link> · <Link href="/approvals">Approvals</Link> · <Link href="/assistant">Assistant</Link> ·{" "}
        <Link href="/workflows">Workflows</Link> · <Link href="/integrations">Integrations</Link> · <Link href="/audit">Audit</Link>
        <span style={{ float: "right" }}>
          {user.email} ({user.role}) <LogoutButton />
        </span>
      </nav>
      {down.map((h) => (
        <p key={h.service} className="error" role="alert">
          {SERVICE_NAMES[h.service]} unreachable, data from {h.lastOkAt ? formatIst(h.lastOkAt) : "never synced"}
          {h.lastError ? ` (${h.lastError})` : ""}
        </p>
      ))}
      <hr />
    </header>
  );
}
