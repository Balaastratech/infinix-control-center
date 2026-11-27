"use client";
import { RouteError } from "./route-states";

export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} />;
}
