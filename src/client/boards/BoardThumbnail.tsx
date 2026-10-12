import { memo } from "react";
import type { Thumbnail, ThumbnailShape } from "../../shared/boards.ts";

/** Room around the sketch, as a share of its largest side. */
const PADDING = 0.09;

const CARD_STATE: Record<string, string> = {
	open: "var(--open)",
	merged: "var(--merged)",
	closed: "var(--closed)",
	draft: "var(--muted)",
};

/**
 * A board in miniature: its shapes as simple rectangles in their own
 * colours, drawn from the compact sketch the board keeps on save. Uses the
 * theme's tokens, so it follows light and dark like the board itself.
 */
export const BoardThumbnail = memo(function BoardThumbnail({
	thumbnail,
	animate = false,
	seed,
}: {
	thumbnail: Thumbnail | null;
	/** Lay the sketch out shape by shape, frames first (template previews). */
	animate?: boolean;
	/** Vary an empty board's note by this (its id). */
	seed?: string;
}) {
	if (!thumbnail || thumbnail.shapes.length === 0) return <EmptyThumbnail seed={seed} />;
	const pad = Math.max(thumbnail.width, thumbnail.height) * PADDING;
	return (
		<svg
			className="board-thumb-sketch"
			data-animate={animate || undefined}
			viewBox={`${-pad} ${-pad} ${thumbnail.width + pad * 2} ${thumbnail.height + pad * 2}`}
			preserveAspectRatio="xMidYMid meet"
			aria-hidden="true"
		>
			{thumbnail.shapes.map((shape, i) => (
				<g
					key={i}
					className="thumb-shape"
					style={
						animate
							? ({
									"--i": Math.min(i, 24),
									transformOrigin: `${shape[1] + shape[3] / 2}px ${shape[2] + shape[4] / 2}px`,
								} as React.CSSProperties)
							: undefined
					}
				>
					<Shape shape={shape} />
				</g>
			))}
		</svg>
	);
});

