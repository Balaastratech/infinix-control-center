import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/require-role";
import { SESSION_COOKIE } from "@/server/auth/session";
import { AppChrome } from "../app-header";

// Shared shell for every logged-in page: the sidebar and top bar render here once and never unmount on navigation;
// each page's loading.tsx shows only inside the content area.
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return <AppChrome user={user}>{children}</AppChrome>;
}
