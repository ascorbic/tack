import { DurableObject } from "cloudflare:workers";
import { getServerByName } from "partyserver";
import {
	type Card,
	type GitHubIssueLike,
	type MissingCard,
	normaliseIssue,
	parseRef,
} from "../shared/cards.ts";
import type { Board } from "./board.ts";
import { boards } from "./namespaces.ts";

// Synthetic repo for stress tests: cards are generated, never fetched.
const STRESS_REPO = "tack-stress/cards#";
const STRESS_LABELS = [
	{ name: "bug", color: "d73a4a" },
	{ name: "enhancement", color: "a2eeef" },
	{ name: "docs", color: "0075ca" },
	{ name: "good first issue", color: "7057ff" },
];

function stressCard(key: string): Card {
	const n = Number(key.slice(STRESS_REPO.length));
	const states = ["open", "open", "closed", "merged", "draft"] as const;
	const state = states[n % states.length] ?? "open";
	return {
		key,
		kind: state === "merged" || state === "draft" ? "pull" : "issue",
		repo: "tack-stress/cards",
		number: n,
		title: `Synthetic card ${n}: a reasonably long title so it wraps onto two lines`,
		state,
		stateReason: state === "closed" ? "completed" : null,
		labels: STRESS_LABELS.slice(0, (n % 3) + 1),
		assignees: [],
		author: null,
		comments: n % 17,
		reactions: n % 9,
		url: `https://github.com/tack-stress/cards/issues/${n}`,
		updatedAt: new Date(0).toISOString(),
	};
}

export type IngestResult =
	| { status: "duplicate" }
	| { status: "ignored"; reason: string }
	| { status: "stale"; key: string }
	| { status: "updated"; key: string; boards: number };

export interface WebhookPayload {
	action?: string;
	repository?: { full_name: string };
	issue?: GitHubIssueLike;
	pull_request?: GitHubIssueLike;
}

/**
 * One per repository. Caches normalised cards, records which boards reference
 * which cards, keeps a raw log of webhook deliveries, and fans card updates out
 * to subscribed boards.
 */
export class Repo extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS cards (
				key TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS subscriptions (
				key TEXT NOT NULL,
				board TEXT NOT NULL,
				PRIMARY KEY (key, board)
			);
			CREATE TABLE IF NOT EXISTS events (
				delivery_id TEXT PRIMARY KEY,
				event TEXT NOT NULL,
				action TEXT,
				payload TEXT NOT NULL,
				received_at TEXT NOT NULL
			);
		`);
	}

	/** Register a board's interest in cards and return their current data. */
	async subscribe(board: string, keys: string[]): Promise<(Card | MissingCard)[]> {
		for (const key of keys) {
			this.sql.exec("INSERT OR IGNORE INTO subscriptions (key, board) VALUES (?, ?)", key, board);
		}
		return Promise.all(keys.map((key) => this.cardOrFetch(key)));
	}

	unsubscribe(board: string, keys: string[]): void {
		for (const key of keys) {
			this.sql.exec("DELETE FROM subscriptions WHERE key = ? AND board = ?", key, board);
		}
	}

	getCard(key: string): Card | null {
		const row = this.sql
			.exec<{ data: string }>("SELECT data FROM cards WHERE key = ?", key)
			.toArray()[0];
		return row ? (JSON.parse(row.data) as Card) : null;
	}

	subscribers(key: string): string[] {
		return this.sql
			.exec<{ board: string }>("SELECT board FROM subscriptions WHERE key = ?", key)
			.toArray()
			.map((row) => row.board);
	}

	async ingest(deliveryId: string, event: string, payload: WebhookPayload): Promise<IngestResult> {
		const seen = this.sql
			.exec("SELECT 1 FROM events WHERE delivery_id = ?", deliveryId)
			.toArray().length;
		if (seen) return { status: "duplicate" };

		this.sql.exec(
			"INSERT INTO events (delivery_id, event, action, payload, received_at) VALUES (?, ?, ?, ?, ?)",
			deliveryId,
			event,
			payload.action ?? null,
			JSON.stringify(payload),
			new Date().toISOString(),
		);

		const repo = payload.repository?.full_name;
		const item =
			event === "issues"
				? payload.issue
				: event === "pull_request"
					? payload.pull_request
					: undefined;
		if (!repo || !item) return { status: "ignored", reason: `unhandled event ${event}` };

		const card = normaliseIssue(repo, item, event === "pull_request");
		const existing = this.getCard(card.key);
		// Webhooks can arrive out of order: never let an older payload win.
		if (existing && existing.updatedAt > card.updatedAt) return { status: "stale", key: card.key };

		this.store(card);
		const subscribed = this.subscribers(card.key);
		await Promise.allSettled(
			subscribed.map(async (name) => {
				const board = await getServerByName<Env, Board>(boards(this.env), name);
				await board.cardUpdated(card);
			}),
		);
		return { status: "updated", key: card.key, boards: subscribed.length };
	}

	private store(card: Card): void {
		this.sql.exec(
			"INSERT OR REPLACE INTO cards (key, data, updated_at) VALUES (?, ?, ?)",
			card.key,
			JSON.stringify(card),
			card.updatedAt,
		);
	}

	private async cardOrFetch(key: string): Promise<Card | MissingCard> {
		const cached = this.getCard(key);
		if (cached) return cached;
		const card = key.startsWith(STRESS_REPO) ? stressCard(key) : await this.fetchFromGitHub(key);
		if (!("missing" in card)) this.store(card);
		return card;
	}

	// Spike: REST with an optional token. The real thing uses installation
	// tokens and batched GraphQL `nodes()` queries.
	private async fetchFromGitHub(key: string): Promise<Card | MissingCard> {
		const ref = parseRef(key);
		if (!ref) return { key, missing: true, reason: "not_found" };
		const headers: HeadersInit = {
			accept: "application/vnd.github+json",
			"user-agent": "tack",
			...(this.env.GITHUB_TOKEN ? { authorization: `Bearer ${this.env.GITHUB_TOKEN}` } : {}),
		};
		const base = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
		try {
			const res = await fetch(`${base}/issues/${ref.number}`, { headers });
			if (res.status === 404) return { key, missing: true, reason: "not_found" };
			if (res.status === 403 || res.status === 401)
				return { key, missing: true, reason: "forbidden" };
			if (!res.ok) return { key, missing: true, reason: "error" };
			const issue = await res.json<GitHubIssueLike>();
			if (issue.pull_request) {
				// The issues endpoint doesn't say whether a PR is a draft.
				const pr = await fetch(`${base}/pulls/${ref.number}`, { headers });
				if (pr.ok) Object.assign(issue, { draft: (await pr.json<GitHubIssueLike>()).draft });
			}
			return normaliseIssue(`${ref.owner}/${ref.repo}`, issue);
		} catch {
			return { key, missing: true, reason: "error" };
		}
	}
}
