import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { LogoutButton } from "./logout-button";

export default async function Home() {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <main>
      <h1>NovaCommerce Ops</h1>
      <p>
        Signed in as {user.email} ({user.role}) <LogoutButton />
      </p>
      <p>
        <Link href="/orders">Orders</Link> · <Link href="/approvals">Approvals</Link> · <Link href="/audit">Audit log</Link>
      </p>
    </main>
  );
}
