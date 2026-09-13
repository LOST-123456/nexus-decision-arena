import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@nexus/shared"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async rewrites() {
    const target =
      process.env.API_PROXY_TARGET?.replace(/\/$/, "") ??
      "http://127.0.0.1:4100";
    return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
  }
};

export default config;