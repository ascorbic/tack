import { useState } from "react";
import type { Actor, StepMeta, SystemKind } from "../../shared/history.ts";

export { whatHappened } from "../../shared/history.ts";
import { initials } from "../People.tsx";
import "./history.css";

// Small pieces the history panel, the scrubber and the marks share.

const DAY = 86_400_000;

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** "14:02" in the viewer's own clock. */
export function clockTime(at: number): string {
	return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Today", "Yesterday", "Tue 6 Oct", or with the year when it isn't this one. */
export function dayLabel(at: number, now = Date.now()): string {
	const day = startOfDay(at);
	const today = startOfDay(now);
	if (day === today) return "Today";
	if (day === today - DAY) return "Yesterday";
	const date = new Date(at);
	return date.toLocaleDateString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
	});
}

export function startOfDay(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** When a step was: a moment, or for a merged step, the span it covers. */
export function stepTime(step: Pick<StepMeta, "at" | "until" | "span">): string {
	if (step.span >= DAY) return dayLabel(step.at);
	if (step.span > 0 && clockTime(step.at) !== clockTime(step.until)) {
		return CLOCK.formatRange(step.at, step.until);
	}
	return clockTime(step.until);
}

/** "Tue 6 Oct · 14:02" */
export function moment(at: number, now = Date.now()): string {
	return `${dayLabel(at, now)} · ${clockTime(at)}`;
}

/** Who, in words: "Priya", "Priya and Kai", "Priya, Kai and 2 others". */
export function actorNames(keys: readonly string[], actors: Record<string, Actor>): string {
	const names = keys.map((key) => actors[key]?.name ?? "Someone");
	if (names.length === 0) return "Someone";
	if (names.length === 1) return names[0]!;
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length === 3 ? "" : "s"}`;
}

/** A person's colour, or a quiet one for the server. */
export function actorColor(actor: Actor | undefined): string {
	return actor?.color || "var(--muted)";
}

/** Someone's avatar: their GitHub picture when we know it, else initials; the server gets a glyph. */
export function ActorAvatar({ actor, size = 22 }: { actor: Actor | undefined; size?: number }) {
	const [loaded, setLoaded] = useState(false);
	const [failed, setFailed] = useState(false);
	const style = {
		"--avatar": actorColor(actor),
		"--size": `${size}px`,
	} as React.CSSProperties;
	if (actor?.system) {
		return (
			<span className="history-avatar" data-system={actor.system} style={style} aria-hidden="true">
				<SystemGlyph kind={actor.system} />
			</span>
		);
	}
	const id = actor?.key.startsWith("u:") ? Number(actor.key.slice(2)) : 0;
	const src =
		actor?.avatarUrl ??
		(id > 0 ? `https://avatars.githubusercontent.com/u/${id}?s=${size * 2}` : null);
	return (
		<span className="history-avatar" style={style} aria-hidden="true">
			{initials(actor?.name || actor?.login || "?")}
			{src && !failed && (
				<img
					src={src}
					alt=""
					data-loaded={loaded}
					onLoad={() => setLoaded(true)}
					onError={() => setFailed(true)}
				/>
			)}
		</span>
	);
}

/** Up to three avatars, overlapping, then "+n". */
export function ActorStack({
	keys,
	actors,
	size = 22,
}: {
	keys: readonly string[];
	actors: Record<string, Actor>;
	size?: number;
}) {
	const shown = keys.slice(0, 3);
	return (
		<span className="history-stack" data-count={shown.length}>
			{shown.map((key) => (
				<ActorAvatar key={key} actor={actors[key]} size={size} />
			))}
			{keys.length > 3 && <span className="history-stack-more">+{keys.length - 3}</span>}
		</span>
	);
}

function SystemGlyph({ kind }: { kind: SystemKind }) {
	switch (kind) {
		case "push":
			return (
				<svg viewBox="0 0 16 16" width="60%" height="60%" aria-hidden="true">
					<path d="M8 12.5V4M4.5 7.25 8 3.75l3.5 3.5" />
				</svg>
			);
		case "rule":
			return (
				<svg viewBox="0 0 16 16" width="60%" height="60%" aria-hidden="true">
					<path d="M9 2.5 4.5 9H8l-1 4.5L11.5 7H8z" />
				</svg>
			);
		case "reveal":
			return (
				<svg viewBox="0 0 16 16" width="64%" height="64%" aria-hidden="true">
					<path d="M1.75 8S4 4 8 4s6.25 4 6.25 4S12 12 8 12 1.75 8 1.75 8z" />
					<circle cx="8" cy="8" r="1.75" />
				</svg>
			);
		case "timer":
			return (
				<svg viewBox="0 0 16 16" width="62%" height="62%" aria-hidden="true">
					<circle cx="8" cy="9" r="4.75" />
					<path d="M8 6.5V9l1.5 1M6.5 2.25h3" />
				</svg>
			);
		default:
			return (
				<svg viewBox="0 0 16 16" width="58%" height="58%" aria-hidden="true">
					<path d="M8 1.75 9.6 6.4l4.65.1-3.7 2.85 1.35 4.5L8 11.2l-3.9 2.65 1.35-4.5L1.75 6.5l4.65-.1z" />
				</svg>
			);
	}
}

// --- Icons ----------------------------------------------------------------------

export function HistoryIcon({ size = 16 }: { size?: number }) {
	return (
		<svg className="history-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
			<path className="history-icon-rim" d="M2.6 6.1A5.75 5.75 0 1 1 2.25 8" />
			<path className="history-icon-arrow" d="M2.25 3.25v3h3" />
			<path className="history-icon-hands" d="M8 5v3.1l2.1 1.4" />
		</svg>
	);
}

export function PlayIcon({ playing }: { playing: boolean }) {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" data-playing={playing}>
			<path
				className="history-play-glyph"
				d="M5 3.4v9.2a.6.6 0 0 0 .9.5l7.2-4.6a.6.6 0 0 0 0-1L5.9 2.9a.6.6 0 0 0-.9.5z"
			/>
			<g className="history-pause-glyph">
				<rect x="4" y="3" width="2.8" height="10" rx="1" />
				<rect x="9.2" y="3" width="2.8" height="10" rx="1" />
			</g>
		</svg>
	);
}

export function StepIcon({ direction }: { direction: "back" | "forward" }) {
	return (
		<svg
			viewBox="0 0 16 16"
			width="15"
			height="15"
			aria-hidden="true"
			style={direction === "back" ? { scale: "-1 1" } : undefined}
		>
			<path d="M4 3.5v9l6-4.5z" className="history-filled" />
			<path d="M12 3.5v9" />
		</svg>
	);
}

export function CloseIcon() {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
			<path d="M4 4l8 8M12 4l-8 8" />
		</svg>
	);
}

export function RestoreIcon() {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
			<path d="M3.5 6.5H10a3 3 0 0 1 0 6H6.5" />
			<path d="M6 3.75 3.25 6.5 6 9.25" />
		</svg>
	);
}

export function SectionIcon() {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
			<rect x="2.25" y="3.5" width="11.5" height="10" rx="2" />
			<path d="M2.25 3.5h4.5v-1" />
		</svg>
	);
}

export function InfoIcon() {
	return (
		<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
			<circle cx="8" cy="8" r="6" />
			<path d="M8 7.25V11M8 5v.01" />
		</svg>
	);
}

export function FlagIcon() {
	return (
		<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
			<path d="M3.5 14V2.5M3.5 3h7.5l-1.75 2.75L11 8.5H3.5" />
		</svg>
	);
}
