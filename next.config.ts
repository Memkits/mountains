import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // No server or API routes are required: deployment receives only static
  // HTML, JavaScript, CSS, and public assets.
  output: 'export',
};

export default nextConfig;