function Shape({ shape }: { shape: ThumbnailShape }) {
	const [kind, x, y, width, height, tone] = shape;
	const r = Math.min(width, height) * 0.06;
	switch (kind) {
		case "frame":
			// Sections, tinted like the real thing.
			return (
				<rect
					className="thumb-frame"
					x={x}
					y={y}
					width={width}
					height={height}
					rx={Math.min(width, height) * 0.03}
					style={{
						fill: `var(--section-${tone || "grey"}-fill, var(--section-grey-fill))`,
						stroke: `var(--section-${tone || "grey"}-edge, var(--section-grey-edge))`,
					}}
				/>
			);
		case "sticky":
			return (
				<rect
					className="thumb-sticky"
					x={x}
					y={y}
					width={width}
					height={height}
					rx={r * 0.5}
					style={{ fill: `var(--sticky-${tone || "yellow"}, var(--sticky-yellow))` }}
				/>
			);
		case "stack": {
			// A stack: a theme card, its name in bold and a few excerpts, on two
			// papers in its top sticky's colour peeking out behind.
			const step = Math.max(1, width * 0.035);
			const fill = { fill: `var(--sticky-${tone || "yellow"}, var(--sticky-yellow))` };
			const w = width - step * 2;
			const h = height - step * 2;
			const line = Math.max(1, h * 0.07);
			const rows = Math.max(1, Math.min(4, Math.floor((h * 0.62) / (line * 2.2))));
			return (
				<g className="thumb-stack">
					{[2, 1].map((n) => (
						<rect
							key={n}
							className="thumb-stack-under"
							x={x + step * n}
							y={y + step * n}
							width={w}
							height={h}
							rx={r}
							style={fill}
						/>
					))}
					<rect className="thumb-card" x={x} y={y} width={w} height={h} rx={r} />
					<rect
						className="thumb-stack-name"
						x={x + w * 0.09}
						y={y + h * 0.12}
						width={w * 0.62}
						height={line * 1.5}
						rx={line * 0.75}
					/>
					{Array.from({ length: rows }, (_, i) => (
						<g key={i}>
							<circle
								cx={x + w * 0.09 + line * 0.5}
								cy={y + h * 0.36 + i * line * 2.2 + line / 2}
								r={line * 0.5}
								style={fill}
								className="thumb-stack-dot"
							/>
							<rect
								className="thumb-line"
								x={x + w * 0.09 + line * 1.6}
								y={y + h * 0.36 + i * line * 2.2}
								width={w * (0.66 - (i % 2) * 0.16)}
								height={line}
								rx={line / 2}
							/>
						</g>
					))}
				</g>
			);
		}
		case "card": {
			const line = height * 0.11;
			return (
				<g>
					<rect className="thumb-card" x={x} y={y} width={width} height={height} rx={r} />
					<rect
						x={x + width * 0.08}
						y={y + height * 0.16}
						width={width * 0.18}
						height={line}
						rx={line / 2}
						style={{ fill: CARD_STATE[tone] ?? "var(--line-strong)" }}
					/>
					<rect
						className="thumb-line"
						x={x + width * 0.08}
						y={y + height * 0.42}
						width={width * 0.78}
						height={line}
						rx={line / 2}
					/>
					<rect
						className="thumb-line"
						x={x + width * 0.08}
						y={y + height * 0.64}
						width={width * 0.52}
						height={line}
						rx={line / 2}
					/>
				</g>
			);
		}
		case "link": {
			// A link card: its site's tint where the picture is, the site's
			// tile on it, then its title. Neutral for a page that couldn't be read.
			const band = height * 0.43;
			const rr = Math.min(r, band / 2);
			const line = Math.max(1, (height - band) * 0.1);
			const tile = Math.min(band * 0.5, width * 0.16);
			const hue = Number(tone);
			return (
				<g
					className="thumb-link"
					data-unread={tone === "" || undefined}
					style={
						tone !== "" && Number.isFinite(hue)
							? ({ "--thumb-link-hue": hue } as React.CSSProperties)
							: undefined
					}
				>
					<rect className="thumb-card" x={x} y={y} width={width} height={height} rx={r} />
					<path
						className="thumb-link-band"
						d={`M${x} ${y + band}V${y + rr}a${rr} ${rr} 0 0 1 ${rr} ${-rr}h${width - rr * 2}a${rr} ${rr} 0 0 1 ${rr} ${rr}V${y + band}z`}
					/>
					<rect
						className="thumb-link-tile"
						x={x + width / 2 - tile / 2}
						y={y + band / 2 - tile / 2}
						width={tile}
						height={tile}
						rx={tile * 0.26}
					/>
					<rect
						className="thumb-line"
						x={x + width * 0.08}
						y={y + band + (height - band) * 0.22}
						width={width * 0.78}
						height={line}
						rx={line / 2}
					/>
					<rect
						className="thumb-line"
						x={x + width * 0.08}
						y={y + band + (height - band) * 0.44}
						width={width * 0.52}
						height={line}
						rx={line / 2}
					/>
				</g>
			);
		}
		case "text": {
			const lines = Math.max(1, Math.min(6, Number(tone) || 1));
			const gap = height / lines;
			return (
				<g className="thumb-text">
					{Array.from({ length: lines }, (_, i) => (
						<rect
							key={i}
							x={x}
							y={y + i * gap + gap * 0.22}
							width={i === lines - 1 && lines > 1 ? width * 0.6 : width}
							height={gap * 0.56}
							rx={gap * 0.28}
						/>
					))}
				</g>
			);
		}
		case "widget": {
			// A panel: a header bar, then rows (or a line, for a timeline).
			const head = Math.min(height * 0.16, width * 0.12);
			const inset = Math.min(width, height) * 0.07;
			const rows =
				tone === "timeline" ? 0 : Math.max(2, Math.min(7, Math.floor(height / (head * 1.4)) - 1));
			return (
				<g>
					<rect
						className="thumb-card thumb-widget"
						x={x}
						y={y}
						width={width}
						height={height}
						rx={r}
					/>
					<rect
						className="thumb-widget-head"
						x={x + inset}
						y={y + inset}
						width={width * 0.42}
						height={head * 0.5}
						rx={head * 0.25}
					/>
					{tone === "timeline" ? (
						<rect
							className="thumb-line"
							x={x + inset}
							y={y + height * 0.62}
							width={width - inset * 2}
							height={Math.max(2, head * 0.18)}
							rx={head * 0.09}
						/>
					) : (
						Array.from({ length: rows }, (_, i) => (
							<rect
								key={i}
								className="thumb-line"
								x={x + inset}
								y={y + inset * 2 + head * (0.9 + i * 1.3)}
								width={(width - inset * 2) * (i % 3 === 2 ? 0.6 : 0.9)}
								height={head * 0.34}
								rx={head * 0.17}
							/>
						))
					)}
				</g>
			);
		}
		case "image": {
			// A picture's place, not the picture: a muted block with a faint
			// landscape, as the sketch never holds a board's files.
			const side = Math.min(width, height);
			const glyph = side * 0.42;
			const gx = x + (width - glyph) / 2;
			const gy = y + (height - glyph * 0.8) / 2;
			return (
				<g>
					<rect
						className="thumb-card"
						x={x}
						y={y}
						width={width}
						height={height}
						rx={r}
						style={{ fill: "var(--surface-muted)" }}
					/>
					<path
						d={`M${gx} ${gy + glyph * 0.8}l${glyph * 0.36} ${-glyph * 0.42} ${glyph * 0.26} ${glyph * 0.24} ${glyph * 0.16} ${-glyph * 0.14} ${glyph * 0.22} ${glyph * 0.32}z`}
						style={{ fill: "var(--line-strong)" }}
					/>
					<circle
						cx={gx + glyph * 0.24}
						cy={gy + glyph * 0.16}
						r={glyph * 0.1}
						style={{ fill: "var(--line-strong)" }}
					/>
				</g>
			);
		}
		case "action": {
			// A row with a checkbox.
			const box = height * 0.28;
			return (
				<g>
					<rect className="thumb-card" x={x} y={y} width={width} height={height} rx={r * 1.4} />
					<circle
						className="thumb-check"
						data-done={tone === "done" || undefined}
						cx={x + box * 1.1}
						cy={y + box * 1.1}
						r={box / 2}
					/>
					<rect
						className="thumb-line"
						x={x + box * 2}
						y={y + box * 0.85}
						width={width * 0.6}
						height={box * 0.5}
						rx={box * 0.25}
					/>
				</g>
			);
		}
		default:
			return null;
	}
}

