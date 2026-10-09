import { type CSSProperties, useEffect, useRef, useState } from "react";
import { type BoardInfo, boardPath, canEdit, cleanTitle, MAX_TITLE } from "../../shared/boards.ts";
import { personUser } from "../auth/me.ts";
import { Avatar } from "../People.tsx";
import { boardUrlFor, relativeTime } from "./api.ts";
import { BoardThumbnail } from "./BoardThumbnail.tsx";
import { MoreIcon, VISIBILITY_LABEL, VisibilityIcon } from "./icons.tsx";

/** Which time a tile shows: when it changed, when you opened it, or when it was archived. */
export type TileTime = "updated" | "visited" | "archived";

export interface TileActions {
	rename: (board: BoardInfo, title: string) => Promise<boolean>;
	archive: (board: BoardInfo, archived: boolean) => Promise<boolean>;
}

const AVATARS = 3;

/**
 * A board on the home page: its thumbnail, title, who's on it and when it
 * last changed. The whole tile opens the board; the "…" menu renames,
 * copies the link, or archives it.
 */
export function BoardTile({
	board,
	time = "updated",
	actions,
	index = 0,
	now,
}: {
	board: BoardInfo;
	time?: TileTime;
	actions?: TileActions;
	/** Position in the grid, to stagger the entrance. */
	index?: number;
	/** For stable relative times in the gallery. */
	now?: number;
}) {
	const [renaming, setRenaming] = useState(false);
	const [title, setTitle] = useState(board.title);
	useEffect(() => setTitle(board.title), [board.title]);

	const at =
		time === "visited"
			? (board.visitedAt ?? board.updatedAt)
			: time === "archived"
				? (board.archivedAt ?? board.updatedAt)
				: board.updatedAt;
	const verb = time === "visited" ? "Opened" : time === "archived" ? "Archived" : "Edited";
	const shown = board.members.slice(0, AVATARS);
	const more = board.memberCount - shown.length;

	const rename = async (next: string) => {
		setRenaming(false);
		const clean = cleanTitle(next);
		if (!actions || clean === board.title) return;
		setTitle(clean);
		if (!(await actions.rename(board, clean))) setTitle(board.title);
	};

	return (
		<article
			className="board-tile"
			data-archived={board.archivedAt !== null || undefined}
			style={{ "--i": Math.min(index, 12) } as CSSProperties}
		>
			<div className="board-thumb">
				<BoardThumbnail thumbnail={board.thumbnail} />
			</div>
			<div className="board-tile-body">
				{renaming ? (
					<RenameField
						title={title}
						onDone={(next) => void rename(next)}
						onCancel={() => setRenaming(false)}
					/>
				) : (
					<h3 className="board-tile-title">
						<a className="board-tile-link" href={boardPath(board)}>
							{title}
						</a>
					</h3>
				)}
				<div className="board-tile-meta">
					<span className="board-tile-visibility" title={VISIBILITY_LABEL[board.visibility]}>
						<VisibilityIcon visibility={board.visibility} size={14} />
						<span className="visually-hidden">{VISIBILITY_LABEL[board.visibility]}</span>
					</span>
					<span className="board-tile-time">
						{verb} {relativeTime(at, now)}
					</span>
					{shown.length > 0 && (
						<span
							className="board-tile-people"
							aria-label={`${board.memberCount} ${board.memberCount === 1 ? "person" : "people"}`}
						>
							{shown.map((person) => (
								<Avatar key={person.id} user={personUser(person)} />
							))}
							{more > 0 && <span className="avatar avatar-more">+{more}</span>}
						</span>
					)}
				</div>
			</div>
			{actions && (canEdit(board.role) || board.canManage) && (
				<TileMenu board={board} actions={actions} onRename={() => setRenaming(true)} />
			)}
		</article>
	);
}

function RenameField({
	title,
	onDone,
	onCancel,
}: {
	title: string;
	onDone: (title: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(title);
	const field = useRef<HTMLInputElement>(null);
	const cancelled = useRef(false);
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);
	return (
		<input
			ref={field}
			className="board-tile-rename"
			aria-label="Board title"
			value={value}
			maxLength={MAX_TITLE}
			onChange={(event) => setValue(event.target.value)}
			onBlur={() => (cancelled.current ? onCancel() : onDone(value))}
			onKeyDown={(event) => {
				if (event.key === "Enter") field.current?.blur();
				if (event.key === "Escape") {
					cancelled.current = true;
					field.current?.blur();
				}
			}}
		/>
	);
}

function TileMenu({
	board,
	actions,
	onRename,
}: {
	board: BoardInfo;
	actions: TileActions;
	onRename: () => void;
}) {
	const [state, setState] = useState<"open" | "closing" | "closed">("closed");
	const [copied, setCopied] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);

	const close = (focus = false) => {
		setState((current) => (current === "open" ? "closing" : current));
		if (focus) trigger.current?.focus();
	};

	useEffect(() => {
		if (state !== "open") return;
		const onPointer = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) close();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") close(true);
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [state]);

	const archived = board.archivedAt !== null;
	return (
		<div className="board-tile-menu" ref={root} data-open={state !== "closed" || undefined}>
			<button
				ref={trigger}
				type="button"
				className="board-tile-more"
				aria-label={`More for ${board.title}`}
				aria-haspopup="menu"
				aria-expanded={state === "open"}
				onClick={() => setState(state === "open" ? "closing" : "open")}
			>
				<MoreIcon />
			</button>
			{state !== "closed" && (
				<div
					className="board-menu"
					role="menu"
					data-state={state}
					onAnimationEnd={() => {
						if (state === "closing") setState("closed");
					}}
				>
					{canEdit(board.role) && (
						<button
							type="button"
							role="menuitem"
							className="board-menu-item"
							onClick={() => {
								close();
								onRename();
							}}
						>
							Rename
						</button>
					)}
					<button
						type="button"
						role="menuitem"
						className="board-menu-item"
						onClick={() => {
							void navigator.clipboard?.writeText(boardUrlFor(board)).then(() => {
								setCopied(true);
								setTimeout(() => {
									setCopied(false);
									close();
								}, 700);
							});
						}}
					>
						{copied ? "Link copied" : "Copy link"}
					</button>
					{board.canManage && (
						<button
							type="button"
							role="menuitem"
							className="board-menu-item"
							onClick={() => {
								close();
								void actions.archive(board, !archived);
							}}
						>
							{archived ? "Restore" : "Archive"}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
