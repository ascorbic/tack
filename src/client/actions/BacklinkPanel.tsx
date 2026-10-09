import { useEffect, useMemo, useRef, useState } from "react";
import { PUBLIC_AUDIENCE, groupByAudience, hiddenFrom } from "../../shared/backlinks.ts";
import { type Rect, intersects } from "../snapping.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import { LockIcon } from "./icons.tsx";
import { Notice, PopoverHead, SUBMIT_HINT } from "./Popover.tsx";
import { RepoName } from "./pickers.tsx";
import { type SelectedCard, count } from "./selection.ts";
import { renderSnapshot } from "./snapshot.ts";

// Backlinks (#33): comment on the selected cards' items with a link back to
// the board and a snapshot of the area around them. Each audience (everyone,
// or a private repository's readers) gets its own snapshot, with cards from
// other private repositories hidden, and the panel says so.

/** A card on the board, for deciding what each snapshot must hide. */
export interface BoardCard {
	shape: string;
	key: string;
	public: boolean;
	box: Rect;
}

interface Group {
	audience: string;
	items: SelectedCard[];
	/** Shapes hidden in this group's snapshot, and how many are in view. */
	hidden: Set<string>;
	hiddenInView: number;
}

type Render =
	| { status: "rendering" }
	| { status: "ready"; blob: Blob; url: string }
	| { status: "failed"; error: string };

export function BacklinkPanel({
	cards,
	boardCards,
	region,
	flow,
	sizeOf,
	isPublicItem,
	onStage,
}: {
	cards: SelectedCard[];
	/** Every card on the board, with where it is. */
	boardCards: BoardCard[];
	/** The area to draw, in board coordinates. */
	region: Rect;
	flow: () => HTMLElement | null;
	sizeOf: (id: string) => { width: number; height: number } | undefined;
	/** Whether a linked item (on a pull request card) is from a public repository. */
	isPublicItem: (key: string) => boolean;
	/** Upload the snapshots and stage the comments. Throws to show an error. */
	onStage: (
		groups: { items: SelectedCard[]; snapshot: Blob | null }[],
		note: string,
	) => Promise<void>;
}) {
	const groups = useMemo<Group[]>(() => {
		const audiences = groupByAudience(
			cards.map((c) => ({ ...c, public: c.card.visibility === "public" })),
		);
		return [...audiences].map(([audience, items]) => {
			const hiddenKeys = hiddenFrom(audience, boardCards);
			const hidden = new Set(boardCards.filter((c) => hiddenKeys.has(c.key)).map((c) => c.shape));
			const hiddenInView = boardCards.filter(
				(c) => hidden.has(c.shape) && intersects(c.box, region),
			).length;
			return { audience, items, hidden, hiddenInView };
		});
	}, [cards, boardCards, region]);

	const [renders, setRenders] = useState<Render[]>(() =>
		groups.map(() => ({ status: "rendering" })),
	);
	const [shown, setShown] = useState(0);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const urls = useRef<string[]>([]);

	// Draw each audience's snapshot in turn, once.
	useEffect(() => {
		let live = true;
		void (async () => {
			// Let the panel open first, so drawing doesn't hold up its animation.
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)));
			for (const [i, group] of groups.entries()) {
				if (!live) return;
				const element = flow();
				let result: Render;
				try {
					if (!element) throw new Error("The board isn’t showing");
					const blob = await renderSnapshot({
						flow: element,
						region,
						hidden: group.hidden,
						sizeOf,
						hideLinked: (key) =>
							!isPublicItem(key) &&
							(group.audience === PUBLIC_AUDIENCE || repoKeyOf(key) !== group.audience),
					});
					const url = URL.createObjectURL(blob);
					urls.current.push(url);
					result = { status: "ready", blob, url };
				} catch (cause) {
					result = {
						status: "failed",
						error: cause instanceof Error ? cause.message : "The snapshot couldn’t be drawn.",
					};
				}
				if (!live) return;
				setRenders((current) => current.map((r, j) => (j === i ? result : r)));
			}
		})();
		return () => {
			live = false;
		};
		// Drawn once, for the selection the panel opened with.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), []);

	const current = renders[shown] ?? renders[0];
	const group = groups[shown] ?? groups[0];
	const rendering = renders.some((r) => r.status === "rendering");
	const failed = renders.some((r) => r.status === "failed");

	const stage = async (withSnapshot: boolean) => {
		setBusy(true);
		setError(null);
		try {
			await onStage(
				groups.map((g, i) => {
					const render = renders[i];
					return {
						items: g.items,
						snapshot: withSnapshot && render?.status === "ready" ? render.blob : null,
					};
				}),
				note,
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Something went wrong.");
			setBusy(false);
		}
	};

	return (
		<form
			className="backlink-panel"
			onSubmit={(event) => {
				event.preventDefault();
				if (!busy && !rendering) void stage(!failed);
			}}
		>
			<PopoverHead
				title={`Comment on ${count(cards.length, "item")}`}
				detail="A link back to this board, with a snapshot of this area."
			/>
			{groups.length > 1 && (
				<div className="backlink-tabs" role="tablist" aria-label="Snapshots">
					{groups.map((g, i) => (
						<button
							key={g.audience}
							type="button"
							role="tab"
							aria-selected={i === shown}
							onClick={() => setShown(i)}
						>
							{g.audience === PUBLIC_AUDIENCE ? (
								"Public repositories"
							) : (
								<>
									<LockIcon size={12} />
									<RepoName repo={g.audience} />
								</>
							)}
						</button>
					))}
				</div>
			)}
			<figure className="backlink-snapshot" data-status={current?.status}>
				{current?.status === "ready" ? (
					<img
						key={current.url}
						src={current.url}
						alt="Snapshot of the board around the selection"
					/>
				) : current?.status === "failed" ? (
					<figcaption>{current.error}</figcaption>
				) : (
					<span className="backlink-shimmer" aria-label="Drawing the snapshot" />
				)}
			</figure>
			{group && group.hiddenInView > 0 && (
				<Notice icon={<LockIcon />}>
					{group.hiddenInView === 1
						? "A card from a private repository is hidden"
						: `${group.hiddenInView} cards from private repositories are hidden`}{" "}
					in this image
					{group.audience === PUBLIC_AUDIENCE
						? ", since the comment is public."
						: ", since its readers may not see them."}
				</Notice>
			)}
			<label className="action-field">
				<span>Note</span>
				<textarea
					data-autofocus
					rows={2}
					value={note}
					placeholder="Add a note (optional)"
					onChange={(event) => setNote(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
				/>
			</label>
			{error && <Notice tone="error">{error}</Notice>}
			<footer className="action-foot">
				{failed && !rendering ? (
					<button
						type="button"
						className="action-secondary"
						disabled={busy}
						onClick={() => void stage(false)}
					>
						Stage without the snapshot
					</button>
				) : (
					<span className="action-summary">
						{groups.length > 1 ? `${groups.length} snapshots` : "Not written until pushed."}
					</span>
				)}
				<button type="submit" className="action-primary" disabled={busy || rendering || failed}>
					{busy
						? "Uploading…"
						: `Stage ${cards.length === 1 ? "comment" : `${cards.length} comments`}`}
					<kbd>{SUBMIT_HINT}</kbd>
				</button>
			</footer>
		</form>
	);
}
