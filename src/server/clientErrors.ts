import * as v from "valibot";
import { log } from "./log.ts";

// `POST /api/client-errors`: errors reported by the browser (error boundary,
// window.onerror, unhandledrejection), logged as structured `client.error`
// events so they land in Workers Logs next to the server's own. No third-party
// service, and nothing about the person beyond what's needed to debug: no IP,
// no cookies, no query strings.

/** Reports bigger than this are refused before parsing. */
export const MAX_BODY_BYTES = 16 * 1024;

/** Per client IP, per isolate. Best effort: enough to stop a loop flooding logs. */
const PER_CLIENT = { limit: 10, windowMs: 60_000 };
/** Across all clients, per isolate. */
const PER_ISOLATE = { limit: 200, windowMs: 60_000 };
const MAX_TRACKED_CLIENTS = 5000;

const text = (max: number) =>
	v.pipe(
		v.string(),
		v.transform((value) => value.slice(0, max)),
	);

const Report = v.object({
	source: v.picklist(["boundary", "error", "unhandledrejection"]),
	name: v.optional(text(100)),
	message: text(1000),
	stack: v.optional(text(4000)),
	componentStack: v.optional(text(2000)),
	/** The page's path. Query strings and fragments are dropped. */
	path: v.optional(text(300)),
	line: v.optional(v.number()),
	column: v.optional(v.number()),
});

export type ClientErrorReport = v.InferInput<typeof Report>;

interface Bucket {
	count: number;
	resetAt: number;
}

export class RateLimiter {
	private clients = new Map<string, Bucket>();
	private all: Bucket = { count: 0, resetAt: 0 };

	constructor(
		private perClient = PER_CLIENT,
		private perIsolate = PER_ISOLATE,
	) {}

	allow(client: string, now = Date.now()): boolean {
		if (this.clients.size > MAX_TRACKED_CLIENTS) this.clients.clear();
		const bucket = this.clients.get(client) ?? { count: 0, resetAt: 0 };
		this.clients.set(client, bucket);
		return take(bucket, this.perClient, now) && take(this.all, this.perIsolate, now);
	}
}

function take(bucket: Bucket, { limit, windowMs }: typeof PER_CLIENT, now: number): boolean {
	if (now >= bucket.resetAt) {
		bucket.count = 0;
		bucket.resetAt = now + windowMs;
	}
	bucket.count++;
	return bucket.count <= limit;
}

const limiter = new RateLimiter();

/** Read at most `max` bytes of the body, or null if it's bigger. */
async function readCapped(request: Request, max: number): Promise<string | null> {
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > max) return null;
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export async function handleClientError(
	request: Request,
	rateLimiter: RateLimiter = limiter,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
	}

	// Only this app's own pages report here.
	const origin = request.headers.get("origin");
	if (origin && origin !== new URL(request.url).origin) {
		return new Response("Forbidden", { status: 403 });
	}

	const client = request.headers.get("cf-connecting-ip") ?? "unknown";
	if (!rateLimiter.allow(client)) {
		return new Response("Too many reports", { status: 429, headers: { "retry-after": "60" } });
	}

	const body = await readCapped(request, MAX_BODY_BYTES);
	if (body === null) return new Response("Report too large", { status: 413 });

	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}
	const parsed = v.safeParse(Report, json);
	if (!parsed.success) return new Response("Invalid report", { status: 400 });

	const { path, ...report } = parsed.output;
	log.error("client.error", {
		...report,
		path: path?.split(/[?#]/)[0],
		userAgent: request.headers.get("user-agent")?.slice(0, 256),
	});
	return new Response(null, { status: 204 });
}
