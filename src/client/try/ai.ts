import { DEMO_AI_PATH, type DemoAiRequest } from "../../shared/demoAi.ts";

// The public demo's real AI (#75): stacks' names, Auto-stack, summaries,
// decisions and widgets asked of Workers AI through the docs site's Worker
// (`POST /try/api/ai`, src/demoAi/), with the playground's stand-in as the
// fallback. Anything but an answer (the endpoint isn't there, it's rate
// limited or busy for the day, it failed or took too long) means the
// stand-in answers instead, and the page may say so, quietly. After a rate
// limit or a busy day it doesn't ask again until it's told to; when the
// endpoint isn't there at all (the demo on its own dev server), not again on
// this page.

/** Why the stand-in answered. */
export type Fallback = "unreachable" | "rate_limited" | "busy" | "failed" | "timeout";

export interface DemoAiOptions {
	/** The endpoint's address. */
	endpoint: string;
	fetch?: typeof fetch;
	now?: () => number;
	/** Told each time the stand-in answers instead. */
	onFallback?: (why: Fallback) => void;
}

/** How long to leave it after a network error, before trying again. */
const OFFLINE_MS = 30_000;
/** After a rate limit or a busy day, if the answer doesn't say until when. */
const PAUSE_MS = { rate_limited: 60_000, busy: 60 * 60_000 } as const;

export class DemoAi {
	/** The endpoint isn't there: the stand-in for the rest of this page. */
	private gone = false;
	private pausedUntil = 0;
	private pausedFor: Fallback = "rate_limited";

	constructor(private readonly options: DemoAiOptions) {}

	/**
	 * Ask the endpoint: its answer (JSON), or null for the stand-in to answer
	 * instead. Never throws, but for `signal` aborting.
	 */
	async ask(
		body: DemoAiRequest,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Record<string, unknown> | null> {
		const now = this.options.now ?? Date.now;
		if (this.gone) return this.fallback("unreachable");
		if (now() < this.pausedUntil) return this.fallback(this.pausedFor);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort);
		try {
			const response = await (this.options.fetch ?? fetch)(this.options.endpoint, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
			const isObject = !!answer && typeof answer === "object" && !Array.isArray(answer);
			if (response.ok && isObject && answer.kind !== "error") return answer;
			const retryAt = isObject && typeof answer.retryAt === "number" ? answer.retryAt : null;
			if (response.status === 429 || response.status === 503) {
				const why = response.status === 429 ? "rate_limited" : "busy";
				this.pausedFor = why;
				this.pausedUntil = retryAt ?? now() + PAUSE_MS[why];
				return this.fallback(why);
			}
			// Not this endpoint (a page, or nothing), switched off, or turned away.
			if (!isObject || [403, 404, 405].includes(response.status)) {
				this.gone = true;
				return this.fallback("unreachable");
			}
			return this.fallback("failed");
		} catch (error) {
			if (signal?.aborted) throw error;
			if (controller.signal.aborted) return this.fallback("timeout");
			// Offline, for now.
			this.pausedFor = "unreachable";
			this.pausedUntil = now() + OFFLINE_MS;
			return this.fallback("unreachable");
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}

	private fallback(why: Fallback): null {
		this.options.onFallback?.(why);
		return null;
	}
}

/**
 * Whether this page asks the real AI: the published demo does (built with
 * `--mode try`), the demo on the app's dev server (/play/try, which the e2e
 * tests drive) doesn't unless `?ai=live`, and `?ai=offline` never does.
 */
export function wantsRealAi(mode = import.meta.env.MODE, search = location.search): boolean {
	const asked = new URLSearchParams(search).get("ai");
	if (asked === "offline") return false;
	return asked === "live" || mode === "try";
}

/** The endpoint, under the demo's own files: /try/api/ai on the docs site. */
export function demoAiEndpoint(base = import.meta.env.BASE_URL ?? "/"): string {
	return new URL(DEMO_AI_PATH, new URL(base, location.origin)).href;
}
