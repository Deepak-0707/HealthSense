import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Stub Node built-ins for browser bundle
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        encoding: false,
      };
    }

    if (isServer) {
      // @vladmandic/face-api uses browser APIs (canvas, fetch, etc.)
      // Mark it as external so it is NEVER bundled for SSR
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        "@vladmandic/face-api",
      ];
    }

    return config;
  },

  turbopack: {
    root: path.resolve(__dirname),
  },

  async headers() {
    return [
      {
        source: "/models/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, immutable" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
    ];
  },
};

export default nextConfig;