/** A board with nothing on it yet: just a tack, waiting. */
const EMPTY_COLORS = ["yellow", "pink", "blue", "green", "purple"];

/**
 * A blank note pinned up, for a board with nothing on it yet. Given a
 * seed (the board's id), each board's note has its own colour and tilt,
 * so a row of fresh boards doesn't look like one board repeated.
 */
export function emptyNoteStyle(seed: string | undefined): { color: string; tilt: number } {
	if (!seed) return { color: "", tilt: 0 };
	let hash = 2166136261;
	for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	const value = hash >>> 0;
	return {
		color: EMPTY_COLORS[value % EMPTY_COLORS.length] ?? "yellow",
		tilt: ((value >>> 8) % 13) - 6,
	};
}

function EmptyThumbnail({ seed }: { seed?: string }) {
	const { color, tilt } = emptyNoteStyle(seed);
	return (
		<svg
			className="board-thumb-empty"
			viewBox="0 0 64 64"
			aria-hidden="true"
			data-color={color || undefined}
		>
			<g className="board-thumb-empty-note" transform={tilt ? `rotate(${tilt} 32 19)` : undefined}>
				<rect x="14" y="16" width="36" height="34" rx="2" />
			</g>
			<circle className="board-thumb-empty-pin" cx="32" cy="19" r="4.5" />
		</svg>
	);
}
