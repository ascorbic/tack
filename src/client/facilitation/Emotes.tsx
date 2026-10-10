import { useReactFlow, useStore } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import {
	EMOTES,
	type Emote,
	type EmoteEmoji,
	HIGH_FIVE,
	HIGH_FIVE_MS,
	HIGH_FIVE_REACH,
	type HighFive,
	highFives,
} from "../../shared/facilitation.ts";
import { useAwarenessField } from "../ephemeral.ts";
import { onGesture } from "./gestures.ts";
import { isOffBoardTarget } from "../keys.ts";
import { scaledDuration } from "../motion.ts";
import type { RemotePresence, User } from "../presence.ts";

// Emotes and high-fives (#50). Press E for a wheel of emotes by your
// pointer: each one floats up from your cursor, for everyone. ✋ holds your
// hand out for a high-five: bring it to someone else's raised hand and you
// both get a little celebration (and so does everyone watching). Nothing is
// stored: it all travels as awareness, like cursors.

const FLOAT_MS = 1900;
const CELEBRATE_MS = 1700;
const MAX_FLOATS = 40;
const WHEEL_RADIUS = 66;

interface Float {
	id: number;
	emoji: string;
	x: number;
	y: number;
	/** A little sideways drift, so a burst doesn't stack. */
	drift: number;
}

interface Celebration {
	id: string;
	x: number;
	y: number;
	names: [string, string];
	colors: [string, string];
}

let floatIds = 0;

