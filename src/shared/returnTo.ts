/**
 * A same-origin path to go back to after signing in or setting up, or
 * `fallback`. Browsers drop tabs and newlines from URLs and read `\` as `/`,
 * so `/\t/evil.example` is `//evil.example`: anything with those, or that
 * resolves to another origin, falls back (#60). Used by the server's
 * redirects and the sign-in page alike.
 */
export function safeReturnTo(value: string | null | undefined, fallback = "/"): string {
	// Control characters, spaces, DEL and backslashes: anything a browser might read differently.
	// oxlint-disable-next-line no-control-regex
	if (!value || !value.startsWith("/") || /[\u0000- \u007f\\]/.test(value)) return fallback;
	try {
		const base = "https://tack.invalid";
		const url = new URL(value, base);
		if (url.origin !== base || value.startsWith("//")) return fallback;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return fallback;
	}
}
