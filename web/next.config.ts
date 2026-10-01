import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  // GitHub Pages serves static files only: all server logic lives in Cloud Functions.
  output: "export",
  basePath: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@fsm/shared"],
};

export default nextConfig;
