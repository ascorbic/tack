import { NodeToolbar, Position } from "@xyflow/react";
import { useContext, useEffect, useSyncExternalStore } from "react";
import type { ShapeProps } from "../../shared/shapes.ts";
import { silentOf } from "../../shared/silent.ts";
import { membersOf } from "../../shared/stacks.ts";
import { CardView } from "../CardView.tsx";
import { useCard } from "../cardStore.ts";
import { DocContext, ReadOnlyContext } from "../DocContext.ts";
import { useSilentTexts } from "../facilitation/store.ts";
import { useCardProvenance } from "../Provenance.tsx";
import { StackPapers } from "../stacks/StackNode.tsx";
import { readPreview } from "../../shared/linkPreview.ts";
import { ServicesContext } from "../actions/services.ts";
import { LinkView } from "../links/LinkView.tsx";
import { StickyView, tilt } from "../StickyNode.tsx";
import type { DisplayState } from "./useDisplay.ts";

// The full card, popped out of a row or a mini card (#72): on hover, after a
// moment's intent (and at once while one's already showing, so running the
// pointer down a list reads it), and pinned while the row is selected on its
// own, beside its usual actions. Drawn at screen size, so a list read from
// far away still pops out legibly. A stack's row pops out as its theme card
// (#73): its name and its first few stickies and cards.

/** How long the pointer rests on a row before its card pops out. */
const SHOW_MS = 260;
/** How long it lingers after the pointer leaves, so moving to the next row doesn't flicker. */
const HIDE_MS = 140;

class PreviewStore {
	private shown: string | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private listeners = new Set<() => void>();

	enter(id: string): void {
		this.cancel();
		if (this.shown !== null) {
			this.set(id);
			return;
		}
		this.timer = setTimeout(() => this.set(id), SHOW_MS);
	}

	leave(id: string): void {
		this.cancel();
		if (this.shown !== id) return;
		this.timer = setTimeout(() => this.set(null), HIDE_MS);
	}

	clear(): void {
		this.cancel();
		this.set(null);
	}

	private cancel(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	private set(id: string | null): void {
		if (this.shown === id) return;
		this.shown = id;
		for (const listener of this.listeners) listener();
	}

	get = (): string | null => this.shown;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

export const previewStore = new PreviewStore();

export function DisplayPreview({
	display,
	selected,
	suppressed,
}: {
	display: DisplayState;
	selected: ReadonlySet<string>;
	/** Mid-drag, or with a tool that isn't for reading. */
	suppressed: boolean;
}) {
	const hovered = useSyncExternalStore(previewStore.subscribe, previewStore.get);
	// Whatever was pointed at on the way through a drag isn't asked about.
	useEffect(() => {
		if (suppressed) previewStore.clear();
	}, [suppressed]);
	const only = selected.size === 1 ? ([...selected][0] ?? null) : null;
	// Moving the selection (say, with the arrow keys) shows its card, not
	// whatever the pointer happens to rest on.
	useEffect(() => {
		previewStore.clear();
	}, [only]);
	const previewable = (id: string | null) => {
		if (id === null) return null;
		const slot = display.slots.get(id);
		const shape = display.shapes.get(id);
		if (!slot || slot.dragging || slot.kind === "group" || !shape) return null;
		if (!["card", "sticky", "stack", "link"].includes(shape.type)) return null;
		return { id, slot, shape };
	};
	const target = suppressed ? null : (previewable(hovered) ?? previewable(only));
	if (!target) return null;
	const pinned = target.id === only;
	// A mini card grows into its card where it is; rows, and a selected mini
	// card (whose actions sit under it), pop out to the side.
	const grow = target.slot.kind === "mini" && !pinned;
	return (
		<NodeToolbar
			nodeId={target.id}
			isVisible
			position={grow ? Position.Top : Position.Right}
			align={grow ? "center" : "start"}
			offset={grow ? 0 : 14}
			style={{ zIndex: 2900 }}
		>
			<div
				key={target.id}
				className="display-preview"
				data-grow={grow || undefined}
				data-pinned={pinned || undefined}
				aria-hidden={!pinned}
			>
				{target.shape.type === "card" ? (
					<CardPreview id={target.id} shape={target.shape} />
				) : target.shape.type === "link" ? (
					<LinkPreviewCard shape={target.shape} />
				) : target.shape.type === "stack" ? (
					<StackPreview id={target.id} shape={target.shape} shapes={display.shapes} />
				) : (
					<StickyPreview id={target.id} shape={target.shape} />
				)}
			</div>
		</NodeToolbar>
	);
}

function LinkPreviewCard({ shape }: { shape: ShapeProps }) {
	const links = useContext(ServicesContext)?.links;
	return (
		<LinkView
			url={shape.url ?? ""}
			preview={readPreview(shape.preview)}
			imageSrc={links?.imageSrc}
		/>
	);
}

function CardPreview({ id, shape }: { id: string; shape: ShapeProps }) {
	const key = shape.ref ?? "";
	const card = useCard(key);
	const { origin, unmatched } = useCardProvenance(
		useContext(DocContext),
		id,
		shape,
		useContext(ReadOnlyContext),
	);
	return <CardView card={card} cardKey={key} origin={origin} unmatched={unmatched} />;
}

function StackPreview({
	id,
	shape,
	shapes,
}: {
	id: string;
	shape: ShapeProps;
	shapes: ReadonlyMap<string, ShapeProps>;
}) {
	const members = membersOf(shapes, id).flatMap((member) => {
		const props = shapes.get(member);
		return props ? [{ id: member, shape: props }] : [];
	});
	return (
		<StackPapers id={id} shape={shape} view={{ members, open: false, receiving: false, fed: 0 }} />
	);
}

function StickyPreview({ id, shape }: { id: string; shape: ShapeProps }) {
	const session = silentOf(shape);
	const texts = useSilentTexts();
	const mine = session !== null && texts.has(id);
	const faceDown = session !== null && !mine;
	return (
		<StickyView
			text={faceDown ? "" : ((mine ? texts.get(id) : shape.text) ?? "")}
			color={shape.color ?? "yellow"}
			font={shape.font}
			author={shape.author}
			tilt={tilt(id)}
			faceDown={faceDown}
			hidden={mine}
		/>
	);
}
