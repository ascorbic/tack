// Send a signed GitHub webhook to a local dev server, for testing live cards
// without a GitHub App.
//
//   node scripts/send-webhook.ts <event> <payload.json> [url]
//
// Reads GITHUB_WEBHOOK_SECRET from .dev.vars.

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const [event, file, url = "http://localhost:5173/webhooks/github"] = process.argv.slice(2);
if (!event || !file) {
	console.error("Usage: node scripts/send-webhook.ts <event> <payload.json> [url]");
	process.exit(1);
}

const secret = /^GITHUB_WEBHOOK_SECRET=(.*)$/m.exec(readFileSync(".dev.vars", "utf8"))?.[1];
if (!secret) {
	console.error("GITHUB_WEBHOOK_SECRET not found in .dev.vars");
	process.exit(1);
}

const body = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const response = await fetch(url, {
	method: "POST",
	body,
	headers: {
		"content-type": "application/json",
		"x-github-event": event,
		"x-github-delivery": randomUUID(),
		"x-hub-signature-256": signature,
	},
});
console.log(response.status, await response.text());
