// The setup page's checklist (#55): how each step of getting an instance
// ready stands, and webhooks' health in words.

import { describe, expect, it } from "vite-plus/test";
import type {
	AccessSettings,
	InstallationList,
	InstallationSummary,
	WebhookHealth,
} from "../src/shared/auth.ts";
import {
	configuredSteps,
	describeWebhooks,
	firstSteps,
	focusStep,
	generateSecret,
	isReady,
	type SetupStep,
} from "../src/client/auth/setupChecks.ts";
import { installationState } from "../src/client/auth/setupChecks.ts";
import { assessWebhooks, isLocalOrigin, webhookUrl } from "../src/server/github/webhookHealth.ts";

const NOW = Date.parse("2026-10-11T10:00:00Z");
const HOOK = "https://tack.example.com/webhooks/github";

const health = (over: Partial<WebhookHealth> = {}): WebhookHealth => ({
	state: "ok",
	url: HOOK,
	expected: HOOK,
	last: { event: "pull_request", at: "2026-10-11T09:57:00Z", status: 202, redelivery: false },
	failed: 0,
	...over,
});

const installation = (over: Partial<InstallationSummary> = {}): InstallationSummary => ({
	id: 1,
	account: "emdash-cms",
	accountType: "Organization",
	selection: "selected",
	suspended: false,
	writable: true,
	settingsUrl: null,
	repositories: [
		{ name: "emdash-cms/emdash", private: false },
		{ name: "emdash-cms/docs", private: false },
	],
	more: 0,
	...over,
});

const ready = <T>(value: T) => ({ status: "ready" as const, value });
const access = (over: Partial<AccessSettings> = {}): AccessSettings => ({
	admins: [{ id: 1, login: "matt", name: null, avatarUrl: "" }],
	users: [],
	orgs: [],
	...over,
});

function steps(
	webhooks: WebhookHealth,
	list: InstallationList,
	people: AccessSettings | null = access({ orgs: ["emdash-cms"] }),
) {
	return Object.fromEntries(
		configuredSteps(ready(webhooks), ready(list), people).map((step) => [step.id, step]),
	);
}

describe("the setup checklist", () => {
	it("starts at the secret, then the app", () => {
		expect(firstSteps("secret").map((step) => step.tone)).toEqual([
			"current",
			"todo",
			"todo",
			"todo",
			"todo",
		]);
		expect(firstSteps("app").map((step) => step.tone)).toEqual([
			"done",
			"current",
			"todo",
			"todo",
			"todo",
		]);
		expect(focusStep(firstSteps("app"))).toBe("app");
	});

	it("is all done when webhooks arrive, every repository is live and others can sign in", () => {
		const all = steps(health(), { installations: [installation()], notInstalled: [] });
		expect(Object.values(all).map((step) => step.tone)).toEqual([
			"done",
			"done",
			"done",
			"done",
			"done",
		]);
		expect(all.repositories?.detail).toBe("2 repositories, all live");
		expect(all.people?.detail).toBe("1 admin · 1 org");
		expect(focusStep(Object.values(all))).toBeNull();
	});

	it("points at what needs a look", () => {
		const broken = steps(health({ state: "failing", reason: "rejected", failed: 3 }), {
			installations: [
				installation(),
				installation({ id: 2, account: "pixelmill", writable: false }),
			],
		});
		expect(broken.webhooks).toMatchObject({ tone: "fail", detail: "Refused" });
		expect(broken.repositories).toMatchObject({ tone: "warn", detail: "1 account to check" });
		expect(focusStep(Object.values(broken))).toBe("webhooks");

		// An install from before Tack read discussions: it needs the new permission accepted.
		const older = steps(health(), {
			installations: [
				installation(),
				installation({ id: 3, account: "ascorbic", discussions: false }),
			],
		});
		expect(older.repositories).toMatchObject({ tone: "warn", detail: "1 account to check" });
		expect(
			installationState(installation({ id: 3, account: "ascorbic", discussions: false })),
		).toMatchObject({ tone: "warn", label: "Live · no Discussions" });

		const missing = steps(health(), {
			installations: [installation()],
			notInstalled: ["ascorbic/cirrus"],
		});
		expect(missing.repositories).toMatchObject({ tone: "warn", detail: "1 on boards without it" });

		const none = steps(health({ state: "waiting", last: null }), { installations: [] });
		expect(none.webhooks?.tone).toBe("waiting");
		expect(none.repositories).toMatchObject({ tone: "current", detail: "Not installed yet" });
		expect(focusStep(Object.values(none))).toBe("repositories");
	});

	it("counts account-wide installations by account", () => {
		const all = steps(health(), {
			installations: [installation({ selection: "all", more: 40 })],
		});
		expect(all.repositories?.detail).toBe("All of emdash-cms, all live");
	});

	it("nudges toward adding people while only admins can sign in", () => {
		const lonely = steps(health(), { installations: [installation()] }, access());
		expect(lonely.people).toMatchObject({ tone: "todo", detail: "Optional: only admins so far" });
	});

	it("waits while things are checked, and says when they couldn't be", () => {
		const loading = configuredSteps({ status: "loading" }, { status: "failed" }, access());
		expect(loading[2]).toMatchObject({ tone: "waiting", detail: "Checking…" });
		expect(loading[3]).toMatchObject({ tone: "warn", detail: "Couldn’t check" });
	});
});

