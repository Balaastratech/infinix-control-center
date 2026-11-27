import { PageSkeleton } from "../../route-states";

export default function Loading() {
  return <PageSkeleton title="Audit log" filters={3} rows={10} cols={6} />;
}
