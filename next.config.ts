import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable standalone output for Docker deployment
  // This creates a minimal production build that includes only necessary files
  output: "standalone",
};

export default nextConfig;
