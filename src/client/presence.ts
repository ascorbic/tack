import type { NodeChange } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type { Status } from "./activity.ts";
import type { Position, ShapeNode } from "./board.ts";
import type { Chat } from "./chat.ts";
import type { View } from "./viewport.ts";

// Ephemeral, per-client state shared through Yjs awareness. None of this is
// ever written to the document.

export interface User {
	name: string;
	color: string;
	/** Signed-in people only: their GitHub login and avatar. */
	login?: string;
	avatarUrl?: string;
}

/** Who's making a shape, as it records them: their login too, when they're signed in. */
export function authorFor(user: User): { name: string; color: string; login?: string } {
	return { name: user.name, color: user.color, ...(user.login ? { login: user.login } : {}) };
}

export interface PresenceState {
	user?: User;
	/** Pointer position in flow coordinates, or null when off the canvas. */
	cursor?: Position | null;
	/** Shapes this client is dragging right now, by id. */
	drags?: Record<string, Position>;
	/** Cursor chat: what they're saying, if anything. */
	chat?: Chat | null;
	/** The part of the board they can see, for following them. */
	view?: View | null;
	/** Whether they're active, idle, or have the tab in the background. */
	status?: Status;
	/** The client they're following, if any. */
	following?: number | null;
	/** When they took their colour, by their clock (see `useBoardColor`). */
	colorSince?: number;
}

export interface RemoteDrag extends Position {
	user?: User;
}

/** Someone else on the board. */
export interface RemotePresence {
	clientId: number;
	user: User;
	/** Null when their pointer is off the canvas. */
	cursor: Position | null;
	chat: Chat | null;
	view: View | null;
	status: Status;
	following: number | null;
}

/**
 * People's colours: twelve hues far enough apart to tell cursors, dots and
 * face-down stickies apart, dark enough for white initials, and readable on
 * both themes' boards. Ordered so that the first eight are as different
 * from each other as they can be: they're handed out first.
 */
export const COLORS = [
	"#2f5fd0", // blue
	"#c25412", // orange
	"#1f8a4c", // green
	"#c2257a", // magenta
	"#0e7f86", // teal
	"#7a4fd6", // violet
	"#c7352b", // red
	"#6b7a12", // olive
	"#2a87c4", // sky
	"#a8740a", // gold
	"#a03fbd", // purple
	"#8b5a3c", // brown
];

/**
 * The colour someone takes on a board, given everyone else's: the first of
 * `preferred` (the one they had here last time, then their own) that's as
 * little used as any, else the least used, in palette order.
 */
export function pickColor(
	preferred: readonly (string | null | undefined)[],
	others: readonly string[],
	palette: readonly string[] = COLORS,
): string {
	const used = new Map<string, number>(palette.map((color) => [color, 0]));
	for (const color of others) if (used.has(color)) used.set(color, used.get(color)! + 1);
	const fewest = Math.min(...used.values());
	for (const color of preferred) {
		if (color && used.get(color) === fewest) return color;
	}
	return palette.find((color) => used.get(color) === fewest) ?? palette[0]!;
}

/** Someone else on the board, as far as colours go. */
export interface ColorClaim {
	clientId: number;
	color: string;
	/** When they took it (their clock): the earlier claim keeps it. */
	since: number;
	/** Who they are: the same person in two tabs shares a colour. */
	who: string;
}

/**
 * Whether you should give your colour up: someone else (not you in another
 * tab) took it first, and there's a colour nobody's using.
 */
export function yieldsColor(
	mine: { clientId: number; color: string; since: number; who: string },
	others: readonly ColorClaim[],
	palette: readonly string[] = COLORS,
): boolean {
	const taken = new Set(others.filter((o) => o.who !== mine.who).map((o) => o.color));
	if (palette.every((color) => taken.has(color))) return false;
	return others.some(
		(other) =>
			other.who !== mine.who &&
			other.color === mine.color &&
			(other.since < mine.since || (other.since === mine.since && other.clientId < mine.clientId)),
	);
}

const colorKey = (board: string) => `tack:color:${board}`;

function rememberedColor(board: string): string | null {
	try {
		const color = localStorage.getItem(colorKey(board));
		return color && COLORS.includes(color) ? color : null;
	} catch {
		return null;
	}
}

function rememberColor(board: string, color: string): void {
	try {
		localStorage.setItem(colorKey(board), color);
	} catch {}
}

/** Who someone is, for telling their own tabs from other people. */
function whoOf(user: User | undefined): string {
	return user?.login ? `@${user.login.toLowerCase()}` : `~${user?.name ?? ""}`;
}

/**
 * Your colour on this board: nobody present shares it while there's one
 * free. You keep the one you had here last time (remembered in this
 * browser), or your own, unless someone who got here first has it, in
 * which case you take the least used. Everyone's client decides for itself
 * the same way, so two people arriving together settle on different ones.
 */
