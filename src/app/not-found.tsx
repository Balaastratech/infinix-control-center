import Link from "next/link";
import { Alert } from "./ui";

export default function NotFound() {
  return (
    <main className="page-state">
      <Alert tone="warn">This page does not exist. The link may be old, or the order, customer or ticket id is wrong.</Alert>
      <div className="row">
        <Link href="/" className="link-button">
          Back to dashboard
        </Link>
        <Link href="/orders" className="link-button">
          Orders
        </Link>
      </div>
    </main>
  );
}
