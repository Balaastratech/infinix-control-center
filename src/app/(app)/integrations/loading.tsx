import { PageSkeleton } from "../../route-states";

export default function Loading() {
  return <PageSkeleton title="Integrations" cards={2} filters={2} rows={6} />;
}
