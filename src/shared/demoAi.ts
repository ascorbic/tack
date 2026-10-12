import * as v from "valibot";
import {
	AI_CONTEXT_CHARS,
	AI_ITEM_CHARS,
	AI_ITEMS_MAX,
	AI_PROMPT_MAX,
	type AiItem,
	type WidgetContext,
} from "./ai.ts";
import { GROUP_LIMIT } from "./stackNaming.ts";
import { NAMING_LIMITS } from "./stacks.ts";

// The public demo's real AI (tack.social/try): what the page sends to
// `POST /try/api/ai` on the docs site's Worker (src/demoAi/), and the limits
// both sides keep. A real board's server reads what the model may from the
// board's own document; the demo has no server holding its board, so the
// page sends the text itself, and only that: the items' text for a summary
// or decision, a stack's notes, and a widget's description with the board's
// repositories and sections. Never a prompt, a model or its settings: the
// Worker builds every prompt with the same code a real board's server uses
// (src/shared/ai.ts, src/shared/stackNaming.ts), and refuses anything else.

/** Where the endpoint is, under the demo's own base (`/try/`). */
export const DEMO_AI_PATH = "api/ai";
/** Bodies bigger than this aren't read. */
export const DEMO_AI_MAX_BODY = 64_000;
/** A section's title, and who wrote a sticky, as the model reads them. */
export const DEMO_SECTION_CHARS = 80;
export const DEMO_BY_CHARS = 40;
/** How much a widget request may say about the board. */
export const DEMO_WIDGET_LIMITS = { repos: 12, sections: 40, id: 100 } as const;

export type DemoAiTask = "name" | "group" | "summary" | "decision" | "widget";

/** A login, as GitHub allows them. */
const LOGIN = /^[a-z\d][a-z\d-]{0,38}$/i;
/** A repository, `owner/name` (or deeper, as GitLab groups are), with no `..`. */
const REPO = /^[a-z\d][\w.-]*(\/[a-z\d_][\w.-]*)+$/i;

const line = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));

const ItemSchema = v.strictObject({
	kind: v.picklist(["sticky", "text", "card", "decision", "action", "section"]),
	text: line(AI_ITEM_CHARS),
	section: v.optional(v.pipe(v.string(), v.maxLength(DEMO_SECTION_CHARS))),
	by: v.optional(v.pipe(v.string(), v.maxLength(DEMO_BY_CHARS))),
});

const ItemsSchema = v.pipe(
	v.array(ItemSchema),
	v.minLength(1),
	v.maxLength(AI_ITEMS_MAX),
	v.check(
		(items) => items.reduce((sum, item) => sum + item.text.length, 0) <= AI_CONTEXT_CHARS,
		"too much text",
	),
);

const PromptSchema = v.pipe(v.string(), v.trim(), v.maxLength(AI_PROMPT_MAX));

const NoteSchema = v.strictObject({
	id: v.pipe(v.string(), v.regex(/^n[1-9]\d{0,2}$/)),
	text: line(NAMING_LIMITS.chars),
});

const WidgetContextSchema = v.strictObject({
	host: v.pipe(v.string(), v.maxLength(100), v.regex(/^[a-z0-9.-]+(:\d+)?$/i)),
	repos: v.pipe(
		v.array(v.pipe(v.string(), v.maxLength(100), v.regex(REPO))),
		v.maxLength(DEMO_WIDGET_LIMITS.repos),
	),
	sections: v.pipe(
		v.array(
			v.strictObject({
				id: line(DEMO_WIDGET_LIMITS.id),
				title: v.pipe(v.string(), v.maxLength(DEMO_SECTION_CHARS)),
			}),
		),
		v.maxLength(DEMO_WIDGET_LIMITS.sections),
	),
	login: v.nullable(v.pipe(v.string(), v.regex(LOGIN))),
});

/** `POST /try/api/ai`'s body: one task, and only what that task reads. */
export const DemoAiRequestSchema = v.variant("task", [
	v.strictObject({
		task: v.literal("name"),
		texts: v.pipe(
			v.array(line(NAMING_LIMITS.chars)),
			v.minLength(1),
			v.maxLength(NAMING_LIMITS.stickies),
		),
	}),
	v.strictObject({
		task: v.literal("group"),
		notes: v.pipe(
			v.array(NoteSchema),
			v.minLength(2),
			v.maxLength(GROUP_LIMIT),
			v.check(
				(notes) => new Set(notes.map((note) => note.id)).size === notes.length,
				"repeated id",
			),
		),
	}),
	v.strictObject({ task: v.literal("summary"), items: ItemsSchema }),
	v.strictObject({
		task: v.literal("decision"),
		items: ItemsSchema,
		prompt: v.optional(PromptSchema),
	}),
	v.strictObject({
		task: v.literal("widget"),
		prompt: v.pipe(PromptSchema, v.minLength(1)),
		context: WidgetContextSchema,
	}),
]);
export type DemoAiRequest = v.InferOutput<typeof DemoAiRequestSchema>;

/** A widget request's board: what `WidgetContext` says but the date, which the Worker knows. */
export type DemoWidgetContext = Omit<WidgetContext, "today">;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Items as the endpoint takes them: each clipped as the model would read
 * it, the empty ones dropped, and no more than it reads in all.
 */
export function fitItems(items: readonly AiItem[]): AiItem[] {
	const out: AiItem[] = [];
	let used = 0;
	for (const item of items) {
		const text = clip(item.text.replace(/\s+/g, " ").trim(), AI_ITEM_CHARS);
		if (!text) continue;
		if (out.length >= AI_ITEMS_MAX || used + text.length > AI_CONTEXT_CHARS) break;
		used += text.length;
		out.push({
			kind: item.kind,
			text,
			...(item.section ? { section: clip(item.section, DEMO_SECTION_CHARS) } : {}),
			...(item.by ? { by: clip(item.by, DEMO_BY_CHARS) } : {}),
		});
	}
	return out;
}

/** A board's widget context as the endpoint takes it. */
export function fitWidgetContext(context: WidgetContext): DemoWidgetContext {
	return {
		host: context.host,
		repos: context.repos
			.filter((repo) => repo.length <= 100 && REPO.test(repo))
			.slice(0, DEMO_WIDGET_LIMITS.repos),
		sections: context.sections
			.filter((section) => section.id.length <= DEMO_WIDGET_LIMITS.id)
			.slice(0, DEMO_WIDGET_LIMITS.sections)
			.map((section) => ({ id: section.id, title: clip(section.title, DEMO_SECTION_CHARS) })),
		login: context.login && LOGIN.test(context.login) ? context.login : null,
	};
}
