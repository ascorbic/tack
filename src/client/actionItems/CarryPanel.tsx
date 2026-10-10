import { useEffect, useId, useMemo, useState } from "react";
import type * as Y from "yjs";
import { actionState, carryable } from "../../shared/actionItems.ts";
import type { BoardInfo, CarryResponse } from "../../shared/boards.ts";
import { readShapes } from "../../shared/structure.ts";
import { cardStore } from "../cardStore.ts";
import { CheckIcon } from "../actions/icons.tsx";
import { SearchField, useActive } from "../actions/pickers.tsx";
import { Notice, PopoverHead } from "../actions/Popover.tsx";
import { count } from "../actions/selection.ts";
import type { WriteServices } from "../actions/services.ts";
import { relativeTime } from "../boards/api.ts";
import { BoardThumbnail } from "../boards/BoardThumbnail.tsx";
import { CarryIcon } from "./icons.tsx";

// Carry over (#52): take open action items to another board, such as the
// next retro, with their owners, due dates and links. The board's server
// copies them (POST /api/boards/:id/carry), into the other board's actions
// section, remembering where they came from; carrying twice doesn't double
// up.

const SHOWN = 4;

/** The open action items on a board (or just `only` of them), as this viewer sees their issues. */
export function openActionItems(
	doc: Y.Doc,
	only?: Iterable<string>,
): { id: string; text: string }[] {
	return carryable(
		readShapes(doc),
		(shape) => actionState(shape, shape.ref ? cardStore.get(shape.ref) : undefined),
		only ? new Set(only) : undefined,
	).map((item) => ({ id: item.id, text: item.text }));
}

export function CarryPanel({
	items,
	services,
	onCarried,
}: {
	/** The open action items going over (only these shapes are sent when `only`). */
	items: { id: string; text: string }[];
	services: WriteServices;
	onCarried: (result: CarryResponse) => void;
}) {
	const [boards, setBoards] = useState<BoardInfo[] | null | "failed">(null);
	const [query, setQuery] = useState("");
	const [chosen, setChosen] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const listId = useId();

	useEffect(() => {
		let live = true;
		void services.carryTargets?.().then((list) => {
			if (live) setBoards(list ?? "failed");
		});
		return () => {
			live = false;
		};
	}, [services]);

	const words = query.trim().toLowerCase();
	const shown = useMemo(
		() =>
			Array.isArray(boards)
				? boards.filter((board) => !words || board.title.toLowerCase().includes(words))
				: [],
		[boards, words],
	);
	const { active, setActive, onKey } = useActive(shown.length);
	const target = shown.find((board) => board.id === chosen) ?? null;

	const carry = async () => {
		if (!target || !services.carryOver || items.length === 0) return;
		setSending(true);
		setError(null);
		const result = await services.carryOver(
			target.id,
			items.map((item) => item.id),
		);
		setSending(false);
		if ("error" in result) {
			setError(
				result.error === "forbidden"
					? `You can’t edit “${target.title}”.`
					: "Couldn’t carry them over just now. Try again?",
			);
			return;
		}
		onCarried(result);
	};

	return (
		<>
			<PopoverHead
				title="Carry over"
				detail={`${count(items.length, "open action item")}, with owners, due dates and issues`}
			/>
			<ul className="carry-list">
				{items.slice(0, SHOWN).map((item, i) => (
					<li key={item.id} style={{ "--i": i } as React.CSSProperties}>
						{item.text.split("\n")[0] || "An action item with nothing written yet"}
					</li>
				))}
				{items.length > SHOWN && (
					<li style={{ "--i": SHOWN } as React.CSSProperties}>and {items.length - SHOWN} more</li>
				)}
			</ul>
			<SearchField
				label="Board to carry them to"
				listId={listId}
				value={query}
				onChange={(next) => {
					setQuery(next);
					setActive(0);
				}}
				placeholder="Which board? The next retro, say"
				activeId={active >= 0 ? `${listId}-${active}` : undefined}
				autoFocus
				onKeyDown={(event) => {
					if (onKey(event)) return;
					if (event.key === "Enter") {
						event.preventDefault();
						const board = shown[active];
						if (board && board.id !== chosen) setChosen(board.id);
						else void carry();
					}
				}}
			/>
			{boards === null ? (
				<div className="action-loading" aria-busy="true">
					<span className="action-skeleton" />
					<span className="action-skeleton" />
					<span className="action-skeleton short" />
				</div>
			) : boards === "failed" ? (
				<Notice tone="warn">Couldn’t load your boards. Try again in a moment.</Notice>
			) : (
				<div className="action-list carry-boards" role="listbox" id={listId} aria-label="Boards">
					{shown.length === 0 && (
						<p className="action-empty">
							{words
								? `No boards you can edit called “${query.trim()}”.`
								: "No other boards you can edit yet. Make the next one from a template, then carry these over."}
						</p>
					)}
					{shown.map((board, i) => (
						<button
							key={board.id}
							id={`${listId}-${i}`}
							type="button"
							role="option"
							aria-selected={board.id === chosen}
							data-active={i === active}
							className="action-option"
							onPointerEnter={() => setActive(i)}
							onClick={() => setChosen(board.id)}
						>
							<span className="carry-board-thumb" aria-hidden="true">
								<BoardThumbnail thumbnail={board.thumbnail} />
							</span>
							<span className="action-option-stack">
								<span className="action-option-name">{board.title}</span>
								<span className="action-option-detail">
									Updated {relativeTime(board.updatedAt)}
								</span>
							</span>
							<span className="action-check" aria-hidden="true">
								{board.id === chosen && <CheckIcon />}
							</span>
						</button>
					))}
				</div>
			)}
			{error && <Notice tone="error">{error}</Notice>}
			<div className="action-foot">
				<span className="action-summary">{target ? `To “${target.title}”` : "Pick a board"}</span>
				<button
					type="button"
					className="action-primary"
					disabled={!target || sending || items.length === 0}
					aria-busy={sending}
					onClick={() => void carry()}
				>
					<CarryIcon />
					{sending ? "Carrying…" : `Carry ${items.length === 1 ? "it" : items.length} over`}
				</button>
			</div>
		</>
	);
}
