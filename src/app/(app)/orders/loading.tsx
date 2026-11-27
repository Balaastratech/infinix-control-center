import { PageSkeleton } from "../../route-states";

export default function Loading() {
  return <PageSkeleton title="Orders" filters={4} rows={10} cols={7} />;
}
