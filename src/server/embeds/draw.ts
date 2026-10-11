// Drawing a board image (#57): a `Scene` (src/shared/embed.ts) as the
// element tree Satori lays out and turns into SVG. Pure, with no wasm, so
// it's unit-tested in Node; `render.ts` does the rest on the Worker.
//
// Everything is drawn at the image's own pixel size: board units times the
// scale. Text too small to read at that scale (zoomed well out) is drawn as
// soft bars instead, as the board itself does, which also keeps Satori from
// laying out thousands of glyphs nobody could read.

import type { EmbedTheme, Scene, SceneCard, SceneItem } from "../../shared/embed.ts";
import type { Rect } from "../../shared/geometry.ts";
import { type Palette, palette } from "./palette.ts";

type Style = Record<string, string | number>;
export interface El {
	type: string;
	props: { style?: Style; children?: Child | Child[]; [key: string]: unknown };
}
type Child = El | string;

/** Font families, as `render.ts` registers them. */
export const FONTS = {
	ui: "Geist, GeistExt",
	hand: "Shantell, Geist, GeistExt",
	display: "Bricolage, Geist, GeistExt",
} as const;

/** Below this many pixels, text is drawn as bars. */
const LEGIBLE_PX = 4.5;

function h(type: string, style: Style, ...children: (Child | null | false | undefined)[]): El {
	const kept = children.filter((child): child is Child => Boolean(child) || child === "");
	return {
		type,
		props: {
			style,
			...(kept.length === 0 ? {} : { children: kept.length === 1 ? kept[0] : kept }),
		},
	};
}

/** A box: flex by default, as Satori needs for more than one child. */
function box(style: Style, ...children: (Child | null | false | undefined)[]): El {
	return h("div", { display: "flex", ...style }, ...children);
}

/** A run of text, clamped to `lines`. */
function text(style: Style, value: string, lines?: number): El {
	return h(
		"div",
		{
			display: "block",
			whiteSpace: "pre-wrap",
			overflow: "hidden",
			...(lines ? { lineClamp: lines } : {}),
			...style,
		},
		value,
	);
}

interface Ctx {
	p: Palette;
	frame: Rect;
	/** Pixels per board unit. */
	s: number;
	/** A length in board units, as pixels. */
	k: (n: number) => number;
}

export interface DrawOptions {
	theme: EmbedTheme;
	width: number;
	height: number;
	/** The board's title, for the badge in the corner (left out on small images). */
	badge?: string | null;
}

/** An image of a scene, `width` × `height` pixels. */
export function drawScene(scene: Scene, options: DrawOptions): El {
	const p = palette(options.theme);
	const s = options.width / scene.frame.w;
	const ctx: Ctx = { p, frame: scene.frame, s, k: (n) => round(n * s) };
	const children: Child[] = [dots(ctx, options.width, options.height)].filter(
		(child): child is El => child !== null,
	);
	children.push(...drawItems(scene, ctx, options.width, options.height));
	if (scene.empty) children.push(emptyNote(ctx, options.width, options.height, scene.missing));
	if (options.badge !== undefined && options.badge !== null && options.width >= 320) {
		children.push(badge(ctx, options.badge));
	}
	return box(
		{
			position: "relative",
			width: options.width,
			height: options.height,
			background: p.ground,
			overflow: "hidden",
			fontFamily: FONTS.ui,
		},
		...children,
	);
}

