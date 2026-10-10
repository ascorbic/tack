import { useCallback, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import {
	describeProvenance,
	keepCard,
	provenanceOf,
	provenanceSourceName,
	unmatchedSince,
} from "../shared/provenance.ts";
import type { ShapeProps } from "../shared/shapes.ts";
import type { Provenance } from "../shared/widgets.ts";
import { deleteShapes } from "./board.ts";
import { transactLocal } from "./undo.ts";
import "./provenance.css";

// How a card arrived, shown on the card (#41): nothing for cards people
// placed; a small glyph for ones a list, an inbox, a rule or a comment on
// the forge brought, which opens out into a label when you point at it (a
// comment's opens the comment, too); and, for a card that no
// longer matches its inbox or rule, a band along its foot that says so,
// with the choice to keep it or remove it. Nothing is ever removed for you.

/** What a card shows about where it came from. */
export interface CardOrigin {
	via: Exclude<Provenance["via"], "manual">;
	/** "From the “Triage” inbox". */
	label: string;
	/** Where to read more: the comment that asked for a card from a forge (#58). */
	href?: string;
}

/** A card that no longer matches what brought it, and what can be done about it. */
export interface CardUnmatched {
	/** "No longer matches the “Triage” inbox". */
	text: string;
	/** Absent on boards you can't edit. */
	onKeep?: () => void;
	onRemove?: () => void;
}

/**
 * A card's origin and unmatched state, kept current as the inbox, list or
 * rule that brought it is renamed. Cards people placed subscribe to nothing.
 */
export function useCardProvenance(
	doc: Y.Doc | null,
	id: string,
	shape: Pick<ShapeProps, "provenance" | "unmatched">,
	readOnly: boolean,
): { origin: CardOrigin | null; unmatched: CardUnmatched | null } {
	const provenance = provenanceOf(shape);
	const tracked = provenance.via !== "manual" && doc !== null;
	const subscribe = useCallback(
		(listener: () => void) => {
			if (!tracked || !doc) return () => {};
			doc.on("afterTransaction", listener);
			return () => doc.off("afterTransaction", listener);
		},
		[doc, tracked],
	);
	const name = useSyncExternalStore(subscribe, () =>
		tracked && doc ? provenanceSourceName(doc, provenance) : null,
	);
	const text = describeProvenance(provenance, name);
	if (!text || provenance.via === "manual") return { origin: null, unmatched: null };
	const since = unmatchedSince(shape);
	return {
		origin: {
			via: provenance.via,
			label: text.label,
			...(provenance.via === "comment" ? { href: provenance.source } : {}),
		},
		unmatched:
			since && doc
				? {
						text: text.unmatched,
						...(readOnly
							? {}
							: {
									onKeep: () => transactLocal(doc, () => keepCard(doc, id)),
									onRemove: () => deleteShapes(doc, [id]),
								}),
					}
				: null,
	};
}

export function ProvenanceIcon({ via }: { via: CardOrigin["via"] }) {
	return (
		<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="provenance-icon">
			{via === "inbox" ? (
				// A tray.
				<>
					<path d="M2.5 9.5 4.2 3.8a1 1 0 0 1 1-.8h5.6a1 1 0 0 1 1 .8l1.7 5.7" />
					<path d="M2.5 9.5V12a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9.5h-3.2a2.3 2.3 0 0 1-4.6 0z" />
				</>
			) : via === "list" ? (
				// Rows of a list.
				<>
					<circle cx="3.5" cy="4.5" r="0.9" className="fill" />
					<circle cx="3.5" cy="8" r="0.9" className="fill" />
					<circle cx="3.5" cy="11.5" r="0.9" className="fill" />
					<path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h5" />
				</>
			) : via === "comment" ? (
				// An @: someone mentioned the app in a comment on the forge.
				<>
					<circle cx="8" cy="8" r="2.4" />
					<path d="M10.4 8v.9a1.8 1.8 0 0 0 3.6 0V8a6 6 0 1 0-2.4 4.8" />
				</>
			) : (
				// A spark: placed by a rule.
				<path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.2 4.2l1.8 1.8M10 10l1.8 1.8M11.8 4.2 10 6M6 10l-1.8 1.8" />
			)}
		</svg>
	);
}

/** The glyph in a card's foot, opening into its label on hover or focus. */
export function ProvenanceBadge({ origin }: { origin: CardOrigin }) {
	if (origin.href) {
		// A link to the comment that asked for it, opening in a new tab. It
		// mustn't pick the card up.
		return (
			<a
				className="provenance nodrag"
				data-via={origin.via}
				href={origin.href}
				target="_blank"
				rel="noreferrer"
				aria-label={origin.label}
				onPointerDown={(event) => event.stopPropagation()}
			>
				<ProvenanceIcon via={origin.via} />
				<span className="provenance-label" aria-hidden="true">
					<span>{origin.label}</span>
				</span>
			</a>
		);
	}
	return (
		<span
			className="provenance"
			data-via={origin.via}
			tabIndex={0}
			role="note"
			aria-label={origin.label}
		>
			<ProvenanceIcon via={origin.via} />
			<span className="provenance-label" aria-hidden="true">
				<span>{origin.label}</span>
			</span>
		</span>
	);
}

/** Along a card's foot: it no longer matches, so people decide. */
export function UnmatchedBand({ unmatched }: { unmatched: CardUnmatched }) {
	return (
		<div className="card-unmatched" role="status">
			<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
				<path d="M2.5 3.5h11l-4.2 5v4.3l-2.6 1v-5.3z" />
				<path d="M2 14 14 2" className="strike" />
			</svg>
			{/* Too narrow to name the inbox or rule: the glyph above does, and the tooltip. */}
			<span className="card-unmatched-text" title={unmatched.text}>
				<span aria-hidden="true">No longer matches</span>
				<span className="visually-hidden">{unmatched.text}</span>
			</span>
			{unmatched.onKeep && (
				<span className="card-unmatched-actions">
					<button type="button" className="nodrag" onClick={unmatched.onKeep}>
						Keep
					</button>
					<button type="button" className="nodrag" data-tone="remove" onClick={unmatched.onRemove}>
						Remove
					</button>
				</span>
			)}
		</div>
	);
}
