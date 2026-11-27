import { PageSkeleton } from "../route-states";

export default function Loading() {
  return <PageSkeleton title="Dashboard" cards={4} rows={6} />;
}
