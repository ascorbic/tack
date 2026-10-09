import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { repos } from "../src/server/namespaces.ts";
import { sign, verifySignature } from "../src/server/webhooks.ts";

function issuePayload(overrides: Record<string, unknown> = {}) {
	return {
		action: "edited",
		repository: { full_name: "Acme/Widgets" },
		issue: {
			number: 7,
			title: "Widgets wobble",
			state: "open",
			html_url: "https://github.com/acme/widgets/issues/7",
			updated_at: "2026-10-01T10:00:00Z",
			labels: [{ name: "bug", color: "d73a4a" }],
			assignees: [],
			comments: 2,
			...overrides,
		},
	};
}

async function deliver(
	payload: unknown,
	opts: { event?: string; id?: string; secret?: string } = {},
) {
	const body = JSON.stringify(payload);
	return exports.default.fetch("https://example.com/webhooks/github", {
		method: "POST",
		body,
		headers: {
			"x-github-event": opts.event ?? "issues",
			"x-github-delivery": opts.id ?? crypto.randomUUID(),
			"x-hub-signature-256": await sign(opts.secret ?? "test-secret", body),
		},
	});
}

describe("webhook signatures", () => {
	it("accepts a valid signature and rejects a tampered body", async () => {
		const signature = await sign("s3cret", "hello");
		expect(await verifySignature("s3cret", "hello", signature)).toBe(true);
		expect(await verifySignature("s3cret", "hellO", signature)).toBe(false);
		expect(await verifySignature("s3cret", "hello", "sha256=nope")).toBe(false);
		expect(await verifySignature("s3cret", "hello", null)).toBe(false);
	});

	it("rejects deliveries signed with the wrong secret", async () => {
		const response = await deliver(issuePayload(), { secret: "wrong" });
		expect(response.status).toBe(401);
	});
});

describe("webhook ingest", () => {
	it("normalises and caches an issue", async () => {
		const response = await deliver(issuePayload());
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ status: "updated", key: "acme/widgets#7" });

		const card = await repos(env).getByName("acme/widgets").getCard("acme/widgets#7");
		expect(card).toMatchObject({ title: "Widgets wobble", state: "open", kind: "issue" });
	});

	it("ignores duplicate deliveries", async () => {
		const id = crypto.randomUUID();
		await deliver(issuePayload(), { id });
		const again = await deliver(issuePayload(), { id });
		expect(await again.json()).toEqual({ status: "duplicate" });
	});

	it("never lets an older payload overwrite a newer one", async () => {
		await deliver(issuePayload({ title: "Newer", updated_at: "2026-10-05T00:00:00Z" }));
		const stale = await deliver(
			issuePayload({ title: "Older", updated_at: "2026-10-02T00:00:00Z" }),
		);
		expect(await stale.json()).toMatchObject({ status: "stale" });
		const card = await repos(env).getByName("acme/widgets").getCard("acme/widgets#7");
		expect(card?.title).toBe("Newer");
	});

	it("marks merged pull requests as merged", async () => {
		const response = await deliver(
			{
				action: "closed",
				repository: { full_name: "acme/widgets" },
				pull_request: {
					number: 8,
					title: "Fix wobble",
					state: "closed",
					merged: true,
					draft: false,
					html_url: "https://github.com/acme/widgets/pull/8",
					updated_at: "2026-10-03T00:00:00Z",
				},
			},
			{ event: "pull_request" },
		);
		expect(await response.json()).toMatchObject({ status: "updated", key: "acme/widgets#8" });
		const card = await repos(env).getByName("acme/widgets").getCard("acme/widgets#8");
		expect(card).toMatchObject({ kind: "pull", state: "merged" });
	});
});

describe("board subscriptions", () => {
	it("fans webhook updates out to subscribed boards", async () => {
		const repo = repos(env).getByName("tack-stress/cards");
		const [card] = await repo.subscribe("board-a", ["tack-stress/cards#2"]);
		expect(card).toMatchObject({ key: "tack-stress/cards#2", state: "closed" });
		expect(await repo.subscribers("tack-stress/cards#2")).toEqual(["board-a"]);

		const response = await deliver(
			{
				action: "reopened",
				repository: { full_name: "tack-stress/cards" },
				issue: {
					number: 2,
					title: "Reopened",
					state: "open",
					html_url: "https://github.com/tack-stress/cards/issues/2",
					updated_at: "2026-10-09T00:00:00Z",
				},
			},
			{ event: "issues" },
		);
		expect(await response.json()).toMatchObject({ status: "updated", boards: 1 });

		await repo.unsubscribe("board-a", ["tack-stress/cards#2"]);
		expect(await repo.subscribers("tack-stress/cards#2")).toEqual([]);
	});
});
