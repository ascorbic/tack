import { type NodeProps, useStore } from "@xyflow/react";
import {
	type ComponentType,
	createContext,
	memo,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { type DotVote, dottersOn, voteFor } from "../../shared/dotvotes.ts";
import type { StampCount, Stamper } from "../../shared/facilitation.ts";
import { UNTITLED_STACK, countMembers, nameState, stackName } from "../../shared/stacks.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { silentOf } from "../../shared/silent.ts";
import { widgetDefinition } from "../../shared/widgetRegistry.ts";
import { linkHost, linkHue, linkText, readPreview } from "../../shared/linkPreview.ts";
import { ServicesContext } from "../actions/services.ts";
import { SiteIcon } from "../links/LinkView.tsx";
import { type ShapeNode, isFresh, setStickyText, takeFocus } from "../board.ts";
import { StateIcon, cardTone, stateLabel } from "../CardView.tsx";
import { useCard } from "../cardStore.ts";
import { DocContext, ReadOnlyContext } from "../DocContext.ts";
import { StampRow, VoteDots, stampShape } from "../facilitation/Marks.tsx";
import { facilitation, useSilentTexts } from "../facilitation/store.ts";
import { initials } from "../People.tsx";
import { useEditing } from "../useEditing.ts";
import { isImageHash } from "../../shared/images.ts";
import { useImageSrc } from "../images/service.ts";
import { useLinked } from "../widgets/store.ts";
import "./display.css";

// Shapes in a section showing a list or mini cards (#72): a compact row, or
// a small card in a grid. They're the same React Flow nodes as ever, drawn
// smaller in their slot, so selection, connectors, staged marks and dragging
// all work as they do for the full shapes.

/** Below this zoom, rows and mini cards drop everything but state and title. */
const COMPACT_ZOOM = 0.45;
/** Below this, they're bars of colour: there's nothing to read anyway. */
const FAR_ZOOM = 0.2;

/** What rows need to show stamps and dots: computed once for the whole board. */
export interface DisplayMarks {
	doc: Y.Doc | null;
	me: Stamper | null;
	stamps: ReadonlyMap<string, StampCount[]>;
	/** Open votes. */
	votes: readonly DotVote[];
	shapes: ReadonlyMap<string, Pick<ShapeProps, "type" | "parent">>;
	now: number;
}

export const DisplayMarksContext = createContext<DisplayMarks>({
	doc: null,
	me: null,
	stamps: new Map(),
	votes: [],
	shapes: new Map(),
	now: 0,
});

/** Wrap a node type so it draws as a row or mini card when its section says so. */
export function withDisplay(Node: ComponentType<NodeProps<ShapeNode>>) {
	return memo(function WithDisplay(props: NodeProps<ShapeNode>) {
		const kind = props.data.display;
		if (kind === "row" || kind === "mini") return <DisplayItem {...props} kind={kind} />;
		return <Node {...props} />;
	});
}

/** How much of a row there is to read at the board's zoom. */
export type ZoomTier = "full" | "compact" | "far";

export function useZoomTier(): ZoomTier {
	const compact = useStore((state) => state.transform[2] < COMPACT_ZOOM);
	const far = useStore((state) => state.transform[2] < FAR_ZOOM);
	return far ? "far" : compact ? "compact" : "full";
}

function DisplayItem({ kind, ...props }: NodeProps<ShapeNode> & { kind: "row" | "mini" }) {
	const shape = props.data.shape;
	const tier = useZoomTier();
	const [enter] = useState(() => isFresh(props.id));
	return (
		<DisplayItemView
			id={props.id}
			shape={shape}
			kind={kind}
			selected={!!props.selected}
			tier={tier}
			enter={enter}
			holds={props.data.stack?.members.map((member) => member.shape.type)}
		/>
	);
}

export interface ItemProps {
	id: string;
	shape: ShapeProps;
	kind: "row" | "mini";
	selected: boolean;
	tier: "full" | "compact" | "far";
	enter: boolean;
	/** A stack's members' types, to say what it holds (#73). */
	holds?: readonly (ShapeProps["type"] | undefined)[];
	/** For the gallery: a silent sticky's side, without a pretend server. */
	silentAs?: "face-down" | "mine";
}

/** A row or mini card, without any board behaviour around it (the gallery uses it too). */
export function DisplayItemView(props: ItemProps) {
	switch (props.shape.type) {
		case "card":
			return <CardItem {...props} />;
		case "sticky":
			return <StickyItem {...props} />;
		case "link":
			return <LinkItem {...props} />;
		case "image":
			return <ImageItem {...props} />;
		default:
			return <PlainItem {...props} />;
	}
}

/** An item's number as people say it, e.g. `#412`. */
function itemOf(ref: string | undefined): string {
	const match = ref ? /[#!]\d+$/.exec(ref) : null;
	return match ? match[0] : "";
}

function repoName(ref: string | undefined): string {
	return (
		(ref ?? "")
			.replace(/[#!]\d+$/, "")
			.split("/")
			.at(-1) ?? ""
	);
}

const CardItem = memo(function CardItem({ id, shape, kind, selected, tier, enter }: ItemProps) {
	const key = shape.ref ?? "";
	const entry = useCard(key);
	const card = entry && !("missing" in entry) ? (entry as Card) : null;
	const linked = useLinked(key, "row");
	const item = itemOf(key);
	const checks = card?.pull?.checks;
	const ci = checks && checks.state !== "none" ? checks.state : undefined;
	const state = card?.state;
	const title = card?.title ?? (entry ? "Not available" : "");
	const labels = card?.labels ?? [];
	const loading = !entry;
	const unavailable = !!entry && !card;
	const common = {
		"data-kind": kind,
		"data-tier": tier,
		"data-state": state,
		"data-ci": ci,
		"data-selected": selected,
		"data-linked": linked || undefined,
		"data-enter": enter || undefined,
		"data-loading": loading || undefined,
		"data-unavailable": unavailable || undefined,
		"data-unmatched": shape.unmatched ? true : undefined,
		"aria-label": card ? `${item} ${card.title}, ${stateLabel(card)}` : `${repoName(key)}${item}`,
		...(card ? cardTone(card) : {}),
	};

	if (kind === "mini") {
		return (
			<article className="display-item display-mini display-card" {...common}>
				<span className="display-mini-head">
					{card ? (
						<span className="state-icon display-state">
							<StateIcon card={card} size={tier === "full" ? 12 : 22} />
						</span>
					) : (
						<span className="display-state display-state-blank" aria-hidden="true" />
					)}
					<span className="display-number mono">{item}</span>
					{tier === "full" && card?.discussion?.category.emoji && (
						<span
							className="display-category"
							title={`Category: ${card.discussion.category.name}`}
							aria-label={`Category: ${card.discussion.category.name}`}
							role="img"
						>
							{card.discussion.category.emoji}
						</span>
					)}
					{tier === "full" && card?.discussion?.upvotes !== undefined && (
						<Upvotes count={card.discussion.upvotes} />
					)}
					<DisplayMarks id={id} compact />
				</span>
				<span className="display-mini-title">
					{loading ? <span className="display-skeleton" /> : title}
				</span>
				{labels.length > 0 && tier === "full" && (
					<span className="display-label-dots" aria-label={labels.map((l) => l.name).join(", ")}>
						{labels.slice(0, 6).map((label) => (
							<span
								key={label.name}
								className="display-label-dot"
								title={label.name}
								style={{ "--label": `#${label.color}` } as React.CSSProperties}
							/>
						))}
					</span>
				)}
				{ci && <span className="display-ci" data-ci={ci} role="img" aria-label={`CI ${ci}`} />}
			</article>
		);
	}

	return (
		<article className="display-item display-row display-card" {...common}>
			{card ? (
				<span className="state-icon display-state">
					<StateIcon card={card} size={tier === "full" ? 14 : 22} />
				</span>
			) : (
				<span className="display-state display-state-blank" aria-hidden="true" />
			)}
			<span className="display-number mono">{item}</span>
			<span className="display-title">
				{loading ? <span className="display-skeleton" /> : title}
			</span>
			{tier === "full" && card?.discussion?.category.emoji && (
				<span
					className="display-category"
					title={`Category: ${card.discussion.category.name}`}
					aria-label={`Category: ${card.discussion.category.name}`}
					role="img"
				>
					{card.discussion.category.emoji}
				</span>
			)}
			{tier === "full" && labels.length > 0 && (
				<span className="display-label-dots" aria-label={labels.map((l) => l.name).join(", ")}>
					{labels.slice(0, 4).map((label) => (
						<span
							key={label.name}
							className="display-label-dot"
							title={label.name}
							style={{ "--label": `#${label.color}` } as React.CSSProperties}
						/>
					))}
				</span>
			)}
			{tier === "full" && ci && (
				<span
					className="display-ci-dot"
					data-ci={ci}
					title={`CI ${ci}`}
					role="img"
					aria-label={`CI ${ci}`}
				/>
			)}
			{tier === "full" && card && (state !== "open" || card.discussion?.answered) && (
				<span className="display-chip">{stateLabel(card)}</span>
			)}
			{tier === "full" && card?.discussion?.upvotes !== undefined && (
				<Upvotes count={card.discussion.upvotes} />
			)}
			{tier === "full" && card && card.assignees.length > 0 && (
				<span
					className="display-avatars"
					aria-label={card.assignees.map((a) => a.login).join(", ")}
				>
					{card.assignees.slice(0, 2).map((a) => (
						<img key={a.login} src={a.avatarUrl} alt="" title={a.login} draggable={false} />
					))}
				</span>
			)}
			<DisplayMarks id={id} />
			{ci && <span className="display-ci" data-ci={ci} aria-hidden="true" />}
		</article>
	);
});

/** A discussion's upvotes, in its card's blue, with its arrow. */
function Upvotes({ count }: { count: number }) {
	return (
		<span className="display-upvotes" title={`${count} ${count === 1 ? "upvote" : "upvotes"}`}>
			<svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
				<path d="M8 3.25 3.5 8.5h3v4.25h3V8.5h3z" />
			</svg>
			<span className="visually-hidden">Upvotes: </span>
			{count}
		</span>
	);
}

const StickyItem = memo(function StickyItem({
	id,
	shape,
	kind,
	selected,
	tier,
	enter,
	silentAs,
}: ItemProps) {
	const doc = useContext(DocContext);
	const [startEditing] = useState(() => takeFocus(id));
	// Silent mode, as on a sticky: yours show your own text, others' lie face down.
	const session = silentOf(shape);
	const texts = useSilentTexts();
	const mine = silentAs ? silentAs === "mine" : session !== null && texts.has(id);
	const faceDown = silentAs ? silentAs === "face-down" : session !== null && !mine;
	const value = (mine && !silentAs ? texts.get(id) : shape.text) ?? "";
	const latest = useRef(value);
	latest.current = value;
	const flip = useFlip(session);
	const { editing, setEditing, field, handlers } = useEditing({
		selected: selected && !faceDown,
		startEditing: startEditing && !faceDown,
		onType: (char) => doc && setStickyText(doc, id, latest.current + char),
	});
	const color = shape.color ?? "yellow";
	const author = shape.author;
	return (
		<article
			key={flip}
			className={`display-item display-${kind === "mini" ? "mini" : "row"} display-sticky`}
			data-kind={kind}
			data-tier={tier}
			data-selected={selected}
			data-editing={editing || undefined}
			data-face-down={faceDown || undefined}
			data-enter={enter || undefined}
			data-flip={flip > 0 || undefined}
			data-font={shape.font}
			style={{ "--paper": `var(--sticky-${color})` } as React.CSSProperties}
			aria-label={faceDown ? `${author?.name || "Someone"}’s sticky, face down` : value || "Sticky"}
			{...(faceDown ? {} : handlers)}
		>
			<span className="display-paper" aria-hidden="true">
				{faceDown && <span className="display-paper-mark">{initials(author?.name || "?")}</span>}
			</span>
			{faceDown ? (
				<span className="display-title display-face-down">
					Face down{author?.name ? ` · ${author.name}` : ""}
				</span>
			) : editing ? (
				<textarea
					ref={field}
					className="display-edit nodrag nowheel"
					aria-label="Sticky note"
					placeholder="Type something…"
					value={value}
					rows={1}
					onChange={(event) => doc && setStickyText(doc, id, event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
							event.preventDefault();
							event.stopPropagation();
							if (mine) facilitation.flush(id);
							setEditing(false);
						}
					}}
					onBlur={() => {
						if (mine) facilitation.flush(id);
						setEditing(false);
					}}
				/>
			) : (
				<span
					className={kind === "mini" ? "display-mini-title display-sticky-text" : "display-title"}
					data-empty={value === "" || undefined}
				>
					{value || (selected ? "Type something…" : "Empty sticky")}
				</span>
			)}
			{mine && (
				<span className="display-hidden" title="Only you can see this until it’s revealed">
					<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
						<path d="M1.5 6s1.6-3 4.5-3 4.5 3 4.5 3-1.6 3-4.5 3-4.5-3-4.5-3z" />
						<path d="M2 10 10 2" />
					</svg>
				</span>
			)}
			{tier === "full" && kind === "row" && author && !faceDown && (
				<span
					className="display-author"
					style={{ "--author": author.color || "var(--muted)" } as React.CSSProperties}
				>
					{author.name}
				</span>
			)}
			<DisplayMarks id={id} compact={kind === "mini"} />
		</article>
	);
});

/** Face down until the reveal, then turning over: a new number each time it does. */
function useFlip(session: string | null): number {
	const [flip, setFlip] = useState(0);
	const was = useRef(session);
	useEffect(() => {
		const before = was.current;
		was.current = session;
		if (before !== null && session === null) setFlip((n) => n + 1);
	}, [session]);
	return flip;
}

const PlainItem = memo(function PlainItem({
	id,
	shape,
	kind,
	selected,
	tier,
	enter,
	holds,
}: ItemProps) {
	const { glyph, title, note } = describePlain(shape, holds);
	return (
		<article
			className={`display-item display-${kind === "mini" ? "mini" : "row"} display-plain`}
			data-kind={kind}
			data-tier={tier}
			data-type={shape.type}
			data-status={shape.type === "decision" ? (shape.status ?? "proposed") : undefined}
			data-selected={selected}
			data-enter={enter || undefined}
			aria-label={title}
		>
			<span className="display-glyph" aria-hidden="true">
				{glyph}
			</span>
			<span className={kind === "mini" ? "display-mini-title" : "display-title"}>{title}</span>
			{note && tier === "full" && <span className="display-chip">{note}</span>}
			<DisplayMarks id={id} compact={kind === "mini"} />
		</article>
	);
});

/** A link card in a list: its site's icon where a card's state is, its page's title, and where it is. */
const LinkItem = memo(function LinkItem({ id, shape, kind, selected, tier, enter }: ItemProps) {
	const links = useContext(ServicesContext)?.links;
	const url = shape.url ?? "";
	const host = linkHost(url);
	const { title } = linkText(shape);
	return (
		<article
			className={`display-item display-${kind === "mini" ? "mini" : "row"} display-plain link-tinted`}
			data-kind={kind}
			data-tier={tier}
			data-type="link"
			data-selected={selected}
			data-enter={enter || undefined}
			style={{ "--link-hue": linkHue(url) } as React.CSSProperties}
			aria-label={`${title}, ${host}`}
		>
			<span className="display-glyph" aria-hidden="true">
				<SiteIcon
					icon={readPreview(shape.preview)?.icon}
					host={host}
					imageSrc={links?.imageSrc}
					size="small"
				/>
			</span>
			<span className={kind === "mini" ? "display-mini-title" : "display-title"}>{title}</span>
			{tier === "full" && kind === "row" && <span className="display-chip">{host}</span>}
			<DisplayMarks id={id} compact={kind === "mini"} />
		</article>
	);
});

/** An image: a thumbnail and its alt text in a row; the picture itself in a mini card. */
const ImageItem = memo(function ImageItem({ id, shape, kind, selected, tier, enter }: ItemProps) {
	const src = useImageSrc(isImageHash(shape.image) ? shape.image : undefined);
	const title = shape.alt?.trim() || "Image";
	const picture = src && tier !== "far" && (
		<img className="display-image-file" src={src} alt="" draggable={false} decoding="async" />
	);
	return (
		<article
			className={`display-item display-${kind === "mini" ? "mini" : "row"} display-image`}
			data-kind={kind}
			data-tier={tier}
			data-type="image"
			data-selected={selected}
			data-enter={enter || undefined}
			aria-label={title}
		>
			<span className="display-image-thumb" aria-hidden="true">
				{picture}
			</span>
			<span className={kind === "mini" ? "display-mini-title" : "display-title"}>{title}</span>
			<DisplayMarks id={id} compact={kind === "mini"} />
		</article>
	);
});

const DECISION_STATUS: Record<string, string> = {
	proposed: "Proposed",
	decided: "Decided",
	superseded: "Superseded",
};

function describePlain(
	shape: ShapeProps,
	holds?: ItemProps["holds"],
): { glyph: string; title: string; note?: string } {
	if (shape.type === "text") return { glyph: "T", title: shape.text || "Empty text" };
	if (shape.type === "decision") {
		return {
			glyph: "◆",
			title: shape.title || "Untitled decision",
			note: DECISION_STATUS[shape.status ?? "proposed"],
		};
	}
	if (shape.type === "action") {
		// An action item: its tick (on the board; a linked one's issue decides), and who.
		return {
			glyph: shape.done ? "☑" : "☐",
			title: shape.text?.split("\n")[0] || "Action item",
			note: shape.owner ? `@${shape.owner.login}` : shape.due,
		};
	}
	if (shape.type === "stack") {
		// A stack (#73): its name (✨ while it's a suggestion) and what it
		// holds; it pops out as its theme card.
		return {
			glyph: nameState(shape) === "suggested" ? "✨" : "❐",
			title: stackName(shape) ?? UNTITLED_STACK,
			note: holds?.length ? countMembers(holds) : "Stack",
		};
	}
	if (shape.type === "widget") {
		const definition = widgetDefinition(shape.widget ?? "");
		const configured = (shape.config as { title?: unknown } | undefined)?.title;
		return {
			glyph: "▤",
			title:
				typeof configured === "string" && configured ? configured : (definition?.title ?? "Widget"),
			note: definition?.title,
		};
	}
	return { glyph: "·", title: shape.title || shape.text || shape.type };
}

/** Stamps and dots on a row, counted inline instead of hanging off the shape. */
function DisplayMarks({ id, compact = false }: { id: string; compact?: boolean }) {
	const marks = useContext(DisplayMarksContext);
	const readOnly = useContext(ReadOnlyContext);
	const counts = marks.stamps.get(id);
	const vote = marks.votes.length > 0 ? voteFor(marks.votes, marks.shapes, id, marks.now) : null;
	if (!counts && !vote) return null;
	const { doc, me } = marks;
	return (
		<span className="display-marks nodrag" data-compact={compact || undefined}>
			{vote &&
				me &&
				(compact ? (
					<DotCount vote={vote} id={id} me={me} />
				) : (
					<VoteDots vote={vote} shape={id} me={me} />
				))}
			{counts && (
				<StampRow
					counts={compact ? counts.slice(0, 1) : counts.slice(0, 3)}
					onToggle={readOnly || !doc || !me ? undefined : (emoji) => stampShape(doc, id, emoji, me)}
				/>
			)}
		</span>
	);
}

/** A mini card's dots, counted: yours alone while the vote hides the rest. */
function DotCount({ vote, id, me }: { vote: DotVote; id: string; me: Stamper }) {
	const mine = me.login ? `@${me.login.toLowerCase()}` : `~${me.name}`;
	const dotters = dottersOn(vote, id).filter((d) => !vote.hidden || d.key === mine);
	const total = dotters.reduce((n, d) => n + d.dots, 0);
	if (total === 0) return null;
	return (
		<span
			className="display-dot-count"
			data-mine={dotters.some((d) => d.key === mine) || undefined}
			aria-label={`${total} ${total === 1 ? "dot" : "dots"}`}
			style={{ "--dot": dotters[0]?.color || "var(--accent)" } as React.CSSProperties}
		>
			{total}
		</span>
	);
}
