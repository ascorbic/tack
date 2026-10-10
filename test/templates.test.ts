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
import { markStarted, nextStep, readPrepared } from "../src/shared/prepared.ts";
import { addRule, listRules, readRule, rulesMap } from "../src/shared/rules.ts";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
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
		expect(steps.map((step) => step.kind)).toEqual(["silent", "silent", "vote", "timer"]);
		const improve = [...shapes].find(([, shape]) => shape.title === "To improve")?.[0];
		expect(steps[2]).toMatchObject({
			kind: "vote",
			scope: improve,
			dots: 3,
			hidden: true,
			minutes: 3,
		});
		expect(steps[0]).toMatchObject({ minutes: 5 });
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
		expect(byKind.get("list")?.config).toMatchObject({ q: "repo:emdash-cms/emdash is:pr is:open" });
	});

	it("stacks shapes in the template's order, sections beneath what's in them", () => {
		const { shapes } = make("tack:planning");
		const sorted = [...shapes.values()].sort((a, b) => (a.z < b.z ? -1 : 1));
		const proposals = sorted.findIndex((shape) => shape.title === "Proposals");
		const prompt = sorted.findIndex((shape) => shape.text?.startsWith("One proposal per sticky"));
		expect(proposals).toBeLessThan(prompt);
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
