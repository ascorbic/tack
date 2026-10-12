// The public demo's promise, kept in code as well as words: nothing leaves
// the browser. The board never asks a server (it has none), and this makes
// sure of it: `fetch` reaches only the demo's own files (exported images
// inline its fonts) and `data:`/`blob:` URLs, and WebSockets, beacons and
// EventSource refuse outright. Its Content-Security-Policy says the same to
// the browser (`tryCsp` in src/server/securityHeaders.ts).

/** Where the demo's own files are: /try/ on the docs site, / in development. */
function ownFiles(): string {
	return new URL(import.meta.env.BASE_URL ?? "/", location.origin).href;
}

/**
 * Whether a request stays inside the page: its own files (under `files`), or
 * data it made.
 */
export function staysHere(input: string, files = ownFiles()): boolean {
	let url: URL;
	try {
		url = new URL(input, files);
	} catch {
		return false;
	}
	if (url.protocol === "data:" || url.protocol === "blob:") return true;
	const here = new URL(files);
	return url.origin === here.origin && url.pathname.startsWith(here.pathname);
}

function refused(what: string): Error {
	return new Error(`${what}: this demo runs entirely in your browser, so it never connects out.`);
}

/** Keep the page to itself. Safe to call twice. */
export function stayInTheBrowser(): void {
	const w = window as typeof window & { tackStaysHere?: true };
	if (w.tackStaysHere) return;
	w.tackStaysHere = true;
	const fetch = window.fetch.bind(window);
	window.fetch = (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		if (method !== "GET" || !staysHere(url)) {
			return Promise.reject(new TypeError(refused(`${method} ${url}`).message));
		}
		return fetch(input, init);
	};
	window.WebSocket = class {
		constructor(url: string | URL) {
			throw refused(`WebSocket ${String(url)}`);
		}
	} as unknown as typeof WebSocket;
	window.EventSource = class {
		constructor(url: string | URL) {
			throw refused(`EventSource ${String(url)}`);
		}
	} as unknown as typeof EventSource;
	navigator.sendBeacon = () => false;
}
