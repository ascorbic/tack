import { useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useRef } from "react";
import { type CommentThread, liveMessages, pinPosition } from "../../shared/comments.ts";
import { NOMINAL_SIZE, type SizeOf } from "../../shared/sections.ts";
import { centreClearOf, clearView } from "../clearView.ts";
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
	const { you, threads } = useComments();
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

	// A new mention of you here, while you're here: the inbox hears straight
	// away, not in a minute, and a toast says who, with a way to the thread.
	const openThread = useRef<(thread: CommentThread) => void>(() => {});
	useEffect(() => {
		const login = user.login?.toLowerCase();
		if (!login) return;
		let known: Set<string> | null = null;
		const check = () => {
			const state = commentStore.getState();
			if (!state.ready) return;
			const now = new Set<string>();
			let fresh: { thread: CommentThread; name: string } | null = null;
			for (const thread of state.threads.values()) {
				for (const message of liveMessages(thread)) {
					if (!message.mentions?.includes(login)) continue;
					if (message.author.login.toLowerCase() === login) continue;
					now.add(message.id);
					if (known && !known.has(message.id)) {
						fresh = { thread, name: message.author.name || message.author.login };
					}
				}
			}
			known = now;
			if (!fresh) return;
			void notificationStore.refresh();
			// Not while you're reading that thread already.
			if (commentStore.getUI().open === fresh.thread.id) return;
			const { thread } = fresh;
			toasts.show({
				message: `${fresh.name} mentioned you`,
				action: { label: "View", run: () => openThread.current(thread) },
			});
		};
		check();
		return commentStore.subscribe(check);
	}, [user.login, toasts]);

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
			// Leave room for the popover, to the pin's right, clear of open panels.
			const centre = centreClearOf(
				{ x: at.x + 170 / zoom, y: at.y + 80 / zoom },
				zoom,
				clearView(),
			);
			void flow.setCenter(centre.x, centre.y, { zoom, duration: scaledDuration(JUMP_MS) });
			// (A resolved thread's pin shows while it's open.)
			commentStore.openThread(thread.id, { flash: true });
		},
		[flow, pointOf],
	);
	openThread.current = jumpToThread;

	const jumpToShape = useCallback(
		(id: string) => {
			if (!flow.getNode(id)) return;
			// In the middle of what's clear of open panels (the digest, say),
			// with room around it.
			const view = clearView();
			const bounds = flow.getNodesBounds([id]);
			const clear = Math.max(200, view.width - view.left - view.right);
			const zoom = Math.max(
				0.2,
				Math.min(
					Math.max(flow.getZoom(), 0.9),
					clear / (bounds.width * 2.4),
					view.height / (bounds.height * 2.4),
				),
			);
			const centre = centreClearOf(
				{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
				zoom,
				view,
			);
			void flow.setCenter(centre.x, centre.y, { zoom, duration: scaledDuration(JUMP_MS) });
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
			// After the board has had a moment to lay out (a timer, not a frame: frames wait for a visible tab).
			setTimeout(() => jumpToThread(thread), 0);
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
		/** Whether the board has any comments (an empty board with comments isn't empty). */
		hasThreads: threads.size > 0,
		canComment: you.canComment,
		/** Why not, when you can't: signed out, or the board's archived. */
		commentBlocked: you.canComment ? undefined : you.reason,
		closePanel,
		jumpToThread,
		jumpToShape,
	};
}
