import { repos } from "./namespaces.ts";
import type { WebhookPayload } from "./repo.ts";

const encoder = new TextEncoder();

/** Verify GitHub's `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body). */
export async function verifySignature(
	secret: string,
	body: string,
	signature: string | null,
): Promise<boolean> {
	if (!signature?.startsWith("sha256=")) return false;
	const expected = hexToBytes(signature.slice("sha256=".length));
	if (!expected) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	// subtle.verify compares in constant time.
	return crypto.subtle.verify("HMAC", key, expected, encoder.encode(body));
}

export async function sign(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
	return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function hexToBytes(hex: string): Uint8Array | null {
	if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
	const bytes = new Uint8Array(32);
	for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
	if (!env.WEBHOOK_SECRET) return new Response("Webhook secret not configured", { status: 500 });
	const body = await request.text();
	const valid = await verifySignature(
		env.WEBHOOK_SECRET,
		body,
		request.headers.get("x-hub-signature-256"),
	);
	if (!valid) return new Response("Invalid signature", { status: 401 });

	const event = request.headers.get("x-github-event") ?? "";
	const deliveryId = request.headers.get("x-github-delivery") ?? crypto.randomUUID();
	if (event === "ping") return Response.json({ ok: true });

	const payload = JSON.parse(body) as WebhookPayload;
	const repo = payload.repository?.full_name?.toLowerCase();
	if (!repo) return Response.json({ status: "ignored", reason: "no repository" }, { status: 202 });

	// The real thing keys by repository id so renames don't split the cache.
	const result = await repos(env).getByName(repo).ingest(deliveryId, event, payload);
	return Response.json(result, { status: 202 });
}
