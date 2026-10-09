// Shared between cloudflare.config.ts (dev/build/deploy) and vite.config.ts
// (tests) so the test runtime always matches the deployed runtime.
export const compatibilityDate = "2026-10-06";
export const compatibilityFlags = ["nodejs_compat"];
