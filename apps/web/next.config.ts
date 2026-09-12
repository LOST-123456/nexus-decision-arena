import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@nexus/shared"],
  allowedDevOrigins: ["127.0.0.1", "localhost"]
};

export default config;
