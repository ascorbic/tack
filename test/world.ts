// A Worker and a fake GitHub sharing a clock the test moves, for following
// boards over days in seconds (the M3 and M4 exits): `at()` moves both
// clocks on, as `setClock` does (src/server/testClock.ts), and boards whose
// widgets are watched tick as they would have while the time passed.

import type { Miniflare } from "miniflare";
import { expect } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import { type BoardClient, connectBoard } from "./board-client.ts";
import { FakeGitHub, type FakeItem } from "./fake-github.ts";
import { boardStub, instanceStub, setClock, startWorker } from "./harness.ts";

export const ORIGIN = "http://localhost";
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

type BoardStub = Awaited<ReturnType<typeof boardStub>>;

export class World {
	readonly github = new FakeGitHub();
	mf!: Miniflare;
	/** Midnight (UTC) at the start of next week's Monday: days in the test count from here. */
	readonly monday: number;
	private offset = 0;
	private readonly ticking: BoardStub[] = [];
	private readonly cleanups: (() => unknown)[] = [];

	/** `repo`: the fake GitHub's id for the repository `change` and `open` act on. */
	constructor(readonly repo: number) {
		const midnight = Math.ceil(Date.now() / DAY) * DAY;
		// 1970-01-01 was a Thursday.
		const weekday = (midnight / DAY + 4) % 7;
		this.monday = midnight + ((8 - weekday) % 7) * DAY;
		this.github.now = () => this.now();
	}

	/** What time it is, in the Worker and on GitHub. */
	now(): number {
		return Date.now() + this.offset;
	}

	iso(at = this.now()): string {
		return new Date(at).toISOString();
	}

	/** Start the Worker, at `start`, and set the GitHub App up. */
	async boot(start: number): Promise<void> {
		this.mf = startWorker({ devAuth: true, clock: true, outboundService: this.github.fetch });
		this.cleanups.push(() => this.mf.dispose());
		await this.at(start);
		const setup = await (await instanceStub(this.mf)).completeSetup(this.github.manifestCode);
		expect(setup.ok).toBe(true);
	}

	/**
	 * Move the clock on to `time`. Boards whose widgets tick (`tick`) do, as
	 * they would every few seconds while the time passed: renewing their
	 * watches on the repositories their queries read, among other things.
	 */
	async at(time: number): Promise<void> {
		if (this.mf && time < this.now()) {
			throw new Error(`Time only moves forward: it's already ${this.iso()}, not ${this.iso(time)}`);
		}
		this.offset = await setClock(this.mf, time);
		for (const board of this.ticking) await board.runWidgets();
	}

	/** Have a board's widgets tick as time passes, and refresh straight away on webhooks. */
	async tick(board: string): Promise<BoardStub> {
		const stub = await boardStub(this.mf, board);
		await stub.widgetTiming({ freshMs: 0, debounceMs: 20, minIntervalMs: 0, throttleMs: 0 });
		this.ticking.push(stub);
		return stub;
	}

	/** Something happens to an item on GitHub, and its webhook is delivered. */
	async change(number: number, change: Partial<FakeItem>, action: string): Promise<void> {
		this.github.updateItem(this.repo, number, { ...change, updatedAt: this.iso() });
		await this.deliver(this.github.event(this.repo, number, action));
	}

	/** Someone opens an issue or pull request on GitHub, and its webhook is delivered. */
	async open(item: Omit<FakeItem, "updatedAt" | "createdAt">): Promise<void> {
		this.github.setItem(this.repo, { ...item, updatedAt: this.iso(), createdAt: this.iso() });
		await this.deliver(this.github.event(this.repo, item.number, "opened"));
	}

	/** Deliver an `issues` or `pull_request` webhook, signed as GitHub would. */
	async deliver(payload: Record<string, unknown>): Promise<void> {
		const event = "pull_request" in payload ? "pull_request" : "issues";
		const body = JSON.stringify(payload);
		const response = await this.mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
			method: "POST",
			body,
			headers: {
				"x-github-event": event,
				"x-github-delivery": crypto.randomUUID(),
				"x-hub-signature-256": await sign(this.github.app.webhook_secret, body),
			},
		});
		expect(response.status).toBe(202);
	}

	api(path: string, cookie: string, init: RequestInit = {}) {
		const headers = new Headers(init.headers as HeadersInit);
		headers.set("cookie", cookie);
		if (init.body) {
			headers.set("content-type", "application/json");
			headers.set("origin", ORIGIN);
		}
		return this.mf.dispatchFetch(`${ORIGIN}${path}`, { ...init, headers } as never);
	}

	async json<T>(path: string, cookie: string, init: RequestInit = {}): Promise<T> {
		const response = await this.api(path, cookie, init);
		if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
		return (await response.json()) as T;
	}

	/** Open a board over a WebSocket, as `cookie`'s person; closed when the world is. */
	async connect(board: string, cookie: string): Promise<BoardClient> {
		const connected = await connectBoard(this.mf, board, cookie);
		if (!connected.ok) throw new Error(`connect: ${connected.status} ${connected.error}`);
		this.cleanups.push(() => connected.client.close());
		return connected.client;
	}

	async dispose(): Promise<void> {
		for (const cleanup of this.cleanups.splice(0).reverse()) await cleanup();
	}
}
