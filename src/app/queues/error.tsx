"use client";
import { RouteError } from "../route-states";

export default function PageError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} what="the work queues" />;
}
