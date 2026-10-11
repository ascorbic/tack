// The custom widgets' sandbox (#66): the page each custom widget's iframe
// loads, at `SANDBOX_PATH`. It's the same for every widget and board, holds
// no data, and runs nothing until the board posts it a widget's code.
//
// What keeps the code in it from reaching anything (see
// docs/security-review.md, "Custom widgets"):
//
// - The board frames it with `sandbox="allow-scripts"` only, and this
//   response says the same in its CSP (`sandbox allow-scripts`), so even
//   opened on its own it runs in an opaque origin: no cookies, no storage,
//   nothing of the app's, no popups, forms, modals, downloads or top-level
//   navigation.
// - Its CSP loads nothing from anywhere: no fetches, WebSockets or beacons
//   (`connect-src 'none'`), images and fonts only from `data:` and `blob:`,
//   no frames, workers or objects, no forms, no `<base>`. Scripts are inline
//   only (the bootstrap below, and the widget's code it adds), never eval.
// - Only Tack may frame it (`frame-ancestors 'self'`), and the app's own CSP
//   (`frame-src 'self'`) stops the frame navigating itself anywhere else.
// - WebRTC isn't covered by CSP, so the bootstrap removes it before the
//   widget's code runs (defence in depth: see the review for what's left).
//
// The bootstrap gives the code its API (`window.tack`), forwards its console
// and errors to the board for the editor, and answers the board's pings so a
// widget stuck in a loop can be stopped. Everything it sends the board is
// checked there (`parseFrameMessage`); nothing here is trusted.

import { LOOP_GUARD, LOOP_MS, PROTOCOL, SANDBOX_PATH } from "../../shared/customWidgets.ts";

/** The sandbox page's own policy. */
export const SANDBOX_CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	"img-src data: blob:",
	"font-src data:",
	"media-src data: blob:",
	"connect-src 'none'",
	"frame-src 'none'",
	"child-src 'none'",
	"worker-src 'none'",
	"manifest-src 'none'",
	"object-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
	"frame-ancestors 'self'",
	"sandbox allow-scripts",
].join("; ");

/** Nothing powerful, for the page or anything in it. */
const SANDBOX_PERMISSIONS = [
	"accelerometer",
	"autoplay",
	"camera",
	"clipboard-read",
	"clipboard-write",
	"display-capture",
	"fullscreen",
	"geolocation",
	"gyroscope",
	"magnetometer",
	"microphone",
	"midi",
	"payment",
	"publickey-credentials-get",
	"screen-wake-lock",
	"usb",
	"browsing-topics",
]
	.map((feature) => `${feature}=()`)
	.join(", ");

/** The stylesheet every widget starts with: the board's tokens, its type, quiet scrollbars. */
const BASE_CSS = `
:root {
	--font-ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	--font-mono: ui-monospace, "SF Mono", Menlo, monospace;
	--motion: 1;
	font: 13px/1.45 var(--font-ui);
	color: var(--ink, #17191c);
	background: var(--surface, #fff);
	-webkit-font-smoothing: antialiased;
	text-rendering: optimizeLegibility;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { padding: 12px 14px; overflow: auto; scrollbar-width: thin; scrollbar-color: var(--line-strong, #ccc) transparent; }
h1, h2, h3, h4 { margin: 0 0 0.4em; font-weight: 650; letter-spacing: -0.01em; line-height: 1.2; }
p { margin: 0 0 0.6em; }
a { color: var(--accent); }
code, pre { font-family: var(--font-mono); font-size: 0.92em; }
.muted { color: var(--muted); }
.empty { display: grid; place-items: center; min-height: 100%; margin: 0; text-align: center; color: var(--muted); text-wrap: balance; }
@media (prefers-reduced-motion: reduce) { :root { --motion: 0.001; } }
`;

/**
 * The bootstrap, as it runs in the frame. A string, not a function, so no
 * build step can rewrite it or pull in helpers from outside.
 */
