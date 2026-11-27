import { PageSkeleton } from "../../route-states";

export default function Loading() {
  return <PageSkeleton title="Customers" filters={1} rows={10} />;
}
