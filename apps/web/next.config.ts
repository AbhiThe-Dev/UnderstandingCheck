import type { NextConfig } from 'next';

const config: NextConfig = {
  // The engine package is TypeScript source shared with the API service.
  transpilePackages: ['@uc/core'],
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