/** A link preview: the board behind its title, 1200 × 630. */
export function drawPreview(
	scene: Scene,
	options: { theme: EmbedTheme; width: number; height: number; title: string; subtitle: string },
): El {
	const p = palette(options.theme);
	const board = drawScene(scene, { ...options, badge: null });
	const fade = options.theme === "dark" ? "rgba(20,21,24," : "rgba(244,243,239,";
	const overlay = box(
		{
			position: "absolute",
			left: 0,
			right: 0,
			bottom: 0,
			height: 300,
			flexDirection: "column",
			justifyContent: "flex-end",
			padding: "0 64px 52px",
			backgroundImage: `linear-gradient(to top, ${fade}1) 0%, ${fade}0.94) 55%, ${fade}0) 100%)`,
		},
		box(
			{ alignItems: "center", marginBottom: 14 },
			mark(30),
			text(
				{ marginLeft: 12, fontSize: 24, fontWeight: 600, color: p.muted, fontFamily: FONTS.ui },
				"Tack",
				1,
			),
		),
		text(
			{
				fontSize: 64,
				lineHeight: 1.08,
				fontWeight: 700,
				color: p.ink,
				fontFamily: FONTS.display,
				letterSpacing: -1,
			},
			options.title,
			2,
		),
		text(
			{ marginTop: 14, fontSize: 26, color: p.muted, fontFamily: FONTS.ui, lineHeight: 1.3 },
			options.subtitle,
			1,
		),
	);
	const kids = board.props.children;
	const list = Array.isArray(kids) ? kids : kids === undefined ? [] : [kids];
	return { ...board, props: { ...board.props, children: [...list, overlay] } };
}

function drawItems(scene: Scene, ctx: Ctx, width: number, height: number): Child[] {
	const out: Child[] = [];
	const connectors = scene.items.filter(
		(item): item is Extract<SceneItem, { kind: "connector" }> => item.kind === "connector",
	);
	let drewLines = false;
	for (const item of scene.items) {
		if (item.kind === "connector") {
			// One layer for every line, above the sections and below everything else.
			if (!drewLines && connectors.length > 0) {
				out.push(lines(ctx, connectors, width, height));
				drewLines = true;
			}
			continue;
		}
		const drawn = drawItem(item, ctx);
		if (Array.isArray(drawn)) out.push(...drawn);
		else if (drawn) out.push(drawn);
	}
	for (const connector of connectors) {
		const label = connectorLabel(connector, ctx);
		if (label) out.push(label);
	}
	return out;
}

function drawItem(item: Exclude<SceneItem, { kind: "connector" }>, ctx: Ctx): El | El[] | null {
	switch (item.kind) {
		case "section":
			return section(item, ctx);
		case "sticky":
			return sticky(item, ctx);
		case "text":
			return textBlock(item, ctx);
		case "card":
			return card(item.rect, item.card, ctx);
		case "decision":
			return decision(item, ctx);
		case "action":
			return action(item, ctx);
		case "widget":
			return widget(item, ctx);
		case "row":
			return row(item, ctx);
	}
}

// --- Shapes ---------------------------------------------------------------------------

function place(rect: Rect, ctx: Ctx): Style {
	return {
		position: "absolute",
		left: ctx.k(rect.x - ctx.frame.x),
		top: ctx.k(rect.y - ctx.frame.y),
		width: Math.max(1, ctx.k(rect.w)),
		height: Math.max(1, ctx.k(rect.h)),
	};
}

function legible(size: number, ctx: Ctx): boolean {
	return size * ctx.s >= LEGIBLE_PX;
}

/** Text too small to read, as a few soft bars. */
function bars(ctx: Ctx, size: number, count: number, color: string, widthPct = 100): El {
	const thick = Math.max(1, ctx.k(size * 0.55));
	const gap = Math.max(1, ctx.k(size * 0.5));
	const rows: El[] = [];
	for (let i = 0; i < count; i++) {
		rows.push(
			box({
				height: thick,
				width: `${i === count - 1 && count > 1 ? widthPct * 0.6 : widthPct}%`,
				borderRadius: thick,
				background: color,
				marginBottom: i === count - 1 ? 0 : gap,
			}),
		);
	}
	return box({ flexDirection: "column", width: "100%" }, ...rows);
}

/**
 * A section: its frame, and its title in a pill just above it, which grows
 * as the board zooms out (up to ten times), as it does on the board.
 */
