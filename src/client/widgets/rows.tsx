import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import type { Card } from "../../shared/cards.ts";
import { StateIcon } from "../CardView.tsx";
import { scaledDuration } from "../motion.ts";
import type { RowProps } from "./host.tsx";
import { ExternalIcon, PinIcon } from "./icons.tsx";

// Rows of items in widgets: how they come and go, and one row that every
// kind builds on (the item, whatever the kind shows about it, and its pin on
// the board or a link out), dragged out as a card like a list's.

export type Motion = "enter" | "leave" | "changed";

/** What a row shows, to tell when it changed. */
function signature(card: Card): string {
	return JSON.stringify([
		card.title,
		card.state,
		card.labels.map((l) => l.name),
		card.assignees.map((a) => a.login),
		card.pull?.checks?.state,
		card.pull?.review,
	]);
}

/**
 * Rows as they come and go: new ones slide in (a cascade, on first load),
 * ones that stopped matching fold away where they were, and changed ones
 * flash. Pass the same array while nothing's changed (memoise derived ones).
 */
export function useRowMotion(rows: readonly Card[]): { card: Card; motion?: Motion }[] {
	const [shown, setShown] = useState<{ card: Card; motion?: Motion }[]>(() =>
		rows.map((card) => ({ card })),
	);
	const previous = useRef(rows);
	useEffect(() => {
		const before = previous.current;
		previous.current = rows;
		if (before === rows) return;
		const old = new Map(before.map((card) => [card.key, card]));
		const keys = new Set(rows.map((card) => card.key));
		const next: { card: Card; motion?: Motion }[] = rows.map((card) => {
			const was = old.get(card.key);
			return {
				card,
				motion: !was ? "enter" : signature(was) !== signature(card) ? "changed" : undefined,
			};
		});
		before.forEach((card, i) => {
			if (!keys.has(card.key)) next.splice(Math.min(i, next.length), 0, { card, motion: "leave" });
		});
		setShown(next);
		if (!next.some((row) => row.motion)) return;
		const settle = setTimeout(
			() =>
				setShown((current) =>
					current.filter((row) => row.motion !== "leave").map(({ card }) => ({ card })),
				),
			scaledDuration(900),
		);
		return () => clearTimeout(settle);
	}, [rows]);
	return shown;
}

/**
 * One item in a widget: its state, title and `meta` (the kind's own), with
 * `side` on the right before the pin or link out. Drag it onto the board to
 * add a card; it lights up while its card is pointed at.
 */
export function ItemRow({
	card,
	motion,
	order = 0,
	rows,
	meta,
	side,
	actions,
	className,
	data,
}: {
	card: Card;
	motion?: Motion;
	/** Its place among rows entering together, for the cascade. */
	order?: number;
	rows: RowProps;
	meta?: ReactNode;
	side?: ReactNode;
	/** Shown on hover, over the right of the row. */
	actions?: ReactNode;
	className?: string;
	/** Extra `data-` attributes, e.g. a tone. */
	data?: Record<string, string | boolean | undefined>;
}) {
	const onBoard = rows.onBoard?.(card.key) ?? false;
	const attributes = Object.fromEntries(
		Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value || undefined]),
	);
	return (
		<li
			className={`widget-row nodrag nopan${className ? ` ${className}` : ""}`}
			data-state={card.state}
			data-motion={motion}
			data-linked={rows.linked === card.key || undefined}
			data-on-board={onBoard || undefined}
			data-lifted={rows.lifted === card.key || undefined}
			data-draggable={!rows.readOnly || undefined}
			style={{ "--i": Math.min(order, 10) } as CSSProperties}
			onPointerEnter={() => rows.onRowHover?.(card.key)}
			onPointerLeave={() => rows.onRowHover?.(null)}
			onPointerDown={(event) => rows.onRowPointerDown?.(event, card)}
			title={rows.readOnly ? undefined : "Drag onto the board to add a card"}
			{...attributes}
		>
			<span className="state-icon" aria-hidden="true">
				<StateIcon card={card} size={14} />
			</span>
			<span className="widget-row-main">
				<span className="widget-row-title">{card.title}</span>
				<span className="widget-row-meta">
					<span className="mono">
						{card.repo.split("/").at(-1)} {card.item}
					</span>
					{meta}
				</span>
			</span>
			<span className="widget-row-side">
				{side}
				{onBoard ? (
					<button
						type="button"
						className="widget-row-marker"
						aria-label={`${card.item} is on the board: show it`}
						data-tooltip="On the board"
						onPointerDown={(event) => event.stopPropagation()}
						onClick={() => rows.onReveal?.(card.key)}
					>
						<PinIcon />
					</button>
				) : (
					<a
						className="widget-row-open"
						href={card.url}
						target="_blank"
						rel="noreferrer"
						draggable={false}
						aria-label={`Open ${card.item}`}
						onPointerDown={(event) => event.stopPropagation()}
					>
						<ExternalIcon />
					</a>
				)}
			</span>
			{actions && (
				<span
					className="widget-row-actions"
					onPointerDown={(event) => event.stopPropagation()}
					onPointerEnter={() => rows.onRowHover?.(card.key)}
				>
					{actions}
				</span>
			)}
		</li>
	);
}

/** Labels, a few of them, as small chips. */
export function RowLabels({ card, max = 2 }: { card: Card; max?: number }) {
	return (
		<>
			{card.labels.slice(0, max).map((label) => (
				<span
					key={label.name}
					className="chip label widget-row-label"
					style={{ "--label": `#${label.color}` } as CSSProperties}
				>
					{label.name}
				</span>
			))}
			{card.labels.length > max && (
				<span className="widget-row-more">+{card.labels.length - max}</span>
			)}
		</>
	);
}
