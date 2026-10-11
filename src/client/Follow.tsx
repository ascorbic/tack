import { useReactFlow, useStore, useStoreApi } from "@xyflow/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import { isEditableTarget } from "./keys.ts";
import { scaledDuration } from "./motion.ts";
import type { RemotePresence } from "./presence.ts";
import { sameView, viewOf, viewportFor } from "./viewport.ts";

/** Publish our own view at most this often while panning and zooming. */
const PUBLISH_MS = 100;
/** Glide to the first view, then track updates closely. */
const JUMP_MS = 650;
const TRACK_MS = 140;

const linear = (t: number) => t;

/**
 * Publishes the part of the board this person can see, so others can
 * follow them. Render inside <ReactFlow>.
 */
export function ViewPublisher({
	awareness,
	paused = false,
}: {
	awareness: Awareness;
	/** Not while the board's moving for its own reasons (drawing an export): followers stay put. */
	paused?: boolean;
}) {
	const view = useStore((state) => viewOf(state.transform, state.width, state.height), sameView);
	const last = useRef(0);
	useEffect(() => {
		if (paused) return;
		const publish = () => {
			last.current = performance.now();
			awareness.setLocalStateField("view", view);
		};
		const wait = PUBLISH_MS - (performance.now() - last.current);
		if (wait <= 0) {
			publish();
			return;
		}
		// Trailing update, so the last view of a gesture always goes out.
		const timer = setTimeout(publish, wait);
		return () => clearTimeout(timer);
	}, [awareness, view, paused]);
	return null;
}

/**
 * Follow someone: jump to what they can see and keep tracking them. Any pan
 * or zoom of your own stops following, as does Escape, or them leaving.
 */
export function useFollow(awareness: Awareness, people: RemotePresence[]) {
	const flow = useReactFlow();
	const store = useStoreApi();
	const [following, setFollowing] = useState<number | null>(null);
	const target = following === null ? undefined : people.find((p) => p.clientId === following);
	// Viewport changes we make ourselves start before this time.
	const ownUntil = useRef(0);
	const jumped = useRef(false);

	useEffect(() => {
		awareness.setLocalStateField("following", following);
		jumped.current = false;
	}, [awareness, following]);

	// They left the board.
	useEffect(() => {
		if (following !== null && !target) setFollowing(null);
	}, [following, target]);

	const view = target?.view;
	const x = view?.x;
	const y = view?.y;
	const width = view?.width;
	const height = view?.height;
	useEffect(() => {
		if (x === undefined || y === undefined || width === undefined || height === undefined) return;
		const state = store.getState();
		const viewport = viewportFor({ x, y, width, height }, state.width, state.height, {
			minZoom: state.minZoom,
			maxZoom: state.maxZoom,
		});
		const first = !jumped.current;
		jumped.current = true;
		const duration = scaledDuration(first ? JUMP_MS : TRACK_MS);
		ownUntil.current = performance.now() + duration + 100;
		void flow.setViewport(
			viewport,
			first ? { duration } : { duration, ease: linear, interpolate: "linear" },
		);
	}, [x, y, width, height, flow, store]);

	const stop = useCallback(() => setFollowing(null), []);

	// Escape stops following, unless it's closing something else.
	useEffect(() => {
		if (following === null) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !isEditableTarget(event.target)) setFollowing(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [following]);

	/**
	 * For <ReactFlow onMoveStart>. Moves from a pointer, wheel or touch carry
	 * an event; programmatic ones don't, so those count as manual only when
	 * they aren't ours (the minimap, zoom buttons, shortcuts).
	 */
	const onMoveStart = useCallback(
		(event: MouseEvent | TouchEvent | null) => {
			if (following === null) return;
			if (event || performance.now() > ownUntil.current) setFollowing(null);
		},
		[following],
	);

	/** Go to where someone is looking, once, without following them. */
	const latestPeople = useRef(people);
	latestPeople.current = people;
	const jump = useCallback(
		(clientId: number) => {
			const view = latestPeople.current.find((p) => p.clientId === clientId)?.view;
			if (!view) return;
			setFollowing(null);
			const state = store.getState();
			void flow.setViewport(
				viewportFor(view, state.width, state.height, {
					minZoom: state.minZoom,
					maxZoom: state.maxZoom,
				}),
				{ duration: scaledDuration(JUMP_MS) },
			);
		},
		[flow, store],
	);

	return { following, target, follow: setFollowing, stop, onMoveStart, jump };
}

/**
 * While following: the canvas is framed in their colour, with a pill
 * saying whose view this is and a way out.
 */
export function FollowIndicator({
	person,
	onStop,
}: {
	person: RemotePresence | undefined;
	onStop: () => void;
}) {
	if (!person) return null;
	return (
		<div
			className="follow"
			style={{ "--follow": person.user.color } as React.CSSProperties}
			data-status={person.status}
		>
			<div className="follow-frame" aria-hidden="true" />
			<div className="follow-pill" role="status">
				<span>
					Following <strong>{person.user.name}</strong>
					{person.status !== "active" && ` (${person.status})`}
				</span>
				<span className="follow-pill-dot" aria-hidden="true">
					·
				</span>
				<button type="button" onClick={onStop}>
					Stop
				</button>
			</div>
		</div>
	);
}
