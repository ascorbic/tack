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

const COLORS = ["#3b4cca", "#b4467a", "#1f7a6b", "#a35a12", "#7444c4", "#c2372b", "#2a7ab0"];
const ADJECTIVES = ["Curious", "Gentle", "Brave", "Quiet", "Swift", "Merry", "Sunny", "Clever"];
const ANIMALS = ["Otter", "Heron", "Badger", "Lynx", "Puffin", "Fox", "Hare", "Wren"];

function pick<T>(list: T[]): T {
	return list[Math.floor(Math.random() * list.length)] as T;
}

export function randomUser(): User {
	return { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLORS) };
}

/** This browser's identity until real sign-in exists. */
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
