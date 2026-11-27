import { PageSkeleton } from "../../../route-states";

export default function Loading() {
  return <PageSkeleton title="Customer" cards={2} rows={6} />;
}
