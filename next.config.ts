import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Off on purpose: every page shows live, per-user data (orders, money, approvals) read from SQLite,
  // so pages render per request. Caching here would only risk showing stale money/approval state.
  cacheComponents: false,
};

export default nextConfig;
