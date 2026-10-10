import { useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useRef } from "react";
import { type CommentThread, mentions, pinPosition } from "../../shared/comments.ts";
import { NOMINAL_SIZE, type SizeOf } from "../../shared/sections.ts";
import type { ShapeNode } from "../board.ts";
import { scaledDuration } from "../motion.ts";
import type { User } from "../presence.ts";
import type { ToastStore } from "../Toasts.tsx";
import { notificationStore } from "./Notifications.tsx";
import { peopleSource } from "./people.ts";
import { commentStore, useCommentUI, useComments } from "./store.ts";

/** Pans and zooms for jumping to things take this long. */
const JUMP_MS = 520;

/**
 * Comments on a board (#51), and the jumps "since you were here" (#46)
 * makes: who you are for the comment store, refusals as toasts, going to a
 * thread or shape on the canvas, and opening `#comment=…` links (from
 * notifications) once the thread has loaded.
 */
export function useCommentsOnBoard({
	user,
	nodes,
	sizeOf,
	toasts,
	onPanel,
	board,
}: {
	user: User;
	nodes: ShapeNode[];
	sizeOf: SizeOf;
	toasts: ToastStore;
	/** The comments panel opened: close anything else in its place. */
	onPanel?: () => void;
	/** The board's id, to mark its notifications read as you read them. */
	board?: string;
}) {
	const flow = useReactFlow();
	const { you } = useComments();
	const ui = useCommentUI();
	const latest = useRef({ nodes, sizeOf, onPanel });
	latest.current = { nodes, sizeOf, onPanel };

	useEffect(() => {
		commentStore.user = user;
		peopleSource.self = user.login;
	}, [user]);

	useEffect(() => {
		commentStore.onRefused = (message) => toasts.show({ message });
		return () => {
			commentStore.onRefused = null;
		};
	}, [toasts]);

	useEffect(() => {
		if (ui.panel) latest.current.onPanel?.();
	}, [ui.panel]);

	// Reading a thread reads its notifications too.
	useEffect(() => {
		if (ui.open && board) void notificationStore.read({ board, thread: ui.open });
	}, [ui.open, board]);

	// A new mention of you here: the inbox hears straight away, not in a minute.
	useEffect(() => {
		const login = user.login;
		if (!login) return;
		let known = -1;
		const check = () => {
			const count = [...commentStore.getState().threads.values()].filter((thread) =>
				mentions(thread, login),
			).length;
			if (known >= 0 && count > known) void notificationStore.refresh();
			known = count;
		};
		check();
		return commentStore.subscribe(check);
	}, [user.login]);

	const pointOf = useCallback((thread: CommentThread) => {
		const shape = thread.anchor.shape;
		const node = shape ? latest.current.nodes.find((n) => n.id === shape) : undefined;
		if (!node) return pinPosition(thread.anchor, undefined);
		const size = latest.current.sizeOf(node.id) ?? NOMINAL_SIZE[node.data.shape.type];
		return pinPosition(thread.anchor, {
			x: node.position.x,
			y: node.position.y,
			w: node.width ?? size?.w ?? 200,
			h: node.height ?? size?.h ?? 120,
		});
	}, []);

	const jumpToThread = useCallback(
		(thread: CommentThread) => {
			const at = pointOf(thread);
			const zoom = Math.max(flow.getZoom(), 0.9);
			// Leave room for the popover, to the pin's right.
			void flow.setCenter(at.x + 170 / zoom, at.y + 80 / zoom, {
				zoom,
				duration: scaledDuration(JUMP_MS),
			});
			// (A resolved thread's pin shows while it's open.)
			commentStore.openThread(thread.id, { flash: true });
		},
		[flow, pointOf],
	);

	const jumpToShape = useCallback(
		(id: string) => {
			if (!flow.getNode(id)) return;
			void flow.fitView({
				nodes: [{ id }],
				padding: 1.4,
				maxZoom: Math.max(flow.getZoom(), 0.9),
				duration: scaledDuration(JUMP_MS),
			});
		},
		[flow],
	);

	// `#comment=…`: go to that thread once it's here.
	useEffect(() => {
		const check = () => {
			const match = /#comment=([^&]+)/.exec(location.hash);
			if (!match?.[1]) return;
			const thread = commentStore.get(decodeURIComponent(match[1]));
			if (!thread) return;
			history.replaceState(history.state, "", location.pathname + location.search);
			// After the board has had a moment to lay out.
			requestAnimationFrame(() => jumpToThread(thread));
		};
		check();
		window.addEventListener("hashchange", check);
		const unsubscribe = commentStore.subscribe(check);
		return () => {
			window.removeEventListener("hashchange", check);
			unsubscribe();
		};
	}, [jumpToThread]);

	const closePanel = useCallback(() => commentStore.setUI({ panel: false }), []);

	return {
		youId: you.id,
		canComment: you.canComment,
		closePanel,
		jumpToThread,
		jumpToShape,
	};
}
