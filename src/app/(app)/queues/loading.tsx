import { PageSkeleton } from "../../route-states";

export default function Loading() {
  return <PageSkeleton title="Work queues" tabs={3} rows={8} />;
}
