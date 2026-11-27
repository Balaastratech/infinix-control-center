import { PageSkeleton } from "../../route-states";

export default function Loading() {
  return <PageSkeleton title="Refund approvals" tabs={3} rows={6} cols={6} />;
}
