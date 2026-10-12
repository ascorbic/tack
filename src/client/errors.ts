// Client error reporting. Errors from the error boundary, window.onerror and
// unhandled promise rejections are posted to the Worker, which logs them as
// structured `client.error` events in Workers Logs. No third-party service.
//
// Reports carry only what's needed to debug: the error, its stack, and the
// page's path (no query string, which may name a board). At most a handful
// are sent per page load, and repeats are dropped.

export type ErrorSource = "boundary" | "error" | "unhandledrejection";

const ENDPOINT = "/api/client-errors";
const MAX_REPORTS = 10;

// Noise that isn't ours to fix: benign layout warnings, and cross-origin
// scripts (extensions) whose details the browser hides.
const IGNORED = [/^ResizeObserver loop/, /^Script error\.?$/];

let sent = 0;
const seen = new Set<string>();
/** Off on pages with no Worker to report to: the public demo (#75). */
let reporting = true;

/** Never send reports from this page: errors still reach the console. */
export function stopReporting(): void {
	reporting = false;
}

interface Extra {
	componentStack?: string;
	line?: number;
	column?: number;
}

export function reportError(error: unknown, source: ErrorSource, extra: Extra = {}): void {
	if (!reporting) return;
	try {
		const err = error instanceof Error ? error : null;
		const message = err?.message ?? (typeof error === "string" ? error : safeString(error));
		if (IGNORED.some((pattern) => pattern.test(message))) return;

		const signature = `${err?.name ?? ""}:${message}`;
		if (seen.has(signature) || sent >= MAX_REPORTS) return;
		seen.add(signature);
		sent++;

		const body = JSON.stringify({
			source,
			name: err?.name,
			message: message.slice(0, 1000),
			stack: err?.stack?.slice(0, 4000),
			componentStack: extra.componentStack?.slice(0, 2000),
			path: location.pathname,
			line: extra.line,
			column: extra.column,
		});
		// keepalive lets the report outlive a page that's about to reload.
		void fetch(ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			keepalive: true,
		}).catch(() => {});
	} catch {
		// Reporting must never cause another error.
	}
}

function safeString(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "Unserialisable value";
	}
}

let installed = false;

/** Report uncaught errors and unhandled rejections. Safe to call twice. */
export function installErrorHandlers(): void {
	if (installed) return;
	installed = true;
	window.addEventListener("error", (event) => {
		reportError(event.error ?? event.message, "error", {
			line: event.lineno || undefined,
			column: event.colno || undefined,
		});
	});
	window.addEventListener("unhandledrejection", (event) => {
		reportError(event.reason, "unhandledrejection");
	});
}
