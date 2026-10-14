import { type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { pendingIssueFor } from "../../shared/actions.ts";
import type { Card } from "../../shared/cards.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import {
	type Volunteer,
	namesInWords,
	sameLogin,
	toggleVolunteer,
} from "../../shared/volunteers.ts";
import { loadRepoMeta, ServicesContext, stagerFor } from "../actions/services.ts";
import { undoToast } from "../actions/toast.ts";
import { useChangesUI } from "../changes/context.ts";
import { useShapeChanges } from "../changes/store.ts";
import { DecisionContext } from "../decisions/context.ts";
import { DocContext, HistoryContext, ReadOnlyContext } from "../DocContext.ts";
import { AvatarImage, initials } from "../People.tsx";
import { announce } from "../announce.tsx";
import type { User } from "../presence.ts";
import { transactLocal } from "../undo.ts";
import { useLinger } from "../useLinger.ts";
import { type ShownVolunteer, canAssign, planFor, shownVolunteers, stagePlan } from "./assign.ts";
import { useVolunteersOn } from "./store.ts";
import "./volunteers.css";

// Volunteering on the board (volunteers.ts): a raised hand on a card or a
// sticky ("I'll take it") that appears as you hover, focus or select it, and
// a row of who's volunteered that stays once anyone has. On an issue's
// card, "Assign" stages them as its assignees.

/** A raised hand, open palm forward. */
export function HandIcon({ size = 14 }: { size?: number }) {
	return (
		<svg className="hand-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
			<path d="M5.4 8.6V4.9a.95.95 0 0 1 1.9 0v3.2M7.3 7.6V3.3a.95.95 0 0 1 1.9 0v4.3M9.2 7.6V4a.95.95 0 0 1 1.9 0v4M11.1 8.1V6a.95.95 0 0 1 1.9 0v3.6c0 2.8-2 4.9-4.8 4.9h-.5c-1.4 0-2.5-.5-3.4-1.6l-1.9-2.5a1 1 0 0 1 1.5-1.3l1.5 1.5V8.6" />
		</svg>
	);
}

/** You, as a volunteer: who you're signed in as, or null when you aren't. */
function loginOf(user: User | null): string | null {
	return user?.login ?? null;
}

/**
 * The toggle: your hand up, or down. Its name says what it does
 * ("I'll take it"); pressed while yours is up.
 */
export function HandButton({
	pressed,
	onToggle,
	place,
	disabled,
}: {
	pressed: boolean;
	onToggle?: () => void;
	/** In the card's head (nobody yet), the row, or floating on a sticky. */
	place: "head" | "row" | "sticky";
	/** Why it can't be pressed, if it can't. */
	disabled?: string;
}) {
	// A wave as it goes up.
	const [wave, setWave] = useState(0);
	return (
		<button
			type="button"
			className="volunteer-hand nodrag nopan"
			data-place={place}
			data-wave={wave > 0 || undefined}
			key={wave}
			aria-pressed={pressed}
			aria-label="I’ll take it"
			aria-disabled={disabled ? true : undefined}
			data-tooltip={disabled ?? (pressed ? "Withdraw" : "I’ll take it")}
			onPointerDown={(event) => event.stopPropagation()}
			onDoubleClick={(event) => event.stopPropagation()}
			onClick={(event) => {
				event.stopPropagation();
				if (disabled || !onToggle) return;
				if (!pressed) setWave((n) => n + 1);
				onToggle();
			}}
		>
			<HandIcon size={place === "sticky" ? 13 : 14} />
		</button>
	);
}

/** Someone's face in the row: their avatar over their initials, in their colour. */
function Face({
	volunteer,
	mine,
	fresh,
}: {
	volunteer: ShownVolunteer;
	mine: boolean;
	fresh: boolean;
}) {
	return (
		<span
			className="volunteer"
			data-mine={mine || undefined}
			data-staged={volunteer.staged || undefined}
			data-new={fresh || undefined}
			style={{ "--avatar": volunteer.color || "var(--muted)" } as React.CSSProperties}
		>
			{/* One letter: two don't fit a face half hidden by the next. */}
			<span className="volunteer-initials">{initials(volunteer.name).slice(0, 1)}</span>
			{volunteer.avatar && <AvatarImage key={volunteer.avatar} src={volunteer.avatar} />}
		</span>
	);
}

/** Faces shown before the rest fold into "+N". */
const MAX_FACES = 4;

/**
 * Who's volunteered, as overlapping avatars (yours ringed, those staged to
 * be assigned dashed); hovering names them all.
 */