export function Emotes({
	awareness,
	user,
	people,
	enabled = true,
}: {
	awareness: Awareness;
	user: User;
	people: RemotePresence[];
	/** Off while a dialog or the playground's keyboard owns E. */
	enabled?: boolean;
}) {
	const flow = useReactFlow();
	const [x, y, zoom] = useStore((state) => state.transform);
	const [floats, setFloats] = useState<Float[]>([]);
	const [celebrations, setCelebrations] = useState<Celebration[]>([]);
	// From the Facilitate menu, the wheel opens mid-board, and waits for the
	// pointer to come to it before wandering away closes it.
	const [wheel, setWheel] = useState<{ x: number; y: number; waiting?: boolean } | null>(null);
	const [raised, setRaised] = useState<number | null>(null);
	const pointer = useRef({ x: innerWidth / 2, y: innerHeight / 2 });
	const counter = useRef(0);
	const handAnchor = useRef<HTMLDivElement>(null);

	const spawn = useCallback((emoji: string, at: { x: number; y: number }) => {
		const float: Float = { id: ++floatIds, emoji, ...at, drift: Math.random() * 2 - 1 };
		setFloats((current) => [...current.slice(-(MAX_FLOATS - 1)), float]);
		setTimeout(
			() => setFloats((current) => current.filter((f) => f.id !== float.id)),
			scaledDuration(FLOAT_MS) + 50,
		);
	}, []);

	// Follow the pointer (in the page) for the wheel and your raised hand.
	useEffect(() => {
		const onMove = (event: PointerEvent) => {
			pointer.current = { x: event.clientX, y: event.clientY };
			const hand = handAnchor.current;
			if (hand)
				hand.style.transform = `translate(${event.clientX + 10}px, ${event.clientY - 30}px)`;
		};
		window.addEventListener("pointermove", onMove, { passive: true });
		return () => window.removeEventListener("pointermove", onMove);
	}, []);

	const emit = useCallback(
		(emoji: EmoteEmoji) => {
			const at = flow.screenToFlowPosition(pointer.current);
			if (emoji === HIGH_FIVE) {
				const now = Date.now();
				setRaised(now);
				awareness.setLocalStateField("highFive", { at: now } satisfies HighFive);
				setWheel(null);
				return;
			}
			// From the wheel, they spring from just above it, so it doesn't hide them.
			const from = wheel
				? flow.screenToFlowPosition({ x: wheel.x, y: wheel.y - WHEEL_RADIUS - 28 })
				: at;
			const emote: Emote = { n: ++counter.current, emoji, x: from.x, y: from.y };
			awareness.setLocalStateField("emote", emote);
			spawn(emoji, from);
		},
		[awareness, flow, spawn, wheel],
	);

	// Lower your hand after a while.
	useEffect(() => {
		if (raised === null) return;
		const timer = setTimeout(() => {
			setRaised(null);
			awareness.setLocalStateField("highFive", null);
		}, HIGH_FIVE_MS);
		return () => clearTimeout(timer);
	}, [raised, awareness]);
	useEffect(
		() => () => {
			if (awareness.getLocalState()) awareness.setLocalStateField("highFive", null);
		},
		[awareness],
	);

	// E opens the wheel; numbers pick from it; E or Escape closes it.
	useEffect(() => {
		if (!enabled) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey || isOffBoardTarget(event.target)) return;
			if (event.key === "e" || event.key === "E") {
				event.preventDefault();
				setWheel((open) => (open ? null : { ...pointer.current }));
				return;
			}
			if (!wheel) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setWheel(null);
				return;
			}
			const n = Number(event.key);
			const emoji = EMOTES[n - 1];
			if (Number.isInteger(n) && emoji) {
				event.preventDefault();
				emit(emoji);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [enabled, wheel, emit]);

	useEffect(
		() =>
			onGesture("emotes", (at) => {
				if (!enabled) return;
				setWheel({ ...at, waiting: true });
			}),
		[enabled],
	);

	// The wheel closes when the pointer wanders well away from it.
	useEffect(() => {
		if (!wheel) return;
		let near = !wheel.waiting;
		const onMove = (event: PointerEvent) => {
			const far = Math.hypot(event.clientX - wheel.x, event.clientY - wheel.y) > WHEEL_RADIUS * 2.6;
			if (!far) near = true;
			else if (near) setWheel(null);
		};
		window.addEventListener("pointermove", onMove, { passive: true });
		return () => window.removeEventListener("pointermove", onMove);
	}, [wheel]);

	const arrived = useRef(false);
	useEffect(() => {
		const timer = setTimeout(() => {
			arrived.current = true;
		}, 500);
		return () => clearTimeout(timer);
	}, []);

	// Everyone else's emotes: each new one floats up from where they sent it.
	const [remoteEmotes] = useAwarenessField<Emote>(awareness, "emote");
	const seen = useRef(new Map<number, number>());
	useEffect(() => {
		for (const { clientId, value } of remoteEmotes) {
			if (typeof value?.n !== "number") continue;
			const last = seen.current.get(clientId);
			seen.current.set(clientId, value.n);
			if (last !== undefined && value.n <= last) continue;
			// Ignore an emote that was already there when we arrived.
			if (last === undefined && !arrived.current) continue;
			spawn(value.emoji, { x: value.x, y: value.y });
		}
	}, [remoteEmotes, spawn]);

	// High-fives: raised hands that meet.
	const [remoteHands] = useAwarenessField<HighFive>(awareness, "highFive");
	const hands = useMemo(() => {
		const out: { id: number; at: number; x: number; y: number; user: User }[] = [];
		for (const { clientId, value } of remoteHands) {
			const person = people.find((p) => p.clientId === clientId);
			if (person?.cursor && typeof value?.at === "number") {
				out.push({ id: clientId, at: value.at, ...person.cursor, user: person.user });
			}
		}
		return out;
	}, [remoteHands, people]);
	const celebrated = useRef(new Set<string>());
	const [myCursor, setMyCursor] = useState<{ x: number; y: number } | null>(null);
	useEffect(() => {
		if (raised === null) return;
		const update = () => setMyCursor(flow.screenToFlowPosition(pointer.current));
		update();
		window.addEventListener("pointermove", update, { passive: true });
		return () => window.removeEventListener("pointermove", update);
	}, [raised, flow]);
	useEffect(() => {
		const all = [...hands];
		if (raised !== null && myCursor) {
			all.push({ id: awareness.clientID, at: raised, ...myCursor, user });
		}
		if (all.length < 2) return;
		for (const [a, b] of highFives(all, HIGH_FIVE_REACH / zoom)) {
			const first = all.find((h) => h.id === a)!;
			const second = all.find((h) => h.id === b)!;
			const key = `${a}:${first.at}|${b}:${second.at}`;
			if (celebrated.current.has(key)) continue;
			celebrated.current.add(key);
			const celebration: Celebration = {
				id: key,
				x: (first.x + second.x) / 2,
				y: (first.y + second.y) / 2,
				names: [first.user.name, second.user.name],
				colors: [first.user.color, second.user.color],
			};
			setCelebrations((current) => [...current, celebration]);
			setTimeout(
				() => setCelebrations((current) => current.filter((c) => c.id !== key)),
				scaledDuration(CELEBRATE_MS) + 50,
			);
			if (a === awareness.clientID || b === awareness.clientID) {
				setRaised(null);
				awareness.setLocalStateField("highFive", null);
			}
		}
	}, [hands, raised, myCursor, zoom, awareness, user]);

	return (
		<>
			<div className="emotes-layer" aria-hidden="true">
				<div
					className="emotes-viewport"
					style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }}
				>
					{hands.map((hand) => (
						<span
							key={`hand-${hand.id}`}
							className="emote-hand"
							style={{ transform: `translate(${hand.x}px, ${hand.y}px) scale(${1 / zoom})` }}
						>
							<span className="emote-hand-glyph">{HIGH_FIVE}</span>
						</span>
					))}
					{floats.map((float) => (
						<span
							key={float.id}
							className="emote-float"
							style={
								{
									transform: `translate(${float.x}px, ${float.y}px) scale(${1 / zoom})`,
									"--drift": float.drift,
								} as React.CSSProperties
							}
						>
							<span className="emote-float-glyph">{float.emoji}</span>
						</span>
					))}
					{celebrations.map((c) => (
						<span
							key={c.id}
							className="high-five"
							style={{ transform: `translate(${c.x}px, ${c.y}px) scale(${1 / zoom})` }}
						>
							<HighFiveBurst names={c.names} colors={c.colors} />
						</span>
					))}
				</div>
			</div>
			{raised !== null && (
				<div
					ref={handAnchor}
					className="emote-my-hand"
					aria-hidden="true"
					style={{
						transform: `translate(${pointer.current.x + 10}px, ${pointer.current.y - 30}px)`,
					}}
				>
					<span className="emote-hand-glyph">{HIGH_FIVE}</span>
				</div>
			)}
			{raised !== null && (
				<span className="visually-hidden" role="status">
					Hand raised for a high-five: find someone else’s
				</span>
			)}
			{wheel && <EmoteWheel at={wheel} onPick={emit} onClose={() => setWheel(null)} />}
		</>
	);
}