const BOOTSTRAP = `(() => {
"use strict";
const host = window.parent;
const PROTOCOL = ${PROTOCOL};
if (host === window) {
	document.body.textContent = "This page runs custom widgets inside Tack.";
	return;
}
// WebRTC isn't covered by CSP: take it away before the widget's code runs.
for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpSender", "RTCRtpReceiver", "RTCRtpTransceiver", "RTCIceCandidate", "RTCSessionDescription"]) {
	try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch {}
}
const post = (message) => {
	try { host.postMessage(Object.assign({ tack: PROTOCOL }, message), "*"); } catch {}
};
const MAX = 2000;
const text = (value) => {
	try {
		if (typeof value === "string") return value;
		if (value instanceof Error) return value.message || String(value);
		const json = JSON.stringify(value);
		return json === undefined ? String(value) : json;
	} catch {
		return String(value);
	}
};
for (const level of ["log", "info", "warn", "error"]) {
	const original = console[level].bind(console);
	console[level] = (...args) => {
		original(...args);
		post({ type: "log", level, text: args.map(text).join(" ").slice(0, MAX) });
	};
}
window.addEventListener("error", (event) => {
	const where = event.lineno ? " (line " + event.lineno + ")" : "";
	post({ type: "error", message: (text(event.error ?? event.message) + where).slice(0, MAX) });
});
window.addEventListener("unhandledrejection", (event) => {
	post({ type: "error", message: text(event.reason).slice(0, MAX) });
});

// Loops in the widget's code call this at the top of every turn (the board
// adds the calls before sending the code): one that keeps the thread for
// more than LOOP_MS without anything else getting to run throws, so a loop
// that never ends can't freeze the board. Waking from a wait starts afresh:
// the epoch only moves on once a task gets to run between turns.
const LOOP_MS = ${LOOP_MS};
let epoch = 0;
let ticking = false;
Object.defineProperty(window, ${JSON.stringify(LOOP_GUARD)}, {
	value: (state, line) => {
		const now = performance.now();
		if (state.e !== epoch) {
			state.e = epoch;
			state.t = now;
			if (!ticking) {
				ticking = true;
				setTimeout(() => {
					epoch++;
					ticking = false;
				}, 0);
			}
			return;
		}
		if (now - state.t > LOOP_MS) {
			state.e = -1;
			throw new Error("The loop on line " + line + " kept going for over " + LOOP_MS + "ms without a pause, so Tack stopped it.");
		}
	},
});

class TackError extends Error {
	constructor(reason, message) {
		super(message);
		this.name = "TackError";
		this.reason = reason;
	}
}
let next = 0;
const pending = new Map();
const updates = new Set();
const themes = new Set();
const ask = (request) =>
	new Promise((resolve, reject) => {
		const id = next++;
		pending.set(id, { resolve, reject });
		post(Object.assign({ type: "request", id }, request));
	});
const run = (fn, ...args) => {
	try {
		const result = fn(...args);
		if (result && typeof result.then === "function") {
			result.then(undefined, (error) => post({ type: "error", message: text(error).slice(0, MAX) }));
		}
	} catch (error) {
		post({ type: "error", message: text(error).slice(0, MAX) });
	}
};
const freeze = (value) => {
	if (value && typeof value === "object") {
		for (const key of Object.keys(value)) freeze(value[key]);
		Object.freeze(value);
	}
	return value;
};
const theme = { mode: "light", motion: 1 };
const applyTheme = (next) => {
	const style = document.documentElement.style;
	for (const [name, value] of Object.entries(next.tokens || {})) style.setProperty("--" + name, String(value));
	style.setProperty("--motion", String(next.motion));
	style.colorScheme = next.mode;
	document.documentElement.dataset.theme = next.mode;
	theme.mode = next.mode;
	theme.motion = next.motion;
};

let started = false;
const start = (init) => {
	applyTheme(init.theme);
	const tack = {
		config: freeze(init.config),
		widget: freeze(Object.assign({}, init.widget)),
		theme,
		search: (q, options) => ask({ method: "search", query: Object.assign({}, options, { q: String(q) }) }),
		cards: (keys) => ask({ method: "cards", keys: Array.from(keys, String) }),
		avatar: (url, size) => ask({ method: "avatar", url: String(url), size: Math.round(Number(size)) || 64 }),
		onUpdate: (fn) => {
			updates.add(fn);
			return () => updates.delete(fn);
		},
		onTheme: (fn) => {
			themes.add(fn);
			return () => themes.delete(fn);
		},
		TackError,
	};
	Object.defineProperty(window, "tack", { value: Object.freeze(tack), enumerable: true });
	const script = document.createElement("script");
	script.type = "module";
	script.textContent = init.code;
	document.body.append(script);
	setTimeout(() => post({ type: "started" }), 0);
};

window.addEventListener("message", (event) => {
	if (event.source !== host) return;
	const message = event.data;
	if (!message || message.tack !== PROTOCOL) return;
	switch (message.type) {
		case "init":
			if (started) return;
			started = true;
			start(message);
			return;
		case "response": {
			const waiting = pending.get(message.id);
			if (!waiting) return;
			pending.delete(message.id);
			if (message.ok) waiting.resolve(message.value);
			else waiting.reject(new TackError(message.error.reason, message.error.message));
			return;
		}
		case "update":
			for (const fn of updates) run(fn);
			return;
		case "theme":
			applyTheme(message.theme);
			for (const fn of themes) run(fn, theme);
			return;
		case "ping":
			post({ type: "pong", n: message.n });
			return;
	}
});
post({ type: "loaded" });
})();`;

/** The sandbox's page. */
export function sandboxPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tack widget</title>
<style>${BASE_CSS}</style>
</head>
<body>
<script>${BOOTSTRAP}</script>
</body>
</html>
`;
}

/** `GET /sandbox/widget`: the page, with the headers that make it a sandbox. */
export function handleSandbox(request: Request): Response | null {
	const url = new URL(request.url);
	if (url.pathname !== SANDBOX_PATH) return null;
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
	}
	return new Response(request.method === "HEAD" ? null : sandboxPage(), {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": SANDBOX_CSP,
			// Only the app may frame it (the CSP's frame-ancestors says the same).
			"x-frame-options": "SAMEORIGIN",
			"referrer-policy": "no-referrer",
			"permissions-policy": SANDBOX_PERMISSIONS,
			"x-dns-prefetch-control": "off",
			"cache-control": "public, max-age=300",
		},
	});
}
