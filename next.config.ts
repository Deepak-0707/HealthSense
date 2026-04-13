import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // face-api.js references Node.js built-ins — stub them out for browser bundles
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        encoding: false,
      };
    }
    return config;
  },

  turbopack: {
    // Pin the project root so Next.js doesn't walk up to C:\Users\deepa
    // and get confused by a parent-level package-lock.json on Windows.
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