function section(item: Extract<SceneItem, { kind: "section" }>, ctx: Ctx): El[] {
	const { p, k } = ctx;
	const colors = p.section[item.color] ?? p.section.grey!;
	const frame = box({
		...place(item.rect, ctx),
		background: colors.fill,
		border: `${Math.max(1, k(1.5))}px solid ${colors.edge}`,
		borderRadius: k(14),
	});
	if (!item.title) return [frame];
	const grow = Math.min(10, Math.max(1, 1 / ctx.s));
	const size = 13 * grow;
	const height = 26 * grow;
	const top = item.rect.y - 6 * grow - height;
	const width = Math.min(
		item.rect.w,
		(item.title.length * 7.4 + 18 + (item.silent ? 96 : 0)) * grow,
	);
	const pill = {
		position: "absolute",
		left: k(item.rect.x - ctx.frame.x),
		top: k(top - ctx.frame.y),
		height: Math.max(1, k(height)),
		maxWidth: Math.max(1, k(item.rect.w)),
		alignItems: "center",
		background: colors.title,
		borderRadius: k(9 * grow),
	} as const;
	if (!legible(size, ctx)) return [frame, box({ ...pill, width: Math.max(1, k(width)) })];
	return [
		frame,
		box(
			{ ...pill, padding: `0 ${k(10 * grow)}px` },
			text(
				{
					fontSize: k(size),
					lineHeight: 1.2,
					fontWeight: 600,
					color: colors.ink,
					whiteSpace: "nowrap",
					textOverflow: "ellipsis",
					flexShrink: 1,
				},
				item.title,
				1,
			),
			item.silent &&
				text(
					{
						marginLeft: k(6 * grow),
						fontSize: k(size * 0.85),
						color: colors.ink,
						opacity: 0.75,
						whiteSpace: "nowrap",
						flexShrink: 0,
					},
					"· silent writing",
				),
		),
	];
}

function sticky(item: Extract<SceneItem, { kind: "sticky" }>, ctx: Ctx): El {
	const { p, k } = ctx;
	const pad = 16;
	const inner = { w: item.rect.w - pad * 2, h: item.rect.h - pad * 2 };
	let content: El | null = null;
	if (item.text === null) {
		// Face down: written in silent mode and not revealed yet.
		const size = 13;
		content = legible(size, ctx)
			? box(
					{ flexGrow: 1, alignItems: "center", justifyContent: "center" },
					text(
						{ fontSize: k(size), color: p.stickyInkSoft, textAlign: "center", lineHeight: 1.3 },
						"Hidden until the reveal",
						2,
					),
				)
			: null;
	} else if (item.text) {
		const size = stickyFontSize(item.text, inner);
		const lineHeight = 1.3;
		const lines = Math.max(1, Math.floor(inner.h / (size * lineHeight)));
		content = legible(size, ctx)
			? text(
					{
						fontSize: k(size),
						lineHeight,
						color: p.stickyInk,
						fontFamily: item.font === "hand" ? FONTS.hand : FONTS.ui,
						width: "100%",
					},
					item.text,
					lines,
				)
			: bars(ctx, size, Math.min(lines, Math.ceil(item.text.length / 18)), p.stickyInkSoft);
	}
	const faceDown = item.text === null;
	return box(
		{
			...place(item.rect, ctx),
			flexDirection: "column",
			padding: k(pad),
			background: p.sticky[item.color] ?? p.sticky.yellow!,
			borderRadius: k(4),
			boxShadow: `0 ${k(1)}px ${k(2)}px rgba(0,0,0,0.08), 0 ${k(10)}px ${k(16)}px -${k(10)}px rgba(0,0,0,0.25)`,
			...(faceDown
				? {
						backgroundImage: `repeating-linear-gradient(135deg, rgba(0,0,0,0.05) 0px, rgba(0,0,0,0.05) ${k(6)}px, rgba(0,0,0,0) ${k(6)}px, rgba(0,0,0,0) ${k(14)}px)`,
					}
				: {}),
		},
		content,
	);
}

/** A sticky's type size: as big as fits, like the board's fitting, within limits. */
export function stickyFontSize(value: string, inner: { w: number; h: number }): number {
	const chars = Math.max(1, value.length);
	const area = Math.max(1, inner.w * inner.h);
	// Words wrap, so lines aren't full: allow for that.
	const size = Math.sqrt((area * 0.62) / (chars * 0.55 * 1.3));
	return Math.round(Math.min(24, Math.max(12, size)));
}

