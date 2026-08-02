import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The in-app browser uses 127.0.0.1 for local verification. Allow its
  // development HMR/font requests so the client hydrates consistently.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
