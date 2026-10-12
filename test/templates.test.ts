import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { addActionItem } from "../src/shared/actionItems.ts";
import {
	BUILT_IN_TEMPLATES,
	builtInInfo,
	builtInTemplate,
} from "../src/shared/builtInTemplates.ts";
import { addDecision, castVote } from "../src/shared/decisions.ts";
import { dotVotesMap, startVote } from "../src/shared/dotvotes.ts";
import {
	markStarted,
	nextStep,
	readPrepared,
	readStep,
	stepLength,
	voteEndsAt,
} from "../src/shared/prepared.ts";
import { addRule, listRules, readRule, rulesMap } from "../src/shared/rules.ts";
import { type ShapeProps, addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import { addSection, readShapes } from "../src/shared/structure.ts";
import {
	TEMPLATE_ORIGIN,
	TEMPLATE_VERSION,
	type TemplateContent,
	cleanRepos,
	extractTemplate,
	fillTemplate,
	instantiateTemplate,
	readContent,
	summarise,
	usesRepos,
} from "../src/shared/templates.ts";
import { textSize } from "../src/shared/thumbnail.ts";
import { widgetQueries } from "../src/shared/widgetRegistry.ts";

const BY = { name: "Priya Shah", color: "#b4467a", login: "priya" };

function counter() {
	let n = 0;
	return () => `id${++n}`;
}

function make(id: string, repos: string[] = []) {
	const template = builtInTemplate(id);
	if (!template) throw new Error(`no template ${id}`);
	const doc = new Y.Doc();
	const result = instantiateTemplate(doc, template.content, { repos, by: BY, now: "NOW" });
	return { doc, result, shapes: readShapes(doc) };
}

describe("filling in repositories", () => {
	const content: TemplateContent = {
		version: TEMPLATE_VERSION,
		shapes: {
			list: {
				type: "widget",
				widget: "list",
				x: 0,
				y: 0,
				config: { host: "{{host}}", q: "{{repos}} is:open", title: "Open in {{repo}}" },
			},
			release: { type: "widget", widget: "release", x: 0, y: 0, config: { repo: "{{repo2}}" } },
			text: { type: "text", x: 0, y: 0, text: "Triage for {{repo}} and {{repo2}}" },
			card: { type: "card", x: 0, y: 0, ref: "github.com/{{repo}}#1" },
			inbox: {
				type: "section",
				x: 0,
				y: 0,
				inbox: { query: { kind: "search", host: "{{host}}", q: "{{repo2}} is:issue" } },
			},
		},
		rules: {
			r: {
				trigger: {
					kind: "matches",
					query: { kind: "search", host: "github.com", q: "repo:{{repo2}} label:bug" },
				},
				action: { kind: "section", section: "inbox" },
			},
			p: { trigger: { kind: "pull-links" }, action: { kind: "beside-linked" } },
		},
	};

	it("fills placeholders from the repositories given, first one first", () => {
		const filled = fillTemplate(content, [
			"github.com/emdash-cms/emdash",
			"github.com/acme/widgets",
		]);
		expect(filled.shapes.list?.config).toEqual({
			host: "github.com",
			q: "repo:emdash-cms/emdash repo:acme/widgets is:open",
			title: "Open in emdash-cms/emdash",
		});
		expect(filled.shapes.release?.config).toEqual({ repo: "acme/widgets" });
		expect(filled.shapes.text?.text).toBe("Triage for emdash-cms/emdash and acme/widgets");
		// Items' keys are left as they are.
		expect(filled.shapes.card?.ref).toBe("github.com/{{repo}}#1");
		expect(Object.keys(filled.rules ?? {})).toEqual(["r", "p"]);
	});

	it("empties settings without a repository, and drops the inboxes and rules left without a query", () => {
		const filled = fillTemplate(content, ["github.com/emdash-cms/emdash"]);
		expect(filled.shapes.release?.config).toEqual({ repo: "" });
		expect(filled.shapes.text?.text).toBe("Triage for emdash-cms/emdash and");
		expect(filled.shapes.inbox?.inbox).toBeUndefined();
		expect(Object.keys(filled.rules ?? {})).toEqual(["p"]);
		const none = fillTemplate(content, []);
		expect(none.shapes.list?.config).toMatchObject({ q: "" });
	});

	it("knows which templates ask for repositories", () => {
		expect(usesRepos(content)).toBe(true);
		expect(usesRepos(builtInTemplate("tack:retro")?.content as TemplateContent)).toBe(false);
		expect(usesRepos(builtInTemplate("tack:triage")?.content as TemplateContent)).toBe(true);
	});

	it("tidies the repositories given", () => {
		expect(
			cleanRepos(["github.com/A/B", "github.com/a/b", "nope", " github.com/c/d ", "fake.tack/x/y"]),
		).toEqual(["github.com/a/b", "github.com/c/d", "fake.tack/x/y"]);
	});
});

describe("making a board from a template", () => {
	it("writes every shape, rule and step with fresh ids, its references pointing at the copies", () => {
		const template = builtInTemplate("tack:triage");
		if (!template) throw new Error("no triage");
		const doc = new Y.Doc();
		const origins: unknown[] = [];
		doc.on("afterTransaction", (transaction: Y.Transaction) => origins.push(transaction.origin));
		const result = instantiateTemplate(doc, template.content, {
			repos: ["github.com/emdash-cms/emdash"],
			by: BY,
			now: "NOW",
			newId: counter(),
		});
		expect(origins).toEqual([TEMPLATE_ORIGIN]);
		expect(result.shapes).toBe(Object.keys(template.content.shapes).length);
		expect(result.rules).toBe(2);
		const shapes = readShapes(doc);
		for (const id of shapes.keys()) expect(id).toMatch(/^id\d+$/);

		const p0 = [...shapes].find(([, shape]) => shape.title === "P0 · Drop everything")?.[0];
		const rules = listRules(doc);
		const security = rules.find((rule) => rule.trigger.kind === "matches");
		expect(security).toMatchObject({
			action: { kind: "section", section: p0 },
			createdBy: { name: BY.name, login: "priya" },
			createdAt: "NOW",
			enabled: true,
			name: "Security issues go to P0",
		});
		expect(security?.trigger).toMatchObject({
			query: { q: "repo:emdash-cms/emdash is:issue is:open label:security", host: "github.com" },
		});

		// Prompts sit in their sections.
		const prompt = [...shapes.values()].find((shape) => shape.text?.startsWith("Broken for many"));
		expect(prompt?.parent).toBe(p0);

		// The inbox reads the repository, with a dismissals map that will merge.
		const incoming = [...shapesMap(doc).values()].find(
			(shape) => shape.get("title") === "Incoming",
		);
		expect(incoming?.get("inbox")).toMatchObject({
			query: { q: "repo:emdash-cms/emdash is:issue is:open no:label", host: "github.com" },
		});
		expect(incoming?.get("dismissed")).toBeInstanceOf(Y.Map);
	});

	it("leaves widgets unset and drops rules and inboxes when made without repositories", () => {
		const { doc, shapes } = make("tack:triage");
		expect(listRules(doc).map((rule) => rule.trigger.kind)).toEqual(["pull-links"]);
		const incoming = [...shapes.values()].find((shape) => shape.title === "Incoming");
		expect(incoming?.inbox).toBeUndefined();
		const stale = [...shapes.values()].find((shape) => shape.widget === "stale");
		expect(widgetQueries(stale ?? {})).toEqual({});
	});

	it("prepares facilitation to start, in order", () => {
		const { doc, shapes } = make("tack:retro");
		const steps = readPrepared(doc);
		expect(steps.map((step) => step.kind)).toEqual(["timer", "silent", "timer", "vote", "timer"]);
		const section = (title: string) => [...shapes].find(([, shape]) => shape.title === title)?.[0];
		// One round of silent writing covers all three columns, which are inside it.
		expect(steps[1]).toMatchObject({
			kind: "silent",
			section: section("Looking back"),
			minutes: 8,
		});
		for (const title of ["Went well", "To improve", "Ideas to try"]) {
			expect(shapes.get(section(title) ?? "")?.parent).toBe(section("Looking back"));
		}
		expect(steps[3]).toMatchObject({
			kind: "vote",
			scope: section("To improve"),
			dots: 3,
			hidden: true,
			minutes: 3,
		});
		expect(steps[0]).toMatchObject({ minutes: 5, label: "Check last time’s actions" });
		expect(nextStep(steps)?.id).toBe(steps[0]?.id);
		markStarted(doc, steps[0]?.id ?? "", BY, "LATER");
		const after = readPrepared(doc);
		expect(after[0]).toMatchObject({ startedAt: "LATER", startedBy: { name: BY.name } });
		expect(nextStep(after)?.id).toBe(steps[1]?.id);
	});

	it("points widgets at the repositories, and section-sourced widgets at their sections", () => {
		const { shapes } = make("tack:release", ["github.com/emdash-cms/emdash"]);
		const now = [...shapes].find(([, shape]) => shape.title === "Now · this release")?.[0];
		const byKind = new Map([...shapes.values()].map((shape) => [shape.widget, shape]));
		expect(byKind.get("milestone")?.config).toMatchObject({
			repo: "emdash-cms/emdash",
			host: "github.com",
		});
		expect(byKind.get("release")?.config).toMatchObject({ repo: "emdash-cms/emdash" });
		expect(byKind.get("dependencies")?.config).toMatchObject({ source: "section", section: now });
		expect(byKind.get("review")?.config).toMatchObject({
			scope: "repo",
			repo: "emdash-cms/emdash",
		});
		// Next is a grid of mini cards.
		expect([...shapes.values()].find((shape) => shape.title === "Next")?.display).toBe("mini");
	});

	it("stacks shapes in the template's order, sections beneath what's in them", () => {
		const { shapes } = make("tack:planning");
		const sorted = [...shapes.values()].sort((a, b) => (a.z < b.z ? -1 : 1));
		const ideas = sorted.findIndex((shape) => shape.title === "Ideas");
		const prompt = sorted.findIndex((shape) => shape.text?.startsWith("One idea per sticky"));
		expect(ideas).toBeLessThan(prompt);
	});

	it("never brings in a session's state", () => {
		const content: TemplateContent = {
			version: TEMPLATE_VERSION,
			shapes: {
				d: {
					type: "decision",
					x: 0,
					y: 0,
					z: "a0",
					title: "X",
					status: "decided",
					writeback: "c",
					ref: "k",
				},
				s: { type: "section", x: 0, y: 0, z: "a1", silent: { id: "x" }, dismissed: { a: 1 } },
				c: {
					type: "card",
					x: 0,
					y: 0,
					z: "a2",
					ref: "github.com/a/b#1",
					provenance: { via: "rule", source: "r" },
				},
				a: { type: "action", x: 0, y: 0, z: "a3", text: "Do", issue: "c", carried: { board: "b" } },
				bad: { type: "sticky", x: "nope", y: 0 },
			},
		};
		const doc = new Y.Doc();
		instantiateTemplate(doc, content, { by: BY, newId: counter() });
		const shapes = [...readShapes(doc).values()];
		expect(shapes).toHaveLength(4);
		const decision = shapes.find((shape) => shape.type === "decision");
		expect(decision).toMatchObject({ status: "proposed", title: "X" });
		expect(decision?.writeback).toBeUndefined();
		expect(decision?.ref).toBeUndefined();
		expect(shapes.find((shape) => shape.type === "section")?.silent).toBeUndefined();
		expect(shapes.find((shape) => shape.type === "card")?.provenance).toBeUndefined();
		const action = shapes.find((shape) => shape.type === "action");
		expect(action?.issue).toBeUndefined();
		expect(action?.carried).toBeUndefined();
		const map = [...shapesMap(doc).values()].find((shape) => shape.get("type") === "decision");
		expect(map?.get("votes")).toBeInstanceOf(Y.Map);
	});

	it("has built-ins that make sensible boards", () => {
		for (const template of BUILT_IN_TEMPLATES) {
			const doc = new Y.Doc();
			instantiateTemplate(doc, template.content, { repos: ["github.com/acme/widgets"], by: BY });
			const shapes = readShapes(doc);
			// Every parent is a section on the board, and every rule reads.
			for (const shape of shapes.values()) {
				if (shape.parent) expect(shapes.get(shape.parent)?.type).toBe("section");
			}
			for (const rule of rulesMap(doc).values()) expect(readRule(rule)).not.toBeNull();
			const info = builtInInfo(template);
			expect(info.thumbnail?.shapes.length).toBeGreaterThan(0);
			expect(info.id.startsWith("tack:")).toBe(true);
		}
		expect(BUILT_IN_TEMPLATES.filter((t) => t.featured).map((t) => t.id)).toEqual([
			"tack:planning",
		]);
		expect(builtInInfo(builtInTemplate("tack:retro") as never).collectsActions).toBe(true);
	});
});

describe("built-in templates on every forge", () => {
	/** Repositories to make each with: none, and one on each forge. */
	const CHOICES: { name: string; repos: string[]; discussions: boolean }[] = [
		{ name: "no repository", repos: [], discussions: true },
		{ name: "a GitHub repository", repos: ["github.com/emdash-cms/emdash"], discussions: true },
		{
			name: "two GitHub repositories",
			repos: ["github.com/ascorbic/unpic", "github.com/ascorbic/cirrus"],
			discussions: true,
		},
		{ name: "a GitLab project", repos: ["gitlab.com/ascorbic/cirrus"], discussions: false },
		{ name: "a Codeberg repository", repos: ["codeberg.org/ascorbic/unpic"], discussions: false },
		{ name: "a Tangled repository", repos: ["tangled.org/ascorbic.dev/tack"], discussions: false },
	];

	/** A shape's box on the board, roughly: text by its lines, a list by its stored size. */
	const boxOf = (shape: ShapeProps) => {
		const size =
			shape.type === "text"
				? textSize(shape as unknown as Record<string, unknown>)
				: { width: shape.w ?? 0, height: shape.h ?? 0 };
		// A section's title sits above its frame.
		const top = shape.type === "section" ? shape.y - 40 : shape.y;
		return { x: shape.x, y: top, right: shape.x + size.width, bottom: shape.y + size.height };
	};
	const overlap = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
		a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

	for (const template of BUILT_IN_TEMPLATES) {
		for (const choice of CHOICES) {
			if (template.repos && choice.repos.length < template.repos.min) continue;
			it(`${template.title}, with ${choice.name}`, () => {
				const doc = new Y.Doc();
				const result = instantiateTemplate(doc, template.content, {
					repos: choice.repos,
					by: BY,
					newId: counter(),
				});
				const shapes = readShapes(doc);
				const json = JSON.stringify(doc.toJSON());
				// Every placeholder filled, and nothing of the template's own left behind.
				expect(json).not.toMatch(/\{\{/);
				expect(json).not.toContain('"forge"');
				// Discussions only where the forge has them.
				if (!choice.discussions) expect(json).not.toContain("is:discussion");
				// Everything in a section is in one that's there; rules and steps read.
				for (const shape of shapes.values()) {
					if (shape.parent) expect(shapes.get(shape.parent)?.type).toBe("section");
				}
				expect(listRules(doc)).toHaveLength(rulesMap(doc).size);
				expect(readPrepared(doc)).toHaveLength(result.prepared);
				expect(result.prepared).toBeGreaterThan(0);
				// With repositories, every widget reads them.
				for (const shape of shapes.values()) {
					if (shape.type !== "widget" || choice.repos.length === 0) continue;
					const config = shape.config as Record<string, unknown>;
					if (typeof config.repo === "string") expect(config.repo).not.toBe("");
					if (typeof config.q === "string" && config.source !== "section") {
						expect(config.q).toMatch(/repo:/);
					}
				}

				// Laid out tidily: nothing on top of anything else, ...
				const top = [...shapes].filter(([, shape]) => !shape.parent && shape.type !== "connector");
				for (const [i, [a, first]] of top.entries()) {
					for (const [b, second] of top.slice(i + 1)) {
						expect(overlap(boxOf(first), boxOf(second)), `${a} and ${b}`).toBe(false);
					}
				}
				// ... and nothing below a list or mini cards, which grow downwards as they fill.
				for (const [id, list] of top) {
					if (list.type !== "section" || !list.display) continue;
					const column = boxOf(list);
					for (const [other, shape] of top) {
						const box = boxOf(shape);
						const below = box.y >= column.y && box.x < column.right && column.x < box.right;
						if (other !== id) expect(below, `${other} below ${id}`).toBe(false);
					}
				}
			});
		}
	}

	it("leaves out what needs Discussions on forges without them", () => {
		const lists = (shapes: Map<string, ShapeProps>) =>
			[...shapes.values()]
				.filter((shape) => shape.widget === "list")
				.map((shape) => (shape.config as { title?: string }).title);
		const github = make("tack:triage", ["github.com/emdash-cms/emdash"]);
		const gitlab = make("tack:triage", ["gitlab.com/ascorbic/cirrus"]);
		const questions = [...github.shapes.values()].find((shape) => shape.widget === "list");
		expect(questions?.config).toMatchObject({
			title: "Unanswered questions",
			q: "repo:emdash-cms/emdash is:discussion is:open is:unanswered",
		});
		expect(lists(gitlab.shapes)).toEqual([]);
		expect(gitlab.shapes.size).toBe(github.shapes.size - 1);
		const incoming = [...gitlab.shapes.values()].find((shape) => shape.title === "Incoming");
		expect(incoming?.inbox).toMatchObject({
			query: { host: "gitlab.com", q: "repo:ascorbic/cirrus is:issue is:open no:label" },
		});

		expect(lists(make("tack:planning", ["github.com/ascorbic/unpic"]).shapes)).toEqual([
			"Most wanted issues",
			"Top discussions",
		]);
		expect(lists(make("tack:planning", ["codeberg.org/ascorbic/unpic"]).shapes)).toEqual([
			"Most wanted issues",
		]);
		// Made without a repository, the host is GitHub's, so it stays, to set up.
		expect(lists(make("tack:planning").shapes)).toHaveLength(2);
	});

	it("leaves out the rules, steps and connectors about what it leaves out", () => {
		const content: TemplateContent = {
			version: TEMPLATE_VERSION,
			shapes: {
				ask: { type: "section", x: 0, y: 0, z: "a0", title: "Questions", forge: "discussions" },
				inner: { type: "section", x: 10, y: 10, z: "a1", title: "Inner", parent: "ask" },
				note: { type: "sticky", x: 20, y: 20, z: "a2", parent: "inner" },
				keep: { type: "sticky", x: 500, y: 0, z: "a3" },
				line: {
					type: "connector",
					x: 0,
					y: 0,
					z: "a4",
					from: { x: 0, y: 0, shape: "keep" },
					to: { x: 0, y: 0, shape: "note" },
				},
			},
			rules: {
				into: {
					trigger: { kind: "pull-links" },
					action: { kind: "section", section: "inner" },
				},
				answered: {
					trigger: { kind: "pull-links" },
					action: { kind: "beside-linked" },
					forge: "discussions",
				},
				pulls: { trigger: { kind: "pull-links" }, action: { kind: "beside-linked" } },
			},
			prepared: {
				silent: { kind: "silent", section: "ask", label: "", order: 0 },
				vote: { kind: "vote", scope: "inner", dots: 3, hidden: false, label: "", order: 1 },
				timer: { kind: "timer", minutes: 5, label: "", order: 2 },
			},
		};
		const gitlab = fillTemplate(content, ["gitlab.com/ascorbic/cirrus"]);
		expect(Object.keys(gitlab.shapes)).toEqual(["keep"]);
		expect(Object.keys(gitlab.rules ?? {})).toEqual(["pulls"]);
		expect(Object.keys(gitlab.prepared ?? {})).toEqual(["timer"]);
		const github = fillTemplate(content, ["github.com/ascorbic/cirrus"]);
		expect(Object.keys(github.shapes)).toEqual(["ask", "inner", "note", "keep", "line"]);
		expect(github.shapes.ask?.forge).toBeUndefined();
		expect(Object.keys(github.rules ?? {})).toEqual(["into", "answered", "pulls"]);
		expect(github.rules?.answered?.forge).toBeUndefined();
	});

	it("prepares a vote that stays open for days", () => {
		const { doc, shapes } = make("tack:roadmap");
		const [vote] = readPrepared(doc);
		const later = [...shapes].find(([, shape]) => shape.title === "Later · worth doing")?.[0];
		expect(vote).toMatchObject({ kind: "vote", scope: later, days: 3, dots: 3 });
		expect(vote && "minutes" in vote ? vote.minutes : undefined).toBeUndefined();
		expect(vote && stepLength(vote)).toBe("3 days");
		expect(vote && voteEndsAt(vote, Date.parse("2026-10-12T09:00:00Z"))).toBe(
			"2026-10-15T09:00:00.000Z",
		);
		expect(readStep("x", { kind: "vote", scope: null, dots: 3, days: 30 })).toMatchObject({
			days: 7,
		});
		expect(readStep("x", { kind: "vote", scope: null, dots: 3, days: -1 })).not.toHaveProperty(
			"days",
		);
	});

	it("sketches empty lists and mini cards with a few outlined, as they'll fill", () => {
		const roadmap = builtInInfo(builtInTemplate("tack:roadmap") as never).thumbnail;
		const rows = roadmap?.shapes.filter((shape) => shape[0] === "row") ?? [];
		expect(rows.length).toBeGreaterThanOrEqual(9);
		expect(rows.every((shape) => shape[5] === "outline")).toBe(true);
		const release = builtInInfo(builtInTemplate("tack:release") as never).thumbnail;
		expect(release?.shapes.some((shape) => shape[0] === "tile")).toBe(true);
	});
});

describe("saving a board as a template", () => {
	function board() {
		const doc = new Y.Doc();
		addSection(doc, { x: 0, y: 0, w: 600, h: 400 }, { id: "s", title: "To improve" });
		addShape(doc, "t", {
			type: "text",
			x: 20,
			y: 20,
			z: "a5",
			text: "What got in our way?",
			parent: "s",
		});
		addShape(doc, "n", { type: "sticky", x: 40, y: 80, z: "a6", text: "CI was slow", parent: "s" });
		addShape(doc, "w", {
			type: "widget",
			widget: "list",
			x: 700,
			y: 0,
			z: "a7",
			config: {
				host: "github.com",
				q: "repo:emdash-cms/emdash is:open -repo:acme/other",
				title: "",
			},
		});
		addShape(doc, "m", {
			type: "widget",
			widget: "milestone",
			x: 700,
			y: 500,
			z: "a8",
			config: { host: "github.com", repo: "emdash-cms/emdash", milestone: "v1" },
		});
		addShape(doc, "line", {
			type: "connector",
			x: 0,
			y: 0,
			z: "a9",
			from: { x: 0, y: 0, shape: "n" },
			to: { x: 0, y: 0, shape: "w" },
		});
		addDecision(doc, "d", { x: 0, y: 600, title: "Cache CI" });
		castVote(doc, "d", BY, "agree");
		addActionItem(doc, "a", { x: 0, y: 900, text: "Do it", owner: { login: "priya" } });
		addRule(
			doc,
			{
				kind: "matches",
				query: { kind: "search", host: "github.com", q: "repo:emdash-cms/emdash label:bug" },
			},
			{ kind: "section", section: "s" },
			BY,
		);
		startVote(doc, { scope: "s", dots: 4, hidden: true, by: BY });
		return doc;
	}

	it("keeps the board's structure, and its repositories as placeholders", () => {
		const { content, repos } = extractTemplate(board());
		expect(Object.keys(content.shapes).sort()).toEqual(["m", "s", "t", "w"]);
		expect(content.shapes.w?.config).toMatchObject({
			q: "repo:{{repo}} is:open -repo:{{repo2}}",
		});
		expect(content.shapes.m?.config).toMatchObject({ repo: "{{repo}}", milestone: "v1" });
		expect(repos).toEqual({
			min: 0,
			max: 2,
			defaults: ["github.com/emdash-cms/emdash", "github.com/acme/other"],
		});
		const [rule] = Object.values(content.rules ?? {});
		expect(rule?.trigger).toMatchObject({ query: { q: "repo:{{repo}} label:bug" } });
		// The dot vote is ready to start again.
		expect(Object.values(content.prepared ?? {})).toEqual([
			{ kind: "vote", scope: "s", dots: 4, hidden: true, label: "", order: 0 },
		]);
		expect(readContent(JSON.parse(JSON.stringify(content)))).toEqual(content);
	});

	it("keeps everything with keepContent, but no session's state", () => {
		const { content } = extractTemplate(board(), { keepContent: true });
		expect(Object.keys(content.shapes).sort()).toEqual(["a", "d", "line", "m", "n", "s", "t", "w"]);
		expect(content.shapes.d?.votes).toBeUndefined();
		expect(content.shapes.a).toMatchObject({ text: "Do it", owner: { login: "priya" } });
	});

	it("round-trips: a board made from a saved template reads its repositories again", () => {
		const { content, repos } = extractTemplate(board());
		const doc = new Y.Doc();
		instantiateTemplate(doc, content, { repos: repos?.defaults, by: BY });
		const list = [...readShapes(doc).values()].find((shape) => shape.widget === "list");
		expect(list?.config).toMatchObject({ q: "repo:emdash-cms/emdash is:open -repo:acme/other" });
		expect(dotVotesMap(doc).size).toBe(0);
		expect(readPrepared(doc)).toHaveLength(1);
		const summary = summarise(content);
		expect(summary).toMatchObject({ sections: 1, widgets: 2, rules: 1, prepared: 1 });
		expect(summary.sectionTitles).toEqual(["To improve"]);
	});

	it("rejects content that isn't a template", () => {
		expect(readContent(null)).toBeNull();
		expect(readContent({ version: 2, shapes: {} })).toBeNull();
		expect(readContent({ version: 1, shapes: [] })).toBeNull();
		expect(readContent({ version: 1, shapes: { a: { type: "sticky" }, b: 3 } })?.shapes).toEqual({
			a: { type: "sticky" },
		});
	});

	it("skips steps whose section is gone", () => {
		const doc = board();
		const { content } = extractTemplate(doc);
		const made = new Y.Doc();
		instantiateTemplate(made, content, { by: BY });
		const section = [...shapesMap(made)].find(([, shape]) => shape.get("type") === "section")?.[0];
		shapesMap(made).delete(section as string);
		expect(readPrepared(made)).toHaveLength(0);
		expect(readShape).toBeDefined();
	});
});