function textBlock(item: Extract<SceneItem, { kind: "text" }>, ctx: Ctx): El | null {
	if (!item.text) return null;
	const { p, k } = ctx;
	const lines = Math.max(1, Math.round(item.rect.h / (item.size * 1.3)));
	return box(
		{ ...place(item.rect, ctx), height: "auto" },
		legible(item.size, ctx)
			? text(
					{
						fontSize: k(item.size),
						lineHeight: 1.3,
						fontWeight: item.size >= 34 ? 600 : 400,
						color: p.ink,
						fontFamily:
							item.font === "hand" ? FONTS.hand : item.size >= 34 ? FONTS.display : FONTS.ui,
						width: "100%",
					},
					item.text,
					lines + 1,
				)
			: bars(ctx, item.size, lines, p.lineStrong),
	);
}

function surface(rect: Rect, ctx: Ctx, extra: Style = {}): Style {
	const { p, k } = ctx;
	return {
		...place(rect, ctx),
		flexDirection: "column",
		background: p.surface,
		border: `${Math.max(1, k(1))}px solid ${p.line}`,
		borderRadius: k(10),
		padding: k(12),
		boxShadow: ctx.s > 0.3 ? p.shadow : "none",
		...extra,
	};
}

function card(rect: Rect, data: SceneCard, ctx: Ctx): El {
	const { p, k } = ctx;
	if (data.status === "private") {
		return box(
			surface(rect, ctx, {
				alignItems: "center",
				justifyContent: "center",
				background: p.surfaceMuted,
				border: `${Math.max(1, k(1.5))}px dashed ${p.lineStrong}`,
				boxShadow: "none",
			}),
			legible(13, ctx)
				? box(
						{ alignItems: "center" },
						lock(Math.max(4, k(14)), p.muted),
						text({ marginLeft: k(6), fontSize: k(13), color: p.muted }, "Private item", 1),
					)
				: null,
		);
	}
	if (data.status === "missing") {
		return box(
			surface(rect, ctx, { background: p.surfaceMuted, boxShadow: "none" }),
			legible(12, ctx)
				? text({ fontSize: k(12), color: p.muted, fontWeight: 600 }, data.ref, 1)
				: bars(ctx, 12, 1, p.line, 50),
			legible(13, ctx)
				? text({ marginTop: k(6), fontSize: k(13), color: p.muted }, "Couldn’t load this item", 2)
				: null,
		);
	}
	const state = p.state[data.state];
	if (!legible(14, ctx)) {
		return box(
			surface(rect, ctx, { borderLeft: `${Math.max(1, k(4))}px solid ${state.ink}` }),
			bars(ctx, 14, 3, p.lineStrong),
		);
	}
	const head = box(
		{ alignItems: "center", marginBottom: k(6) },
		stateGlyph(data, state.ink, k(12)),
		text(
			{ marginLeft: k(6), fontSize: k(12), fontWeight: 600, color: p.muted, whiteSpace: "nowrap" },
			data.ref,
			1,
		),
		data.checks &&
			box({
				marginLeft: k(6),
				width: k(8),
				height: k(8),
				borderRadius: k(4),
				background: p.checks[data.checks],
			}),
		box({ flexGrow: 1 }),
		text(
			{
				flexShrink: 0,
				fontSize: k(11),
				fontWeight: 600,
				color: state.ink,
				background: state.bg,
				borderRadius: k(6),
				padding: `${k(2)}px ${k(6)}px`,
				whiteSpace: "nowrap",
			},
			stateLabel(data),
		),
	);
	const labels =
		data.labels.length > 0 &&
		box(
			{ marginTop: "auto", flexWrap: "nowrap", overflow: "hidden" },
			...data.labels.map((label) => {
				const bg = `#${/^[0-9a-f]{6}$/i.test(label.color) ? label.color : "cccccc"}`;
				return text(
					{
						marginRight: k(4),
						fontSize: k(11),
						fontWeight: 600,
						color: inkOn(bg),
						background: bg,
						borderRadius: k(10),
						padding: `${k(1)}px ${k(7)}px`,
						whiteSpace: "nowrap",
						maxWidth: k(120),
						textOverflow: "ellipsis",
					},
					label.name,
				);
			}),
		);
	return box(
		surface(rect, ctx),
		head,
		text(
			{ fontSize: k(15), lineHeight: 1.3, fontWeight: 600, color: p.ink, width: "100%" },
			data.title,
			data.labels.length > 0 ? 2 : 3,
		),
		labels || null,
	);
}