export function VolunteerStack({
	volunteers,
	me,
}: {
	volunteers: readonly ShownVolunteer[];
	me: string | null;
}) {
	// Only hands that go up while you watch pop in: not everyone on load.
	const seen = useRef<Set<string> | null>(null);
	const known = seen.current;
	useEffect(() => {
		seen.current = new Set(volunteers.map((v) => v.login.toLowerCase()));
	}, [volunteers]);
	// Yours first, as the names say it: it's who you look for.
	const ordered = me
		? [
				...volunteers.filter((v) => sameLogin(v.login, me)),
				...volunteers.filter((v) => !sameLogin(v.login, me)),
			]
		: volunteers;
	const shown = ordered.length > MAX_FACES ? ordered.slice(0, MAX_FACES - 1) : ordered;
	const more = volunteers.length - shown.length;
	return (
		<span className="volunteer-stack" aria-hidden="true">
			{shown.map((v) => (
				<Face
					key={v.login.toLowerCase()}
					volunteer={v}
					mine={!!me && sameLogin(v.login, me)}
					fresh={!!known && !known.has(v.login.toLowerCase())}
				/>
			))}
			{more > 0 && <span className="volunteer volunteer-more">+{more}</span>}
		</span>
	);
}

/** "Volunteers: You, Kai Andersen", with who's staged to be assigned. */
export function volunteersLabel(volunteers: readonly ShownVolunteer[], me: string | null): string {
	const names = namesInWords(volunteers, me);
	const staged = volunteers.filter((v) => v.staged);
	const note =
		staged.length === 0
			? ""
			: staged.length === volunteers.length
				? " (staged to be assigned)"
				: ` (${namesInWords(staged, me)} staged to be assigned)`;
	return `Volunteers: ${names}${note}`;
}

/**
 * The row on a card or under a sticky's author: who's volunteered, and
 * (as you hover) your hand and "Assign".
 */
export function VolunteersRow({
	volunteers,
	me,
	place,
	toggle,
	assign,
	leaving = false,
	enter = false,
}: {
	volunteers: readonly ShownVolunteer[];
	me: string | null;
	place: "card" | "sticky";
	/** Your hand, when you can put it up. */
	toggle?: { pressed: boolean; onToggle: () => void };
	/** "Assign", when the card's item can take them. */
	assign?: { onAssign: () => void; tooltip: string };
	/** Going, after the last hand goes down. */
	leaving?: boolean;
	/** Arriving, as the first hand goes up while you watch. */
	enter?: boolean;
}) {
	const label = volunteersLabel(volunteers, me);
	return (
		<div
			className="volunteers"
			data-place={place}
			data-leaving={leaving || undefined}
			data-enter={enter || undefined}
			role="group"
			aria-label={label}
		>
			<div className="volunteers-inner">
				{place === "card" ? (
					<span className="volunteers-label" aria-hidden="true">
						Volunteers
					</span>
				) : toggle ? (
					// No room for the word on a sticky: your hand says whose faces
					// these are, and stays, so it's never two hands side by side.
					<HandButton place="row" pressed={toggle.pressed} onToggle={toggle.onToggle} />
				) : (
					<span className="volunteers-mark" aria-hidden="true">
						<HandIcon size={11} />
					</span>
				)}
				<span className="volunteers-who" data-tooltip={label}>
					<VolunteerStack volunteers={volunteers} me={me} />
				</span>
				<span className="volunteers-actions">
					{assign && (
						<button
							type="button"
							className="volunteers-assign nodrag nopan"
							aria-label="Assign volunteers"
							data-tooltip={assign.tooltip}
							onPointerDown={(event) => event.stopPropagation()}
							onDoubleClick={(event) => event.stopPropagation()}
							onClick={(event) => {
								event.stopPropagation();
								assign.onAssign();
							}}
						>
							Assign
						</button>
					)}
					{toggle && place === "card" && (
						<HandButton place="row" pressed={toggle.pressed} onToggle={toggle.onToggle} />
					)}
				</span>
			</div>
		</div>
	);
}

/** How long the row takes to fold away; keep in step with volunteers.css. */
const LEAVE_MS = 220;

/** What a shape's volunteering needs from the board: who you are, and whether you can. */
function useVolunteering(shape: string) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const user = useContext(DecisionContext).user;
	const volunteers = useVolunteersOn(doc, shape);
	const me = loginOf(user);
	const mine = !!me && volunteers.some((v) => sameLogin(v.login, me));
	const toggle = (): void => {
		if (!doc || !user?.login) return;
		const up = transactLocal(doc, () => toggleVolunteer(doc, shape, user));
		announce(up ? "You’ve volunteered" : "You’ve withdrawn");
	};
	return { doc, user, me, volunteers, mine, canVolunteer: !!doc && !readOnly && !!me, toggle };
}

/**
 * Whether a list was empty and now isn't, while this was showing: the
 * moment to animate a row in, rather than on load.
 */
function useArrived(count: number): boolean {
	const [before, setBefore] = useState(count);
	const [arrived, setArrived] = useState(false);
	// Worked out as it renders, so the row's first frame already animates.
	const now = before === 0 && count > 0 ? true : count === 0 ? false : arrived;
	if (before !== count) {
		setBefore(count);
		setArrived(now);
	}
	return now;
}

