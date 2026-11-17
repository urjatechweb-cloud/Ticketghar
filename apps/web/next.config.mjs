import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Share the repo-root .env with the API; variables already set in the environment win.
const rootEnv = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};
export default nextConfig;