function stateLabel(data: Extract<SceneCard, { status: "ok" }>): string {
	if (data.state === "merged") return "Merged";
	if (data.state === "draft") return "Draft";
	if (data.state === "closed") return "Closed";
	return "Open";
}

/** An issue's ring or a pull request's branch, in its state's colour. */
function stateGlyph(data: Extract<SceneCard, { status: "ok" }>, color: string, size: number): El {
	const children =
		data.kind === "pull"
			? [
					{
						type: "circle",
						props: { cx: 4, cy: 3.5, r: 1.8, fill: "none", stroke: color, strokeWidth: 1.4 },
					},
					{
						type: "circle",
						props: { cx: 4, cy: 12.5, r: 1.8, fill: "none", stroke: color, strokeWidth: 1.4 },
					},
					{
						type: "circle",
						props: { cx: 12, cy: 12.5, r: 1.8, fill: "none", stroke: color, strokeWidth: 1.4 },
					},
					{
						type: "path",
						props: {
							d: "M4 5.3v5.4M12 10.7V6.5a2 2 0 0 0-2-2H7.5",
							fill: "none",
							stroke: color,
							strokeWidth: 1.4,
						},
					},
				]
			: [
					{
						type: "circle",
						props: { cx: 8, cy: 8, r: 6.2, fill: "none", stroke: color, strokeWidth: 1.6 },
					},
					data.state === "open"
						? { type: "circle", props: { cx: 8, cy: 8, r: 1.6, fill: color } }
						: {
								type: "path",
								props: {
									d: "M5.4 8.2l1.8 1.8 3.4-3.6",
									fill: "none",
									stroke: color,
									strokeWidth: 1.6,
								},
							},
				];
	return { type: "svg", props: { width: size, height: size, viewBox: "0 0 16 16", children } };
}

function lock(size: number, color: string): El {
	return {
		type: "svg",
		props: {
			width: size,
			height: size,
			viewBox: "0 0 16 16",
			children: [
				{ type: "rect", props: { x: 3, y: 7, width: 10, height: 7, rx: 1.5, fill: color } },
				{
					type: "path",
					props: {
						d: "M5.5 7V5a2.5 2.5 0 0 1 5 0v2",
						fill: "none",
						stroke: color,
						strokeWidth: 1.6,
					},
				},
			],
		},
	};
}

function decision(item: Extract<SceneItem, { kind: "decision" }>, ctx: Ctx): El {
	const { p, k } = ctx;
	const tone =
		item.status === "decided"
			? p.state.open
			: item.status === "superseded"
				? p.state.closed
				: { ink: p.accent, bg: p.chip };
	if (!legible(15, ctx)) {
		return box(
			surface(item.rect, ctx, { borderTop: `${Math.max(1, k(4))}px solid ${tone.ink}` }),
			bars(ctx, 16, 4, p.lineStrong),
		);
	}
	return box(
		surface(item.rect, ctx, {
			borderTop: `${Math.max(1, k(4))}px solid ${tone.ink}`,
			padding: k(14),
		}),
		box(
			{ alignItems: "center", marginBottom: k(8) },
			text(
				{
					fontSize: k(11),
					fontWeight: 600,
					color: p.muted,
					letterSpacing: k(0.6),
					textTransform: "uppercase",
				},
				"Decision",
				1,
			),
			box({ flexGrow: 1 }),
			text(
				{
					fontSize: k(11),
					fontWeight: 600,
					color: tone.ink,
					background: tone.bg,
					borderRadius: k(6),
					padding: `${k(2)}px ${k(6)}px`,
				},
				item.status === "decided"
					? "Decided"
					: item.status === "superseded"
						? "Superseded"
						: "Proposed",
				1,
			),
		),
		text(
			{
				fontSize: k(17),
				lineHeight: 1.25,
				fontWeight: 600,
				color: item.status === "superseded" ? p.muted : p.ink,
				fontFamily: FONTS.display,
				width: "100%",
			},
			item.title || "Untitled decision",
			2,
		),
		item.text &&
			text(
				{ marginTop: k(8), fontSize: k(13), lineHeight: 1.4, color: p.inkSoft, width: "100%" },
				item.text,
				5,
			),
	);
}