/**
 * A card's volunteering: the row of who's volunteered (or null), and the
 * hand for its head when nobody has yet.
 */
export function useCardVolunteers(
	shape: string,
	card: Card | null,
): { row: ReactNode; hand: ReactNode } {
	const { doc, user, me, volunteers, mine, canVolunteer, toggle } = useVolunteering(shape);
	const changes = useChangesUI();
	const history = useContext(HistoryContext);
	const services = useContext(ServicesContext);
	// Re-read what's staged when this card's changes do.
	const staged = useShapeChanges(changes?.store ?? null, shape);
	const shown = useMemo(
		() => (doc && staged ? shownVolunteers(doc, card, volunteers) : []),
		[doc, card, volunteers, staged],
	);
	const assigned = !!me && !!card?.assignees.some((a) => sameLogin(a.login, me));
	const arrived = useArrived(shown.length);
	const lingering = useLinger(shown.length > 0 ? shown : null, LEAVE_MS);
	const open = shown.filter((v) => !v.staged);
	const offerAssign =
		!!doc &&
		!!card &&
		!!user &&
		!!changes &&
		!changes.readOnly &&
		open.length > 0 &&
		canAssign(card, null);
	const assign = async () => {
		if (!doc || !card || !user) return;
		const repo = repoKeyOf(card.key);
		const meta = services ? await loadRepoMeta(services, repo) : null;
		const plan = planFor(doc, [{ shape, card, volunteers }], () => meta);
		const { staged, message } = stagePlan(doc, plan, stagerFor(user));
		const toasts = changes?.toasts;
		if (!toasts) return announce(message);
		if (staged > 0 && history) undoToast(toasts, history, message);
		else toasts.show({ message });
	};
	const row = lingering.value ? (
		<VolunteersRow
			volunteers={lingering.value}
			me={me}
			place="card"
			leaving={lingering.leaving}
			enter={arrived}
			toggle={canVolunteer && !assigned ? { pressed: mine, onToggle: toggle } : undefined}
			assign={
				offerAssign
					? {
							onAssign: () => void assign(),
							tooltip: `Stage assigning ${namesInWords(open, me)}`,
						}
					: undefined
			}
		/>
	) : null;
	const hand =
		canVolunteer && !assigned && shown.length === 0 && !lingering.value ? (
			<HandButton place="head" pressed={mine} onToggle={toggle} />
		) : null;
	return { row, hand };
}

/**
 * A sticky's volunteering: the faces after its author's name, and the
 * hand. Those its staged issue will be assigned are marked.
 */
export function useStickyVolunteers(
	shape: string,
	faceDown: boolean,
): { row: ReactNode; hand: ReactNode } {
	const { doc, me, volunteers, mine, canVolunteer, toggle } = useVolunteering(shape);
	const changes = useChangesUI();
	useShapeChanges(changes?.store ?? null, shape);
	const lingering = useLinger(volunteers.length > 0 ? volunteers : null, LEAVE_MS);
	// Face down, it's nobody's to take on yet.
	if (faceDown) return { row: null, hand: null };
	const issue = doc ? pendingIssueFor(doc, shape) : null;
	const assignees = issue?.op.kind === "issue.create" ? (issue.op.assignees ?? []) : [];
	const shown = (lingering.value ?? []).map((v): ShownVolunteer =>
		assignees.some((login) => sameLogin(login, v.login)) ? { ...v, staged: true } : v,
	);
	if (shown.length === 0) {
		return {
			row: null,
			hand: canVolunteer ? <HandButton place="sticky" pressed={mine} onToggle={toggle} /> : null,
		};
	}
	return {
		row: (
			<VolunteersRow
				volunteers={shown}
				me={me}
				place="sticky"
				leaving={lingering.leaving}
				toggle={canVolunteer ? { pressed: mine, onToggle: toggle } : undefined}
			/>
		),
		hand: null,
	};
}

/** Your hand on a shape, from a phone's sheet: big enough to tap, with who's in. */
export function VolunteerSheetRow({ doc, shape, user }: { doc: Y.Doc; shape: string; user: User }) {
	const volunteers = useVolunteersOn(doc, shape);
	const me = loginOf(user);
	if (!me) return null;
	const mine = volunteers.some((v) => sameLogin(v.login, me));
	return (
		<div className="phone-sheet-volunteers">
			<button
				type="button"
				className="phone-sheet-volunteer"
				aria-pressed={mine}
				onClick={() => {
					const up = transactLocal(doc, () => toggleVolunteer(doc, shape, user));
					announce(up ? "You’ve volunteered" : "You’ve withdrawn");
				}}
			>
				<HandIcon size={18} />
				I’ll take it
			</button>
			{volunteers.length > 0 && (
				<span className="phone-sheet-volunteer-who">
					<VolunteerStack volunteers={volunteers} me={me} />
					<span>{namesInWords(volunteers, me)}</span>
				</span>
			)}
		</div>
	);
}

export type { Volunteer };
