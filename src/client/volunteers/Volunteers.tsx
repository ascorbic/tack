import { type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { pendingIssueFor } from "../../shared/actions.ts";
import { MAX_FACES } from "../../shared/cardFoot.ts";
import type { Card } from "../../shared/cards.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import {
	type Volunteer,
	namesInWords,
	sameLogin,
	toggleVolunteer,
	unstageVolunteered,
} from "../../shared/volunteers.ts";
import { loadRepoMeta, ServicesContext, stagerFor } from "../actions/services.ts";
import { undoToast } from "../actions/toast.ts";
import { useChangesUI } from "../changes/context.ts";
import { useShapeChanges } from "../changes/store.ts";
import { DecisionContext } from "../decisions/context.ts";
import type { CardVolunteers } from "../CardView.tsx";
import { DocContext, HistoryContext, ReadOnlyContext } from "../DocContext.ts";
import { AvatarImage, initials } from "../People.tsx";
import { announce } from "../announce.tsx";
import type { User } from "../presence.ts";
import type { ToastStore } from "../Toasts.tsx";
import { type History, transactLocal } from "../undo.ts";
import { useLinger } from "../useLinger.ts";
import {
	type ShownVolunteer,
	canAssign,
	planFor,
	shownVolunteers,
	stagePlan,
	withdrawnInWords,
} from "./assign.ts";
import { useVolunteersOn } from "./store.ts";
import "./volunteers.css";

// Volunteering on the board (volunteers.ts): a raised hand on a card or a
// sticky ("I'll take it") that appears as you hover, focus or select it, and
// a chip of ✋ and who's volunteered that stays once anyone has. Both live in
// the foot: on a card, the hand is the chip's ghost at the foot's end, which
// becomes the chip as you press it; on a sticky, it follows the author. On
// an issue's card, "Assign" stages them as its assignees.

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
	/** Leading the chip of faces (or its ghost, on a card nobody's volunteered for), or on a sticky. */
	place: "chip" | "sticky";
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
			{place === "chip" ? (
				// In the chip, the emoji itself, as reactions are.
				<span className="volunteers-emoji" aria-hidden="true">
					✋
				</span>
			) : (
				<HandIcon size={place === "sticky" ? 13 : 14} />
			)}
		</button>
	);
}

/** Someone's face in the chip: their avatar over their initials, in their colour. */
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
			{/* Nobody yet: a dashed circle where your face will be. */}
			{volunteers.length === 0 && <span className="volunteer volunteer-placeholder" />}
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
 * The chip in a card's foot, or after a sticky's author: ✋ and who's volunteered,
 * unfolding to "Assign" as you point at, focus or select what it's on.
 */
export function VolunteerChip({
	volunteers,
	me,
	place,
	toggle,
	assign,
	leaving = false,
	enter = false,
	initialOpen = false,
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
	/** Unfolded to start with: the gallery's pointed-at state. */
	initialOpen?: boolean;
}) {
	// Nobody yet, on a card: the chip's ghost, ✋ and a dashed circle where
	// your face will be, which becomes the chip in place as you press it.
	const ghost = volunteers.length === 0;
	const label = ghost ? undefined : volunteersLabel(volunteers, me);
	// Fingers have no hover: a tap on the faces opens it, as pointing does.
	const [open, setOpen] = useState(initialOpen);
	return (
		<span
			className="volunteers nodrag nopan"
			data-place={place}
			data-ghost={ghost || undefined}
			data-open={open || undefined}
			data-leaving={leaving || undefined}
			data-enter={enter || undefined}
			role={ghost ? undefined : "group"}
			aria-label={label}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
			}}
		>
			{toggle ? (
				// Your hand leads the faces: it says whose they are, and puts yours
				// up or down.
				<HandButton place="chip" pressed={toggle.pressed} onToggle={toggle.onToggle} />
			) : (
				<span className="volunteers-mark volunteers-emoji" aria-hidden="true">
					✋
				</span>
			)}
			<span
				className="volunteers-who"
				data-tooltip={label}
				onPointerDown={(event) => {
					if (event.pointerType === "touch" && assign) event.stopPropagation();
				}}
				onClick={(event) => {
					if (!assign) return;
					event.stopPropagation();
					setOpen((was) => !was);
				}}
			>
				<VolunteerStack volunteers={volunteers} me={me} />
			</span>
			{assign && (
				// Unfolds as you point at, focus or select what it's on.
				<span className="volunteers-more" data-tooltip={assign.tooltip}>
					<span className="volunteers-fold">
						<button
							type="button"
							className="volunteers-assign"
							aria-label="Assign volunteers"
							onPointerDown={(event) => event.stopPropagation()}
							onDoubleClick={(event) => event.stopPropagation()}
							onClick={(event) => {
								event.stopPropagation();
								assign.onAssign();
							}}
						>
							Assign
						</button>
					</span>
				</span>
			)}
		</span>
	);
}

/**
 * How many faces a card's foot keeps room for: everyone's, and yours too
 * while you could put your hand up, so pressing ✋ moves nothing (the chip
 * grows into room already kept for it, as the ghost is the chip with you in
 * it). Otherwise your face could leave the reactions too little room, they
 * would fold, and the chip would slide out from under the pointer.
 */
