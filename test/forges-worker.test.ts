// Other forges through the Worker (#65): `/webhooks/gitlab` and
// `/webhooks/forgejo` checked against the host's secret before anything is
// ingested, repositories going live as deliveries arrive, Tangled's lack of
// webhooks, and `/api/me` saying which forges the instance serves.

import { type Miniflare, Response as MfResponse, type Request as MfRequest } from "miniflare";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Me } from "../src/shared/auth.ts";
import type { Card } from "../src/shared/cards.ts";
import { changesMap, readChange, stageChange } from "../src/shared/changes.ts";
import type { PushResponse } from "../src/shared/push.ts";
import { sign } from "../src/server/forges/hmac.ts";
import { FakeForgejo, FakeGitLab, forgesFetch } from "./fake-forges.ts";
import { connectBoard, eventually } from "./board-client.ts";
import { boardStub, repoStub, signIn, startWorker } from "./harness.ts";

const ORIGIN = "http://localhost";
const GL_HOST = "git.example.com";
const GL_SECRET = "gitlab-hook-secret";
const FJ_SECRET = "forgejo-hook-secret";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function start(gitlabConfig: Record<string, unknown> = {}) {
	const gitlab = new FakeGitLab(GL_HOST);
	gitlab.addProject(42, "acme/app");
	gitlab.setIssue(42, { iid: 1, title: "Dark mode" });
	const forgejo = new FakeForgejo("codeberg.org");
	forgejo.addRepo(7, "acme/kite");
	forgejo.setItem("acme/kite", { number: 1, title: "Offline mode" });
	const route = forgesFetch({ gitlab: [gitlab], forgejo: [forgejo] });
	const mf = startWorker({
		devAuth: true,
		bindings: {
			TACK_FORGES: JSON.stringify([
				{
					host: GL_HOST,
					forge: "gitlab",
					name: "Acme GitLab",
					token: gitlab.token,
					webhookSecret: GL_SECRET,
					writes: true,
					...gitlabConfig,
				},
				{ host: "codeberg.org", token: forgejo.token, webhookSecret: FJ_SECRET },
			]),
		},
		// Miniflare's requests and responses to and from the fakes' own.
		outboundService: async (request: MfRequest) => {
			const body = request.method === "GET" ? undefined : await request.text();
			const answer = await route(
				new globalThis.Request(request.url, {
					method: request.method,
					headers: Object.fromEntries(request.headers),
					body,
				}),
			);
			return new MfResponse(await answer.text(), {
				status: answer.status,
				headers: Object.fromEntries(answer.headers),
			}) as never;
		},
	});
	cleanups.push(() => mf.dispose());
	return { mf, gitlab, forgejo };
}

const gitlabHook = {
	object_kind: "issue",
	project: {
		id: 42,
		path_with_namespace: "acme/app",
		web_url: `https://${GL_HOST}/acme/app`,
		visibility_level: 20,
	},
	object_attributes: { iid: 1, action: "update" },
};

function deliverGitLab(mf: Miniflare, body: unknown, token: string | null, uuid = "u-1") {
	return mf.dispatchFetch(`${ORIGIN}/webhooks/gitlab`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-gitlab-event": "Issue Hook",
			"x-gitlab-event-uuid": uuid,
			...(token === null ? {} : { "x-gitlab-token": token }),
		},
		body: JSON.stringify(body),
	});
}

async function deliverForgejo(mf: Miniflare, body: unknown, secret: string) {
	const text = JSON.stringify(body);
	return mf.dispatchFetch(`${ORIGIN}/webhooks/forgejo`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-forgejo-event": "issues",
			"x-forgejo-delivery": "f-1",
			"x-forgejo-signature": (await sign(secret, text)).replace(/^sha256=/, ""),
		},
		body: text,
	});
}