/** The wheel of emotes around the pointer. */
export function EmoteWheel({
	at,
	onPick,
	onClose,
}: {
	at: { x: number; y: number };
	onPick: (emoji: EmoteEmoji) => void;
	onClose?: () => void;
}) {
	return (
		<div
			className="emote-wheel"
			role="menu"
			aria-label="Emotes"
			style={{ left: at.x, top: at.y }}
			onPointerDown={(event) => {
				if (event.target === event.currentTarget) onClose?.();
			}}
		>
			<span className="emote-wheel-hub" aria-hidden="true">
				E
			</span>
			{EMOTES.map((emoji, i) => {
				const angle = (i / EMOTES.length) * Math.PI * 2 - Math.PI / 2;
				return (
					<button
						key={emoji}
						type="button"
						role="menuitem"
						className="emote-wheel-item"
						data-high-five={emoji === HIGH_FIVE || undefined}
						aria-label={emoji === HIGH_FIVE ? "High five" : `Emote ${emoji}`}
						data-tooltip={emoji === HIGH_FIVE ? "High five" : undefined}
						style={
							{
								"--x": `${Math.cos(angle) * WHEEL_RADIUS}px`,
								"--y": `${Math.sin(angle) * WHEEL_RADIUS}px`,
								"--i": i,
							} as React.CSSProperties
						}
						onClick={() => onPick(emoji)}
					>
						<span aria-hidden="true">{emoji}</span>
						<kbd aria-hidden="true">{i + 1}</kbd>
					</button>
				);
			})}
		</div>
	);
}

/** Two hands meeting: a clap, a ring of sparks in both people's colours, and their names. */
export function HighFiveBurst({
	names,
	colors,
}: {
	names: [string, string];
	colors: [string, string];
}) {
	return (
		<span
			className="high-five-burst"
			role="img"
			aria-label={`${names[0]} and ${names[1]} high-fived`}
		>
			{Array.from({ length: 12 }, (_, i) => (
				<span
					key={i}
					className="high-five-spark"
					style={
						{
							"--angle": `${(i / 12) * 360}deg`,
							"--spark": colors[i % 2] || "var(--accent)",
							"--i": i,
						} as React.CSSProperties
					}
				/>
			))}
			<span className="high-five-clap">🙌</span>
			<span className="high-five-names">
				{names[0]} <span aria-hidden="true">✋</span> {names[1]}
			</span>
		</span>
	);
}