export function roomFor(faces: number, couldJoin: boolean): number {
	return faces > 0 && couldJoin ? faces + 1 : faces;
}

/** How long the chip takes to fade away; keep in step with volunteers.css. */
const LEAVE_MS = 220;

/**
 * Put your hand up for a shape, or take it down. Withdrawing also takes you
 * out of what volunteering staged (`unstageVolunteered`), in the same undo
 * step, and says so with Undo, which brings back both.
 */
function toggleHand(
	doc: Y.Doc,
	shape: string,
	user: User,
	toasts: ToastStore | null,
	history: History | null,
): void {
	const login = user.login;
	if (!login) return;
	const { up, unassigned } = transactLocal(doc, () => {
		const up = toggleVolunteer(doc, shape, user);
		return { up, unassigned: up ? [] : unstageVolunteered(doc, shape, login) };
	});
	if (unassigned.length === 0) return announce(up ? "You’ve volunteered" : "You’ve withdrawn");
	const message = withdrawnInWords(unassigned);
	if (!toasts) return announce(message);
	if (history) undoToast(toasts, history, message);
	else toasts.show({ message });
}

/** What a shape's volunteering needs from the board: who you are, and whether you can. */
function useVolunteering(shape: string) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const user = useContext(DecisionContext).user;
	const history = useContext(HistoryContext);
	const toasts = useChangesUI()?.toasts ?? null;
	const volunteers = useVolunteersOn(doc, shape);
	const me = loginOf(user);
	const mine = !!me && volunteers.some((v) => sameLogin(v.login, me));
	const toggle = (): void => {
		if (!doc || !user?.login) return;
		toggleHand(doc, shape, user, toasts, history);
	};
	return { doc, user, me, volunteers, mine, canVolunteer: !!doc && !readOnly && !!me, toggle };
}

/**
 * Whether a list was empty and now isn't, while this was showing: the
 * moment to pop the chip in, rather than on load.
 */
function useArrived(count: number): boolean {
	const [before, setBefore] = useState(count);
	const [arrived, setArrived] = useState(false);
	// Worked out as it renders, so the chip's first frame already animates.
	const now = before === 0 && count > 0 ? true : count === 0 ? false : arrived;
	if (before !== count) {
		setBefore(count);
		setArrived(now);
	}
	return now;
}

/**
 * A card's volunteering, for its foot: the chip of who's volunteered; or,
 * while nobody has, its ghost (✋ alone, shown as you point at, focus or
 * select the card) for those who can volunteer; or null.
 */
export function useCardVolunteers(shape: string, card: Card | null): CardVolunteers | null {
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
	const toggles = canVolunteer && !assigned;
	if (!lingering.value && !toggles) return null;
	const faces = lingering.value?.length ?? 0;
	// The same chip throughout, so the ghost becomes it in place as you press it.
	return {
		chip: (
			<VolunteerChip
				volunteers={lingering.value ?? []}
				me={me}
				place="card"
				leaving={lingering.leaving}
				// Someone else's hand pops the chip in; yours grows it from the ghost you pressed.
				enter={arrived && !mine}
				toggle={toggles ? { pressed: mine, onToggle: toggle } : undefined}
				assign={
					offerAssign
						? {
								onAssign: () => void assign(),
								tooltip: `Stage assigning ${namesInWords(open, me)}`,
							}
						: undefined
				}
			/>
		),
		count: roomFor(faces, toggles && !mine),
		unfolds: offerAssign,
	};
}

/**
 * A sticky's volunteering: the faces after its author's name, and the
 * hand. Those its staged issue will be assigned are marked.
 */
export function useStickyVolunteers(
	shape: string,
	faceDown: boolean,
): { chip: ReactNode; hand: ReactNode } {
	const { doc, me, volunteers, mine, canVolunteer, toggle } = useVolunteering(shape);
	const changes = useChangesUI();
	useShapeChanges(changes?.store ?? null, shape);
	const lingering = useLinger(volunteers.length > 0 ? volunteers : null, LEAVE_MS);
	// Face down, it's nobody's to take on yet.
	if (faceDown) return { chip: null, hand: null };
	const issue = doc ? pendingIssueFor(doc, shape) : null;
	const assignees = issue?.op.kind === "issue.create" ? (issue.op.assignees ?? []) : [];
	const shown = (lingering.value ?? []).map((v): ShownVolunteer =>
		assignees.some((login) => sameLogin(login, v.login)) ? { ...v, staged: true } : v,
	);
	if (shown.length === 0) {
		return {
			chip: null,
			hand: canVolunteer ? <HandButton place="sticky" pressed={mine} onToggle={toggle} /> : null,
		};
	}
	return {
		chip: (
			<VolunteerChip
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
	const history = useContext(HistoryContext);
	const toasts = useChangesUI()?.toasts ?? null;
	const me = loginOf(user);
	if (!me) return null;
	const mine = volunteers.some((v) => sameLogin(v.login, me));
	return (
		<div className="phone-sheet-volunteers">
			<button
				type="button"
				className="phone-sheet-volunteer"
				aria-pressed={mine}
				onClick={() => toggleHand(doc, shape, user, toasts, history)}
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
