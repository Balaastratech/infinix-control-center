import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { WorkflowsEditor } from "./workflows-editor";

export default async function WorkflowsPage() {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <main>
      <p>
        <Link href="/">Home</Link>
      </p>
      <h1>Workflows</h1>
      {/* The form only mirrors the role; every write route checks it again. */}
      <WorkflowsEditor isManager={user.role === "manager"} />
    </main>
  );
}
