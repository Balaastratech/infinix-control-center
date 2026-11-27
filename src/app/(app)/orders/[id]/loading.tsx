import { PageSkeleton } from "../../../route-states";

export default function Loading() {
  return <PageSkeleton title="Order" cards={2} rows={5} />;
}
