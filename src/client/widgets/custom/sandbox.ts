import {
	CUSTOM_LIMITS,
	type FrameMessage,
	type FrameRequest,
	type FrameTheme,
	type HostMessage,
	type LogLevel,
	PROTOCOL,
	avatarUrl,
	customQueryOf,
	parseFrameMessage,
} from "../../../shared/customWidgets.ts";
import { motionScale } from "../../motion.ts";
import type { CustomDataSource } from "./data.ts";

// The board's side of a custom widget's sandbox (#66): one per iframe. It
// only listens to messages from its own frame (`event.source`), checks each
// one (`parseFrameMessage`), answers requests as the person looking may
// (through a `CustomDataSource`), within limits (requests a minute, at once,
// and how long each may take), and pings the frame so code stuck in a loop
// is noticed and stopped. Nothing the frame sends is trusted.

export type SandboxStatus =
	| { kind: "starting" }
	| { kind: "running" }
	/** It never loaded, or stopped answering (a loop that never ends, say). */
	| { kind: "stopped"; reason: "start" | "unresponsive"; message: string };

export interface LogEntry {
	level: LogLevel | "uncaught";
	text: string;
	at: number;
}

export interface SandboxOptions {
	widget: { id: string; title: string };
	code: string;
	config: Record<string, unknown>;
	data: CustomDataSource;
	onStatus(status: SandboxStatus): void;
	onLog?(entry: LogEntry): void;
	/** For tests: shorter waits. */
	limits?: Partial<
		Pick<typeof CUSTOM_LIMITS, "startMs" | "pingMs" | "unresponsiveMs" | "requestMs">
	>;
}

/** The theme tokens a widget can use, as `var(--name)`. */
export const FRAME_TOKENS = [
	"surface",
	"surface-muted",
	"ink",
	"ink-soft",
	"muted",
	"line",
	"line-strong",
	"accent",
	"accent-soft",
	"on-accent",
	"danger",
	"chip",
	"well",
	"skeleton",
	"open",
	"open-bg",
	"merged",
	"merged-bg",
	"closed",
	"closed-bg",
	"pass",
	"fail",
	"pending",
	"chart-done",
	"chart-scope",
] as const;

/** The theme where the widget is drawn (a gallery can show both at once). */
export function frameTheme(element: Element): FrameTheme {
	const style = getComputedStyle(element);
	const tokens: Record<string, string> = {};
	for (const name of FRAME_TOKENS) {
		const value = style.getPropertyValue(`--${name}`).trim();
		if (value) tokens[name] = value;
	}
	const scheme = style.colorScheme.includes("dark") ? "dark" : "light";
	return { mode: scheme, motion: motionScale(), tokens };
}

export class SandboxHost {
	private status: SandboxStatus = { kind: "starting" };
	private timers: ReturnType<typeof setTimeout>[] = [];
	private pinger: ReturnType<typeof setInterval> | undefined;
	private ping = 0;
	private answeredAt = 0;
	private requests: number[] = [];
	private inFlight = 0;
	private avatars = 0;
	private updateTimer: ReturnType<typeof setTimeout> | undefined;
	private unsubscribe: () => void;
	private themeObserver: MutationObserver | null = null;
	private lastTheme = "";
	private limits: typeof CUSTOM_LIMITS;
	private destroyed = false;
	private initialised = false;

	constructor(
		private frame: HTMLIFrameElement,
		private options: SandboxOptions,
	) {
		this.limits = { ...CUSTOM_LIMITS, ...options.limits };
		window.addEventListener("message", this.onMessage);
		this.unsubscribe = options.data.subscribe(() => this.updated());
		// Its "loaded" can arrive before this listens (a cached page, a slow
		// board): the frame's load event says the same, by then for certain.
		frame.addEventListener("load", this.onLoad);
		this.timers.push(
			setTimeout(() => {
				if (this.status.kind === "starting") {
					this.stop("start", "The sandbox didn’t start. Reload the page to try again.");
				}
			}, this.limits.startMs),
		);
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		window.removeEventListener("message", this.onMessage);
		this.frame.removeEventListener("load", this.onLoad);
		this.unsubscribe();
		for (const timer of this.timers) clearTimeout(timer);
		clearTimeout(this.updateTimer);
		clearInterval(this.pinger);
		this.themeObserver?.disconnect();
	}

	private post(message: HostMessage): void {
		// The frame's origin is opaque ("null"), so it can't be named: `event.source` is what's checked.
		this.frame.contentWindow?.postMessage({ tack: PROTOCOL, ...message }, "*");
	}

	private setStatus(status: SandboxStatus): void {
		this.status = status;
		this.options.onStatus(status);
	}

	private stop(reason: "start" | "unresponsive", message: string): void {
		if (this.destroyed) return;
		this.setStatus({ kind: "stopped", reason, message });
		this.destroy();
	}

	private log(level: LogEntry["level"], text: string): void {
		this.options.onLog?.({ level, text, at: Date.now() });
	}

	private onLoad = (): void => {
		if (!this.destroyed) void this.init();
	};

