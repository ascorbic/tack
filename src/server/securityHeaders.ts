// Security headers on every response (#60): the Worker's own (API, auth,
// webhooks, snapshots, board sync) through `withSecurityHeaders`, and the
// app's static assets through a `_headers` file the build writes
// (`headersFile`, from vite.config.ts), with the hashes of index.html's
// inline script. Plain functions, no Worker APIs, so the build can use them.
// See docs/security-review.md.

/** Headers every response carries. */
export const COMMON_HEADERS: Readonly<Record<string, string>> = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "strict-origin-when-cross-origin",
	"x-frame-options": "DENY",
	"cross-origin-opener-policy": "same-origin",
	"permissions-policy":
		"camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
};

/**
 * For the Worker's responses, which are data, never documents: nothing in
 * them may run, load or be framed.
 */
export const API_CSP =
	"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * For SVG the Worker serves (board embeds): drawn with its own styles,
 * fonts and images inline, and never anything that runs.
 */
export const SVG_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'none'";

export interface InlineHashes {
	/** `sha256-…` of each inline `<script>`'s text. */
	scripts: string[];
}

/**
 * The app's policy. Scripts are only the app's own files and the inline
 * theme script, by hash. Styles allow inline: React Flow positions every
 * node with a `style` attribute, and backlink snapshots clone the canvas
 * (attributes and all), so hashes can't cover them; injected CSS can't run
 * anything, and React escapes everything it renders. Images are any HTTPS
 * host (GitHub avatars, and images in issue bodies people write), and the
 * snapshot drawer fetches avatars to inline them. Forms only go to GitHub
 * (the app manifest at setup), and nothing may frame the app.
 */
export function appCsp(hashes: InlineHashes): string {
	const directives: Record<string, string[]> = {
		"default-src": ["'self'"],
		"script-src": ["'self'", ...hashes.scripts.map((hash) => `'${hash}'`)],
		"style-src": ["'self'", "'unsafe-inline'"],
		"img-src": ["'self'", "data:", "blob:", "https:"],
		"font-src": ["'self'", "data:"],
		"connect-src": ["'self'", "https://avatars.githubusercontent.com"],
		"worker-src": ["'self'", "blob:"],
		"frame-src": ["'self'"],
		"object-src": ["'none'"],
		"base-uri": ["'none'"],
		"form-action": ["'self'", "https://github.com"],
		"frame-ancestors": ["'none'"],
		"manifest-src": ["'self'"],
	};
	return Object.entries(directives)
		.map(([name, values]) => `${name} ${values.join(" ")}`)
		.join("; ");
}

/** The `sha256-…` hashes of an HTML document's inline scripts. */
export async function inlineHashes(html: string): Promise<InlineHashes> {
	const scripts: string[] = [];
	// Classic and module scripts alike, as long as they have no `src`.
	for (const match of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
		const text = match[1] ?? "";
		if (text.trim()) scripts.push(await sha256(text));
	}
	return { scripts };
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	let binary = "";
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
	return `sha256-${btoa(binary)}`;
}

/**
 * Cloudflare's `_headers` file for the static assets: the app's policy and
 * the common headers on every asset, and HSTS (assets are only ever served
 * over HTTPS in production). Assets are content-hashed, so they're cached
 * for a year.
 */
export function headersFile(hashes: InlineHashes): string {
	const lines = [
		"# Written by the build (vite.config.ts, src/server/securityHeaders.ts). Don't edit.",
		"/*",
		`  Content-Security-Policy: ${appCsp(hashes)}`,
		...Object.entries(COMMON_HEADERS).map(([name, value]) => `  ${title(name)}: ${value}`),
		"  Strict-Transport-Security: max-age=31536000",
		"/assets/*",
		"  Cache-Control: public, max-age=31536000, immutable",
		"",
	];
	return lines.join("\n");
}

function title(name: string): string {
	return name.replace(
		/(^|-)([a-z])/g,
		(_, dash: string, letter: string) => dash + letter.toUpperCase(),
	);
}

/**
 * The Worker's response with the security headers added: the common ones,
 * HSTS over HTTPS, a policy for what it is (nothing at all for data; inline
 * styles only for SVG), and `same-origin` resources for the API. Anything a
 * route set itself is kept. WebSocket upgrades pass through untouched.
 */
export function withSecurityHeaders(request: Request, response: Response): Response {
	if (response.status === 101 || response.webSocket) return response;
	const url = new URL(request.url);
	let headers: Headers;
	let result = response;
	try {
		headers = response.headers;
		headers.set("x-tack-probe", "1");
		headers.delete("x-tack-probe");
	} catch {
		// Immutable (a response from fetch or another object): copy it.
		result = new Response(response.body, response);
		headers = result.headers;
	}
	const set = (name: string, value: string) => {
		if (!headers.has(name)) headers.set(name, value);
	};
	for (const [name, value] of Object.entries(COMMON_HEADERS)) set(name, value);
	if (url.protocol === "https:") set("strict-transport-security", "max-age=31536000");
	const type = headers.get("content-type") ?? "";
	set("content-security-policy", type.includes("image/svg+xml") ? SVG_CSP : API_CSP);
	if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
		set("cross-origin-resource-policy", "same-origin");
	}
	return result;
}
