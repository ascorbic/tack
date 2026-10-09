// Cookie parsing and serialising. Every Tack cookie is HTTP-only and
// SameSite=Lax, and Secure everywhere except plain-HTTP local development.

export function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
	}
	return null;
}

export interface CookieOptions {
	/** Lifetime in seconds. Zero clears the cookie. */
	maxAge: number;
	path?: string;
}

export function serializeCookie(
	request: Request,
	name: string,
	value: string,
	{ maxAge, path = "/" }: CookieOptions,
): string {
	const parts = [
		`${name}=${encodeURIComponent(value)}`,
		`Path=${path}`,
		`Max-Age=${maxAge}`,
		"HttpOnly",
		"SameSite=Lax",
	];
	if (new URL(request.url).protocol === "https:") parts.push("Secure");
	return parts.join("; ");
}

export function clearCookie(request: Request, name: string, path = "/"): string {
	return serializeCookie(request, name, "", { maxAge: 0, path });
}
