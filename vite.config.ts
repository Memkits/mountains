import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, loadEnv } from 'vite';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), '');
  const tiandituApiKey =
    process.env.TIANDITU_API_KEY ??
    environment.TIANDITU_API_KEY ??
    environment.VITE_TIANDITU_API_KEY ??
    '';

  return {
    // The production workflow uploads the static bundle beneath a repository
    // directory on the configured server. Relative paths keep all assets valid
    // regardless of that public mount path; local development stays rooted.
    base: process.env.GITHUB_ACTIONS ? './' : '/',
    define: {
      'import.meta.env.VITE_TIANDITU_API_KEY': JSON.stringify(tiandituApiKey),
    },
    css: { postcss: { plugins: [tailwindcss()] } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [vinext()],
  };
});