describe("webhooks from other forges", () => {
	it("takes GitLab's with the host's token, and the project goes live", async () => {
		const { mf, gitlab } = start();
		const repo = await repoStub(mf, `${GL_HOST}/@42`);
		const identity = {
			forge: "gitlab" as const,
			host: GL_HOST,
			id: "42",
			name: "acme/app",
			private: false,
		};
		const [before] = (await repo.subscribe("b1", [`${GL_HOST}/acme/app#1`], identity)) as Card[];
		// Writes are on, but no webhook has arrived: checked while watched.
		expect(before).toMatchObject({ title: "Dark mode", live: false, writable: true });

		gitlab.setIssue(42, {
			iid: 1,
			title: "Dark mode, everywhere",
			updated_at: "2026-10-02T00:00:00Z",
		});
		const response = await deliverGitLab(mf, gitlabHook, GL_SECRET);
		expect(response.status).toBe(202);
		expect(await repo.status()).toMatchObject({ live: true, writable: true });
		expect(await repo.getCard(`${GL_HOST}/acme/app#1`)).toMatchObject({
			title: "Dark mode, everywhere",
		});
	});

	it("refuses GitLab deliveries without the right token, ingesting nothing", async () => {
		const { mf } = start();
		expect((await deliverGitLab(mf, gitlabHook, "guess")).status).toBe(401);
		expect((await deliverGitLab(mf, gitlabHook, null, "u-2")).status).toBe(401);
		// The token for gitlab.com (none here) doesn't stand in for another host's.
		const elsewhere = {
			...gitlabHook,
			project: { ...gitlabHook.project, web_url: "https://gitlab.com/acme/app" },
		};
		expect((await deliverGitLab(mf, elsewhere, GL_SECRET, "u-3")).status).toBe(403);
		const repo = await repoStub(mf, `${GL_HOST}/@42`);
		expect(await repo.identity()).toBeNull();
	});

	it("takes Forgejo's signed with the host's secret, and refuses the rest", async () => {
		const { mf } = start();
		const event = {
			action: "edited",
			issue: {
				number: 1,
				title: "Offline mode",
				state: "open",
				html_url: "https://codeberg.org/acme/kite/issues/1",
				updated_at: "2026-10-04T00:00:00Z",
			},
			repository: {
				id: 7,
				full_name: "acme/kite",
				private: false,
				html_url: "https://codeberg.org/acme/kite",
			},
		};
		expect((await deliverForgejo(mf, event, "guess")).status).toBe(401);
		expect((await deliverForgejo(mf, event, FJ_SECRET)).status).toBe(202);
		const repo = await repoStub(mf, "codeberg.org/@7");
		// Codeberg's writes aren't on here: live, but read-only.
		expect(await repo.status()).toMatchObject({
			live: true,
			writable: false,
			visibility: "public",
		});
	});

	it("has no webhooks for Tangled", async () => {
		const { mf } = start();
		const response = await mf.dispatchFetch(`${ORIGIN}/webhooks/tangled`, {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(404);
	});
});

describe("/api/me", () => {
	it("lists the forges the instance serves, without their credentials", async () => {
		const { mf } = start();
		const me = (await (await mf.dispatchFetch(`${ORIGIN}/api/me`)).json()) as Me;
		expect(me.forges).toEqual([
			{ host: "gitlab.com", forge: "gitlab", name: "GitLab" },
			{ host: "codeberg.org", forge: "forgejo", name: "Codeberg" },
			{ host: "tangled.org", forge: "tangled", name: "Tangled" },
			{ host: GL_HOST, forge: "gitlab", name: "Acme GitLab" },
		]);
		expect(JSON.stringify(me)).not.toContain("token");
	});
});

describe("pushing to other forges", () => {
	async function board(mf: Miniflare, login: string) {
		const cookie = await signIn(mf, login);
		const call = (path: string, body: unknown) =>
			mf.dispatchFetch(`${ORIGIN}${path}`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const created = await call("/api/boards", { title: "Planning" });
		const { id } = (await created.json()) as { id: string };
		const connected = await connectBoard(mf, id, cookie);
		if (!connected.ok) throw new Error(`connect: ${connected.status}`);
		const client = connected.client;
		cleanups.push(() => client.close());
		await (await boardStub(mf, id)).pushTiming({ spacingMs: 10, confirmMs: 60_000, backoffMs: 50 });
		const push = async (ids: string[]) => {
			const response = await call(`/api/boards/${id}/push`, { ids, as: "user" });
			return { status: response.status, body: (await response.json()) as PushResponse };
		};
		return { client, push };
	}

	const status = (client: { doc: Parameters<typeof changesMap>[0] }, id: string) => {
		const map = changesMap(client.doc).get(id);
		return map ? readChange(map) : undefined;
	};

	it("writes to GitLab with the instance's token, whoever pushes", async () => {
		const { mf, gitlab } = start();
		const { client, push } = await board(mf, "devvy");
		stageChange(
			client.doc,
			{ kind: "item.labels", target: { key: `${GL_HOST}/acme/app#1` }, add: ["bug"] },
			{ name: "Devvy" },
			{ id: "label" },
		);
		stageChange(
			client.doc,
			{ kind: "item.comment", target: { key: `${GL_HOST}/acme/app#1` }, body: "From the board" },
			{ name: "Devvy" },
			{ id: "comment" },
		);
		await client.roundTrip();
		expect((await push(["label", "comment"])).status).toBe(202);
		await eventually(() => status(client, "comment")?.status === "applied", 8000);
		// Labels are sent, then confirmed when the card shows them.
		await eventually(
			() => ["sent", "applied"].includes(status(client, "label")?.status ?? ""),
			8000,
		);
		expect(
			gitlab
				.project(42)
				.issues.get(1)
				?.labels?.map((l) => l.name),
		).toEqual(["bug"]);
		expect(gitlab.notesOn(42, 1)).toEqual(["From the board"]);
	});

	it("refuses people who aren't among the host's writers, before writing anything", async () => {
		const { mf, gitlab } = start({ writers: ["ada"] });
		const { client, push } = await board(mf, "devvy");
		stageChange(
			client.doc,
			{ kind: "item.state", target: { key: `${GL_HOST}/acme/app#1` }, state: "closed" },
			{ name: "Devvy" },
			{ id: "close" },
		);
		await client.roundTrip();
		const result = await push(["close"]);
		expect(result.body).toMatchObject({ ok: false, reason: "no_write_access" });
		expect(gitlab.log.some((line) => line.startsWith("PUT"))).toBe(false);
	});
});
