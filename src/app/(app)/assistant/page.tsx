import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { AppShell } from "../../app-header";
import { AssistantChat } from "./assistant-chat";

export default async function AssistantPage() {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return (
    <AppShell user={user} title="Operations assistant" subtitle="Ask in plain words. It uses the same rules and approval flow as the rest of the app.">
      <AssistantChat />
    </AppShell>
  );
}