describe("webhooks in words", () => {
	it("says when the latest arrived, and about recent failures", () => {
		expect(describeWebhooks(health({ failed: 2 }), NOW)).toMatchObject({
			tone: "ok",
			label: "Arriving",
		});
		expect(describeWebhooks(health({ failed: 2 }), NOW).detail).toMatch(
			/pull request, 3 min\. ago\).*2 recent ones didn’t/,
		);
	});

	it("explains each failure, and where the fix is", () => {
		const unreachable = describeWebhooks(health({ state: "failing", reason: "unreachable" }), NOW);
		expect(unreachable).toMatchObject({ tone: "fail", label: "Not arriving" });
		expect(unreachable.detail).toContain(HOOK);
		expect(describeWebhooks(health({ state: "failing", reason: "rejected" }), NOW)).toMatchObject({
			label: "Refused",
			settings: true,
		});
		expect(describeWebhooks(health({ state: "failing", reason: "error" }), NOW).fix).toContain(
			"webhook.failed",
		);
		const elsewhere = describeWebhooks(
			health({ state: "elsewhere", url: "https://old.example.com/webhooks/github" }),
			NOW,
		);
		expect(elsewhere).toMatchObject({ tone: "warn", settings: true });
		expect(elsewhere.detail).toContain("https://old.example.com/webhooks/github");
		expect(describeWebhooks(health({ state: "local" }), NOW).tone).toBe("off");
	});
});

describe("assessing webhooks", () => {
	const delivery = (status: number) => ({
		id: 1,
		guid: "g",
		delivered_at: "2026-10-11T09:00:00Z",
		redelivery: false,
		status_code: status,
		event: "issues",
	});

	it("knows where an instance takes them, and which can't be reached", () => {
		expect(webhookUrl("https://tack.example.com/")).toBe(HOOK);
		expect(isLocalOrigin("http://localhost:5173")).toBe(true);
		expect(isLocalOrigin("http://tack.localhost")).toBe(true);
		expect(isLocalOrigin("https://tack.example.com")).toBe(false);
	});

	it("matches the app's address loosely: case and a trailing slash don't matter", () => {
		const config = { url: "https://Tack.Example.com/webhooks/github/" };
		expect(assessWebhooks("https://tack.example.com", config, [delivery(202)]).state).toBe("ok");
	});

	it("reads the latest delivery's answer", () => {
		const config = { url: HOOK };
		expect(assessWebhooks("https://tack.example.com", config, [delivery(0)])).toMatchObject({
			state: "failing",
			reason: "unreachable",
			failed: 1,
		});
		expect(
			assessWebhooks("https://tack.example.com", config, [delivery(502), delivery(202)]),
		).toMatchObject({ state: "failing", reason: "error", failed: 1 });
		expect(assessWebhooks("https://tack.example.com", { url: null }, []).state).toBe("elsewhere");
		expect(assessWebhooks("https://tack.example.com", null, null).state).toBe("unknown");
	});
});

describe("a new secret", () => {
	it("is 32 random bytes, base64", () => {
		const secret = generateSecret();
		expect(atob(secret)).toHaveLength(32);
		expect(generateSecret()).not.toBe(secret);
		expect(generateSecret((bytes) => bytes.fill(255))).toBe(btoa("\xff".repeat(32)));
	});
});

describe("isReady", () => {
	const done = (id: SetupStep["id"]): SetupStep => ({ id, label: id, detail: "", tone: "done" });
	it("is ready once the app's installed and webhooks arrive, whoever else can use it", () => {
		const steps = [done("secret"), done("app"), done("webhooks"), done("repositories")];
		expect(isReady([...steps, { ...done("people"), tone: "todo" }])).toBe(true);
		expect(isReady([...steps.slice(0, 3), { ...done("repositories"), tone: "current" }])).toBe(
			false,
		);
		expect(
			isReady([
				done("secret"),
				done("app"),
				{ ...done("webhooks"), tone: "fail" },
				done("repositories"),
			]),
		).toBe(false);
	});
});
