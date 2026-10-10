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
// the board. A snapshot of the area around them is opt-in, and the choice is
// remembered per board. With one, each audience (everyone, or a private
// repository's readers) gets its own image, with cards from other private
// repositories hidden, and the panel says so. Nothing is drawn or uploaded
// unless a snapshot is asked for.

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
	| { status: "idle" }
	| { status: "rendering" }
	| { status: "ready"; blob: Blob; url: string }
	| { status: "failed"; error: string };

const PREFERENCE_KEY = "tack.backlinkSnapshot.";

/** Whether this person last asked for snapshots on this board. Off unless they did. */
export function snapshotPreference(boardId: string): boolean {
	try {
		return localStorage.getItem(PREFERENCE_KEY + boardId) === "on";
	} catch {
		return false;
	}
}

function rememberSnapshotPreference(boardId: string, on: boolean) {
	try {
		if (on) localStorage.setItem(PREFERENCE_KEY + boardId, "on");
		else localStorage.removeItem(PREFERENCE_KEY + boardId);
	} catch {
		// Private windows and blocked storage: it just isn't remembered.
	}
}

export function BacklinkPanel({
	cards,
	boardCards,
	region,
	flow,
	sizeOf,
	isPublicItem,
	onStage,
	draw,
	boardId,
	snapshot: initialSnapshot,
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
	/** Draw an audience's snapshot some other way (the gallery does). */
	draw?: (audience: string) => Promise<Blob>;
	/** The board, to remember whether this person includes snapshots on it. */
	boardId?: string;
	/** Start with the snapshot on or off, whatever was remembered (the gallery does). */
	snapshot?: boolean;
	/** Upload any snapshots and stage the comments. Throws to show an error. */
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

	const [include, setInclude] = useState(
		() => initialSnapshot ?? (boardId ? snapshotPreference(boardId) : false),
	);
	const [renders, setRenders] = useState<Render[]>(() => groups.map(() => ({ status: "idle" })));
	const [shown, setShown] = useState(0);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const urls = useRef<string[]>([]);
	const started = useRef(false);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	// Draw each audience's snapshot in turn, once, the first time one's asked
	// for: of the selection the panel opened with.
	useEffect(() => {
		if (!include || started.current) return;
		started.current = true;
		setRenders((current) => current.map(() => ({ status: "rendering" })));
		void (async () => {
			// Let the panel open (or the snapshot unfold) first, so drawing
			// doesn't hold up the animation.
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60)));
			for (const [i, group] of groups.entries()) {
				if (!alive.current) return;
				let result: Render;
				try {
					const element = flow();
					if (!draw && !element) throw new Error("The board isn’t showing");
					const blob = draw
						? await draw(group.audience)
						: await renderSnapshot({
								flow: element as HTMLElement,
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
				if (!alive.current) return;
				setRenders((current) => current.map((r, j) => (j === i ? result : r)));
			}
		})();
		// Drawn once, for the selection the panel opened with.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [include]);
	useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), []);

	const toggle = (on: boolean) => {
		setInclude(on);
		if (boardId) rememberSnapshotPreference(boardId, on);
	};

	const current = renders[shown] ?? renders[0];
	const group = groups[shown] ?? groups[0];
	const rendering = include && renders.some((r) => r.status === "rendering" || r.status === "idle");
	const failed = include && renders.some((r) => r.status === "failed");

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
				if (!busy && !rendering) void stage(include && !failed);
			}}
		>
			<PopoverHead
				title={`Comment on ${count(cards.length, "item")}`}
				detail={
					include
						? "A link back to this board, with a snapshot of this area."
						: "A link back to this board."
				}
			/>
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
			<label className="backlink-include">
				<input
					type="checkbox"
					checked={include}
					disabled={busy}
					onChange={(event) => toggle(event.target.checked)}
				/>
				<span className="backlink-switch" aria-hidden="true" />
				<span>Include a snapshot of the board</span>
			</label>
			{/* Unfolds when a snapshot's asked for; stays mounted so it can fold away again. */}
			<div className="backlink-snapshot-area" data-open={include || undefined} inert={!include}>
				<div>
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
						) : current?.status === "rendering" ? (
							<span className="backlink-shimmer" aria-label="Drawing the snapshot" />
						) : null}
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
				</div>
			</div>
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
						{include && groups.length > 1
							? `${groups.length} snapshots`
							: "Not written until pushed."}
					</span>
				)}
				<button type="submit" className="action-primary" disabled={busy || rendering || failed}>
					{busy
						? include
							? "Uploading…"
							: "Staging…"
						: `Stage ${cards.length === 1 ? "comment" : `${cards.length} comments`}`}
					<kbd>{SUBMIT_HINT}</kbd>
				</button>
			</footer>
		</form>
	);
}