	/** Hands the frame its code, once, with its loops guarded (`guardLoops`). */
	private async init(): Promise<void> {
		if (this.initialised || this.status.kind !== "starting") return;
		this.initialised = true;
		let code: string;
		try {
			const { guardLoops } = await import("./guard.ts");
			code = guardLoops(this.options.code);
		} catch {
			// The guard didn't load (offline, say): nothing runs unguarded.
			this.stop("start", "The sandbox didn’t start. Reload the page to try again.");
			return;
		}
		if (this.destroyed) return;
		this.post({
			type: "init",
			code,
			config: this.options.config,
			widget: this.options.widget,
			theme: this.theme(),
		});
		this.watchTheme();
	}

	private onMessage = (event: MessageEvent): void => {
		if (this.destroyed || event.source !== this.frame.contentWindow) return;
		const message = parseFrameMessage(event.data);
		if (!message) return;
		this.answeredAt = Date.now();
		this.receive(message);
	};

	private receive(message: FrameMessage): void {
		switch (message.type) {
			case "loaded":
				void this.init();
				return;
			case "started":
				if (this.status.kind !== "starting") return;
				this.setStatus({ kind: "running" });
				this.startPinging();
				return;
			case "pong":
				return;
			case "error":
				this.log("uncaught", message.message);
				return;
			case "log":
				this.log(message.level, message.text);
				return;
			case "request":
				void this.answer(message.id, message);
				return;
		}
	}

	private async answer(id: number, request: FrameRequest): Promise<void> {
		const now = Date.now();
		this.requests = this.requests.filter((at) => now - at < 60_000);
		if (this.requests.length >= this.limits.requestsPerMinute) {
			this.refuse(id, "rate_limited", "This widget is asking for too much: wait a moment.");
			return;
		}
		if (this.inFlight >= this.limits.inFlight) {
			this.refuse(
				id,
				"rate_limited",
				`At most ${this.limits.inFlight} requests can wait for an answer at once.`,
			);
			return;
		}
		this.requests.push(now);
		this.inFlight++;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<{ error: [string, string] }>((resolve) => {
			timer = setTimeout(
				() => resolve({ error: ["timeout", "That took too long to answer."] }),
				this.limits.requestMs,
			);
		});
		try {
			const outcome = await Promise.race([this.run(request), timeout]);
			if (this.destroyed) return;
			if ("error" in outcome) this.refuse(id, ...outcome.error);
			else this.post({ type: "response", id, ok: true, value: outcome.value });
		} catch (error) {
			this.refuse(id, "error", error instanceof Error ? error.message : "That didn’t work.");
		} finally {
			clearTimeout(timer);
			this.inFlight--;
		}
	}

	private async run(
		request: FrameRequest,
	): Promise<{ value: unknown } | { error: [string, string] }> {
		switch (request.method) {
			case "search": {
				const query = customQueryOf(request.query);
				if (query.kind === "error") return { error: [query.reason, query.message] };
				const result = await this.options.data.search(query);
				if (result.kind === "error") return { error: [result.reason, result.message] };
				return {
					value: { total: result.total, items: result.items, incomplete: !!result.incomplete },
				};
			}
			case "cards": {
				if (request.keys.length > this.limits.cards) {
					return { error: ["invalid", `Ask for at most ${this.limits.cards} cards at once.`] };
				}
				return { value: this.options.data.cards(request.keys) };
			}
			case "avatar": {
				const url = avatarUrl(request.url, request.size);
				if (!url) return { error: ["invalid", "Only GitHub avatars can be shown."] };
				if (this.avatars >= this.limits.avatars) {
					return { error: ["rate_limited", `At most ${this.limits.avatars} avatars a widget.`] };
				}
				this.avatars++;
				return { value: await this.options.data.avatar(url) };
			}
		}
	}

	private refuse(id: number, reason: string, message: string): void {
		this.post({ type: "response", id, ok: false, error: { reason, message } });
	}

	/** Something it read changed: tell it once things settle. */
	private updated(): void {
		clearTimeout(this.updateTimer);
		this.updateTimer = setTimeout(() => {
			if (this.status.kind === "running") this.post({ type: "update" });
		}, 150);
	}

	private startPinging(): void {
		this.answeredAt = Date.now();
		this.pinger = setInterval(() => {
			if (Date.now() - this.answeredAt > this.limits.unresponsiveMs) {
				this.stop("unresponsive", "This widget stopped responding, so Tack stopped it.");
				return;
			}
			this.post({ type: "ping", n: ++this.ping });
		}, this.limits.pingMs);
	}

	private theme(): FrameTheme {
		const theme = frameTheme(this.frame);
		this.lastTheme = JSON.stringify(theme);
		return theme;
	}

	/** Light, dark, slow or reduced motion: the widget follows the board. */
	private watchTheme(): void {
		const send = () => {
			const theme = frameTheme(this.frame);
			const json = JSON.stringify(theme);
			if (json === this.lastTheme) return;
			this.lastTheme = json;
			this.post({ type: "theme", theme });
		};
		this.themeObserver = new MutationObserver(send);
		this.themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme", "data-motion", "class", "style"],
		});
	}
}
