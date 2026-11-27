import { PageSkeleton } from "../../route-states";

export default function Loading() {
  return <PageSkeleton title="Support tickets" filters={2} rows={8} cols={6} />;
}
