// Since you were here (#46): what happened on GitHub to a board's cards
// while you were away, from webhook deliveries to a real board in
// Miniflare, through its `Repo` objects and a fake GitHub.

import type { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { sign } from "../src/server/forges/hmac.ts";
import type { CardMessage } from "../src/shared/cards.ts";
import { addShape } from "../src/shared/shapes.ts";
import type { Digest, SinceEvent } from "../src/shared/since.ts";
import { type BoardClient, connectBoard, eventually } from "./board-client.ts";
import { FakeGitHub } from "./fake-github.ts";
import { startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const WIDGETS = { id: 42, node_id: "R_42", full_name: "acme/widgets", private: false };
const REPO = "github.com/acme/widgets";
const T0 = "2026-10-01T00:00:00Z";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(name: string): Promise<{ mf: Miniflare; client: BoardClient }> {
	const github = new FakeGitHub();
	github.addRepo(WIDGETS.id, WIDGETS.full_name);
	github.setItem(WIDGETS.id, { number: 12, kind: "issue", title: "Widgets wobble", updatedAt: T0 });
	const mf = startWorker({ outboundService: github.fetch, bindings: { GITHUB_TOKEN: "t" } });
	cleanups.push(() => mf.dispose());
	const adopted = await mf.dispatchFetch(`${ORIGIN}/api/boards/legacy`, {
		method: "POST",
		headers: { origin: ORIGIN, "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});
	expect(adopted.status).toBe(200);
	const result = await connectBoard(mf, name);
	if (!result.ok) throw new Error(`connect: ${result.status}`);
	cleanups.push(() => result.client.close());
	return { mf, client: result.client };
}

async function deliver(mf: Miniflare, event: string, payload: Record<string, unknown>) {
	const body = JSON.stringify(payload);
	const response = await mf.dispatchFetch(`${ORIGIN}/webhooks/github`, {
		method: "POST",
		body,
		headers: {
			"x-github-event": event,
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": await sign("test-secret", body),
		},
	});
	expect(response.status).toBe(202);
}

function issue(state: "open" | "closed", comments: number, updated: string) {
	return {
		number: 12,
		title: "Widgets wobble",
		state,
		state_reason: state === "closed" ? "completed" : null,
		html_url: "https://github.com/acme/widgets/issues/12",
		updated_at: updated,
		labels: [],
		assignees: [],
		comments,
	};
}

function cardState(client: BoardClient, key: string): string | undefined {
	for (const message of [...(client.messages as CardMessage[])].reverse()) {
		if (message.type !== "cards") continue;
		const card = message.cards.find((entry) => entry.key === key);
		if (card && !("missing" in card)) return card.state;
	}
	return undefined;
}

async function digest(client: BoardClient, since: number): Promise<Digest> {
	const count = () => client.messages.filter((m) => (m as SinceEvent).type === "since").length;
	const before = count();
	client.send({ type: "since-request", since });
	await eventually(() => count() > before);
	return (client.messages.filter((m) => (m as SinceEvent).type === "since").at(-1) as SinceEvent)
		.digest;
}

describe("since you were here: GitHub activity", () => {
	it("tells what happened to the board's cards since a visit", async () => {
		const { mf, client } = await open("since-cards");
		const key = `${REPO}#12`;
		addShape(client.doc, "card", { type: "card", ref: key, x: 0, y: 0, z: "a1" });
		await client.roundTrip();
		await eventually(() => cardState(client, key) === "open", 8000);
		const away = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 20));

		await deliver(mf, "issues", {
			action: "closed",
			repository: WIDGETS,
			issue: issue("closed", 3, "2026-10-03T00:00:00Z"),
		});
		await eventually(() => cardState(client, key) === "closed", 8000);

		const result = await digest(client, away);
		expect(result.cards.map((entry) => [entry.key, entry.kind, entry.count])).toEqual([
			[key, "closed", undefined],
			[key, "comments", 3],
		]);
		// The card was put on the board before then.
		expect(result.edits).toEqual([]);

		// Since now, nothing.
		expect((await digest(client, Date.now())).cards).toEqual([]);
	});
});