function action(item: Extract<SceneItem, { kind: "action" }>, ctx: Ctx): El {
	const { p, k } = ctx;
	const check = box(
		{
			width: k(18),
			height: k(18),
			flexShrink: 0,
			borderRadius: k(5),
			border: `${Math.max(1, k(1.6))}px solid ${item.done ? p.accent : p.lineStrong}`,
			background: item.done ? p.accent : p.surface,
			alignItems: "center",
			justifyContent: "center",
		},
		item.done
			? {
					type: "svg",
					props: {
						width: k(12),
						height: k(12),
						viewBox: "0 0 16 16",
						children: [
							{
								type: "path",
								props: { d: "M3.5 8.5l3 3 6-7", fill: "none", stroke: p.surface, strokeWidth: 2.2 },
							},
						],
					},
				}
			: null,
	);
	if (!legible(14, ctx)) {
		return box(
			surface(item.rect, ctx, { flexDirection: "row" }),
			check,
			box({ marginLeft: k(10), flexGrow: 1 }, bars(ctx, 14, 2, p.lineStrong)),
		);
	}
	const foot = [item.owner ? `@${item.owner}` : null, item.due ? `Due ${dueLabel(item.due)}` : null]
		.filter(Boolean)
		.join(" · ");
	return box(
		surface(item.rect, ctx, { flexDirection: "row" }),
		check,
		box(
			{ marginLeft: k(10), flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 },
			text(
				{
					fontSize: k(14),
					lineHeight: 1.35,
					color: item.done ? p.muted : p.ink,
					textDecoration: item.done ? "line-through" : "none",
					width: "100%",
				},
				item.text || "Action item",
				2,
			),
			foot && text({ marginTop: "auto", fontSize: k(12), color: p.muted }, foot, 1),
		),
	);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dueLabel(due: string): string {
	const [, month, day] = due.split("-").map(Number);
	return `${MONTHS[(month ?? 1) - 1] ?? ""} ${day ?? ""}`.trim();
}

function widget(item: Extract<SceneItem, { kind: "widget" }>, ctx: Ctx): El {
	const { p, k } = ctx;
	const skeleton = box(
		{ flexDirection: "column", marginTop: k(14), flexGrow: 1 },
		...[0, 1, 2, 3, 4].map((i) =>
			box({
				height: k(30),
				marginBottom: k(8),
				borderRadius: k(6),
				background: p.chip,
				width: `${[100, 92, 96, 84, 70][i]}%`,
			}),
		),
	);
	return box(
		surface(item.rect, ctx, { borderRadius: k(12), padding: k(14) }),
		legible(15, ctx)
			? box(
					{ flexDirection: "column" },
					text(
						{
							fontSize: k(11),
							fontWeight: 600,
							color: p.muted,
							letterSpacing: k(0.6),
							textTransform: "uppercase",
						},
						item.label,
						1,
					),
					text({ marginTop: k(4), fontSize: k(16), fontWeight: 600, color: p.ink }, item.title, 1),
				)
			: bars(ctx, 16, 1, p.lineStrong, 60),
		skeleton,
		legible(12, ctx) && text({ fontSize: k(12), color: p.muted }, "Live on the board", 1),
	);
}

function row(item: Extract<SceneItem, { kind: "row" }>, ctx: Ctx): El {
	const { p, k } = ctx;
	if (item.face === "group") {
		const colors = p.section[item.tone] ?? p.section.grey!;
		return box(
			{ ...place(item.rect, ctx), alignItems: "center", paddingLeft: k(8) },
			box({ width: k(8), height: k(8), borderRadius: k(4), background: colors.edge }),
			legible(13, ctx) &&
				text(
					{
						marginLeft: k(8),
						fontSize: k(13),
						fontWeight: 700,
						color: colors.ink,
						fontFamily: FONTS.display,
					},
					item.text,
					1,
				),
		);
	}
	const tone =
		item.face === "card"
			? (p.state[item.tone as keyof Palette["state"]]?.ink ?? p.muted)
			: item.face === "sticky" || item.face === "hidden"
				? (p.sticky[item.tone] ?? p.sticky.yellow!)
				: p.lineStrong;
	const mini = item.mode === "mini";
	const label =
		item.face === "hidden"
			? "Hidden until the reveal"
			: item.face === "private"
				? "Private item"
				: item.text;
	const muted = item.face === "hidden" || item.face === "private";
	return box(
		{
			...place(item.rect, ctx),
			flexDirection: mini ? "column" : "row",
			alignItems: mini ? "flex-start" : "center",
			background: p.surface,
			border: `${Math.max(1, k(1))}px solid ${p.line}`,
			borderRadius: k(mini ? 8 : 6),
			padding: mini ? k(8) : `0 ${k(10)}px`,
			...(mini ? { borderTop: `${Math.max(1, k(3))}px solid ${tone}` } : {}),
		},
		!mini &&
			box({ width: k(8), height: k(8), flexShrink: 0, borderRadius: k(4), background: tone }),
		legible(12, ctx)
			? box(
					{
						flexDirection: mini ? "column" : "row",
						alignItems: mini ? "flex-start" : "center",
						marginLeft: mini ? 0 : k(8),
						minWidth: 0,
						flexShrink: 1,
					},
					item.ref &&
						text(
							{
								fontSize: k(11),
								fontWeight: 600,
								color: p.muted,
								whiteSpace: "nowrap",
								marginRight: mini ? 0 : k(6),
							},
							item.ref,
							1,
						),
					text(
						{
							fontSize: k(mini ? 12 : 13),
							lineHeight: 1.3,
							color: muted ? p.muted : p.ink,
							fontWeight: mini ? 600 : 400,
							...(mini ? {} : { whiteSpace: "nowrap", textOverflow: "ellipsis" }),
						},
						label,
						mini ? 3 : 1,
					),
				)
			: box(
					{ marginLeft: mini ? 0 : k(8), flexGrow: 1 },
					bars(ctx, 12, mini ? 2 : 1, p.lineStrong),
				),
	);
}

// --- Lines ----------------------------------------------------------------------------

function lines(
	ctx: Ctx,
	connectors: Extract<SceneItem, { kind: "connector" }>[],
	width: number,
	height: number,
): El {
	const { frame, p } = ctx;
	const children: El[] = [];
	for (const connector of connectors) {
		const color = p.connector[connector.color] ?? p.connector.ink!;
		children.push({
			type: "path",
			props: {
				d: connector.d,
				fill: "none",
				stroke: color,
				strokeWidth: connector.width,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				...(connector.dash ? { strokeDasharray: "7 6" } : {}),
			},
		});
		for (const head of connector.heads) {
			children.push({
				type: "path",
				props: { d: head, fill: color, stroke: color, strokeWidth: 1, strokeLinejoin: "round" },
			});
		}
	}
	return {
		type: "svg",
		props: {
			width,
			height,
			viewBox: `${round(frame.x)} ${round(frame.y)} ${round(frame.w)} ${round(frame.h)}`,
			style: { position: "absolute", left: 0, top: 0 },
			children,
		},
	};
}

function connectorLabel(connector: Extract<SceneItem, { kind: "connector" }>, ctx: Ctx): El | null {
	if (!connector.label || !connector.labelAt || !legible(12, ctx)) return null;
	const { p, k, frame } = ctx;
	const width = Math.min(240, connector.label.length * 7 + 20);
	const color = p.connector[connector.color] ?? p.connector.ink!;
	return box(
		{
			position: "absolute",
			left: k(connector.labelAt.x - frame.x - width / 2),
			top: k(connector.labelAt.y - frame.y - 12),
			width: k(width),
			height: k(24),
			alignItems: "center",
			justifyContent: "center",
			background: p.surface,
			border: `${Math.max(1, k(1))}px solid ${p.line}`,
			borderRadius: k(12),
		},
		text(
			{ fontSize: k(12), fontWeight: 600, color, whiteSpace: "nowrap", textOverflow: "ellipsis" },
			connector.label,
			1,
		),
	);
}

// --- Chrome ---------------------------------------------------------------------------

/** The board's dotted ground, scaled with it; left out when the dots would be a blur. */
function dots(ctx: Ctx, width: number, height: number): El | null {
	const step = 24 * ctx.s;
	if (step < 7) return null;
	// Dots sit on the board's own 24-unit grid, wherever the frame starts.
	const offsetX = round(mod(-ctx.frame.x, 24) * ctx.s);
	const offsetY = round(mod(-ctx.frame.y, 24) * ctx.s);
	const r = Math.max(0.7, Math.min(1.5, 1.2 * ctx.s));
	return {
		type: "svg",
		props: {
			width,
			height,
			viewBox: `0 0 ${width} ${height}`,
			style: { position: "absolute", left: 0, top: 0 },
			children: [
				{
					type: "defs",
					props: {
						children: {
							type: "pattern",
							props: {
								id: "dots",
								x: offsetX,
								y: offsetY,
								width: round(step),
								height: round(step),
								patternUnits: "userSpaceOnUse",
								children: { type: "circle", props: { cx: r, cy: r, r, fill: ctx.p.dots } },
							},
						},
					},
				},
				{ type: "rect", props: { x: 0, y: 0, width, height, fill: "url(#dots)" } },
			],
		},
	};
}

function mod(n: number, m: number): number {
	return ((n % m) + m) % m;
}

/** The Tack mark: a sticky note, pinned. */
function mark(size: number): El {
	return {
		type: "svg",
		props: {
			width: size,
			height: size,
			viewBox: "0 0 24 24",
			children: [
				{ type: "path", props: { d: "M4.5 6.5h15v12.2l-3.3 3.3H4.5z", fill: "#ffd85c" } },
				{ type: "path", props: { d: "M16.2 22v-3.3h3.3z", fill: "#e8b93a" } },
				{
					type: "ellipse",
					props: { cx: 12.6, cy: 9.4, rx: 3.1, ry: 1.3, fill: "rgba(0,0,0,0.18)" },
				},
				{ type: "circle", props: { cx: 12, cy: 7, r: 3.4, fill: "#e5533d" } },
				{ type: "circle", props: { cx: 10.9, cy: 5.9, r: 1.1, fill: "rgba(255,255,255,0.55)" } },
			],
		},
	};
}

/** Where the image is from: the board's title and Tack's mark, small, in the corner. */
function badge(ctx: Ctx, title: string): El {
	const { p } = ctx;
	return box(
		{
			position: "absolute",
			right: 10,
			bottom: 10,
			alignItems: "center",
			background: p.badge.bg,
			border: `1px solid ${p.badge.edge}`,
			borderRadius: 999,
			padding: "4px 10px 4px 6px",
		},
		mark(16),
		text(
			{
				marginLeft: 5,
				fontSize: 12,
				fontWeight: 600,
				color: p.badge.ink,
				maxWidth: 260,
				whiteSpace: "nowrap",
				textOverflow: "ellipsis",
			},
			title ? `${title} · Tack` : "Tack",
			1,
		),
	);
}

function emptyNote(ctx: Ctx, width: number, height: number, missing: boolean): El {
	const { p } = ctx;
	return box(
		{
			position: "absolute",
			left: 0,
			top: 0,
			width,
			height,
			alignItems: "center",
			justifyContent: "center",
			flexDirection: "column",
		},
		mark(40),
		text(
			{ marginTop: 12, fontSize: 18, fontWeight: 600, color: p.inkSoft, fontFamily: FONTS.display },
			missing ? "This part of the board isn’t there any more" : "Nothing here yet",
			1,
		),
	);
}

/** Black or white, whichever reads on a label's colour. */
function inkOn(hex: string): string {
	const n = Number.parseInt(hex.slice(1), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
		const v = c / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
	return luminance > 0.4 ? "#17191c" : "#ffffff";
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}
