// Small HTTP helpers shared by the auth and setup routes.

/** A same-origin path to return to after a redirect (see src/shared/returnTo.ts). */
export { safeReturnTo } from "../../shared/returnTo.ts";

export function redirect(location: string, cookies: string[] = [], status = 302): Response {
	const headers = new Headers({ location, "cache-control": "no-store" });
	for (const cookie of cookies) headers.append("set-cookie", cookie);
	return new Response(null, { status, headers });
}

/**
 * Reject cross-site state changes. Browsers send `Origin` (and
 * `Sec-Fetch-Site`) on every POST and PUT, so a mismatch means another site
 * is trying to act on the viewer's behalf.
 */
export function isCrossSite(request: Request): boolean {
	const origin = request.headers.get("origin");
	if (origin && origin !== new URL(request.url).origin) return true;
	const site = request.headers.get("sec-fetch-site");
	return site !== null && site !== "same-origin" && site !== "none";
}

export function json(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("cache-control", "no-store");
	return Response.json(body, { ...init, headers });
}

/** Whether the request is to this machine, for local-only features. */
export function isLoopback(request: Request): boolean {
	const host = new URL(request.url).hostname;
	return (
		host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost")
	);
}
