// What "Copy prompt" (CopyPrompt.astro) puts on the clipboard: a prompt for
// a coding agent in the reader's terminal, pointing it at /setup.md.
import { SITE } from "./pages.ts";

export const SETUP_URL = `${SITE}/setup.md`;

export const SETUP_PROMPT = `Set up my own Tack, the self-hosted, GitHub-native planning whiteboard, on my Cloudflare account. Read ${SETUP_URL} and follow it step by step. If \`gh\` is installed, use it to fork the repo. Stop and ask me whenever a step needs me in a browser.`;