export function useBoardColor(awareness: Awareness, user: User, board: string): User {
	const [color, setColor] = useState(() => {
		const remembered = rememberedColor(board);
		return remembered ?? (COLORS.includes(user.color) ? user.color : pickColor([user.color], []));
	});
	const since = useRef(Date.now());
	const remembered = useRef<string | null>(null);
	const latest = useRef({ color, user });
	latest.current = { color, user };

	useEffect(() => {
		awareness.setLocalStateField("colorSince", since.current);
	}, [awareness, color]);

	useEffect(() => {
		const check = () => {
			const { color: mine, user: me } = latest.current;
			const others: ColorClaim[] = [];
			for (const [clientId, state] of states(awareness)) {
				if (clientId === awareness.clientID || !state.user?.color) continue;
				others.push({
					clientId,
					color: state.user.color,
					since: typeof state.colorSince === "number" ? state.colorSince : 0,
					who: whoOf(state.user),
				});
			}
			const self = {
				clientId: awareness.clientID,
				color: mine,
				since: since.current,
				who: whoOf(me),
			};
			if (!yieldsColor(self, others)) {
				if (remembered.current !== mine) {
					remembered.current = mine;
					rememberColor(board, mine);
				}
				return;
			}
			const next = pickColor(
				[rememberedColor(board), me.color],
				others.filter((o) => o.who !== self.who).map((o) => o.color),
			);
			if (next === mine) return;
			since.current = Date.now();
			remembered.current = next;
			rememberColor(board, next);
			setColor(next);
		};
		check();
		awareness.on("change", check);
		return () => awareness.off("change", check);
	}, [awareness, board]);

	return useMemo(() => (user.color === color ? user : { ...user, color }), [user, color]);
}
const ADJECTIVES = ["Curious", "Gentle", "Brave", "Quiet", "Swift", "Merry", "Sunny", "Clever"];
const ANIMALS = ["Otter", "Heron", "Badger", "Lynx", "Puffin", "Fox", "Hare", "Wren"];

function pick<T>(list: T[]): T {
	return list[Math.floor(Math.random() * list.length)] as T;
}

export function randomUser(): User {
	return { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLORS) };
}

/** This browser's identity when not signed in: a random, remembered name. */
export function localUser(): User {
	try {
		const stored = localStorage.getItem("tack:user");
		if (stored) return JSON.parse(stored) as User;
	} catch {}
	const user = randomUser();
	try {
		localStorage.setItem("tack:user", JSON.stringify(user));
	} catch {}
	return user;
}

function states(awareness: Awareness): Map<number, PresenceState> {
	return awareness.getStates() as Map<number, PresenceState>;
}

/**
 * Local and remote presence for a board: who's here, their cursors, and
 * shapes being dragged right now. Local drags come from React Flow change
 * events and are published at most once per frame.
 */
export function usePresence(awareness: Awareness, user: User) {
	const [localDrags, setLocalDrags] = useState(() => new Map<string, Position>());
	const [remote, setRemote] = useState<{
		drags: Map<string, RemoteDrag>;
		people: RemotePresence[];
	}>(() => ({ drags: new Map(), people: [] }));
	const localDragsRef = useRef(localDrags);
	localDragsRef.current = localDrags;

	useEffect(() => {
		awareness.setLocalStateField("user", user);
	}, [awareness, user]);

	useEffect(() => {
		const onChange = () => {
			const drags = new Map<string, RemoteDrag>();
			const people: RemotePresence[] = [];
			for (const [clientId, state] of states(awareness)) {
				if (clientId === awareness.clientID) continue;
				for (const [id, position] of Object.entries(state.drags ?? {})) {
					drags.set(id, { ...position, user: state.user });
				}
				// Everyone with a name is here, whether or not their pointer is
				// on the canvas.
				if (state.user) {
					people.push({
						clientId,
						user: state.user,
						cursor: state.cursor ?? null,
						chat: state.chat ?? null,
						view: state.view ?? null,
						status: state.status ?? "active",
						following: state.following ?? null,
					});
				}
			}
			setRemote({ drags, people });
		};
		onChange();
		awareness.on("change", onChange);
		return () => awareness.off("change", onChange);
	}, [awareness]);

	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			awareness.setLocalStateField("drags", Object.fromEntries(localDrags));
		});
		return () => cancelAnimationFrame(frame);
	}, [awareness, localDrags]);

	const cursorFrame = useRef(0);
	const setCursor = useCallback(
		(cursor: Position | null) => {
			cancelAnimationFrame(cursorFrame.current);
			cursorFrame.current = requestAnimationFrame(() => {
				awareness.setLocalStateField("cursor", cursor);
			});
		},
		[awareness],
	);

	const onPositionChanges = useCallback((changes: NodeChange<ShapeNode>[]) => {
		let next: Map<string, Position> | undefined;
		for (const change of changes) {
			if (change.type !== "position") continue;
			next ??= new Map(localDragsRef.current);
			if (change.dragging && change.position) next.set(change.id, change.position);
			else next.delete(change.id);
		}
		if (next) setLocalDrags(next);
	}, []);

	/** Positions to show instead of the document's, local drags winning. */
	const overrides = useMemo(() => {
		const merged = new Map<string, RemoteDrag>(remote.drags);
		for (const [id, position] of localDrags) merged.set(id, position);
		return merged;
	}, [localDrags, remote.drags]);

	return {
		overrides,
		people: remote.people,
		setCursor,
		onPositionChanges,
		lastDragPosition: (id: string) => localDragsRef.current.get(id),
	};
}
