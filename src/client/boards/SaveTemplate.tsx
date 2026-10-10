import { useEffect, useId, useRef, useState } from "react";
import type { BoardInfo } from "../../shared/boards.ts";
import {
	TEMPLATE_DESCRIPTION_MAX,
	TEMPLATE_TITLE_MAX,
	type TemplateInfo,
} from "../../shared/templates.ts";
import { MoreIcon } from "./icons.tsx";
import { Modal } from "./Modal.tsx";
import { templateLibrary, templatesApi } from "./templates.ts";
import "./templates.css";

// Saving a board as a template (#53), from the board's menu beside Share.
// The server keeps its structure (or everything, if asked) for everyone on
// the instance to start boards from, with the repositories its widgets,
// inboxes and rules read as choices to make.

/** The board's menu: things to do with the whole board. */
export function BoardMenu({ board }: { board: BoardInfo }) {
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("pointerdown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div className="board-menu" ref={root}>
			<button
				type="button"
				className="board-menu-button"
				aria-label="Board menu"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<MoreIcon />
			</button>
			{open && (
				<div className="board-menu-list" role="menu">
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							setSaving(true);
						}}
					>
						<TemplateIcon />
						Save as template…
					</button>
				</div>
			)}
			<SaveTemplateDialog board={board} open={saving} onClose={() => setSaving(false)} />
		</div>
	);
}

function TemplateIcon() {
	return (
		<svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<rect x="2" y="2.5" width="12" height="11" rx="2" />
			<path d="M2 6h12M6 6v7.5" />
		</svg>
	);
}

export function SaveTemplateDialog({
	board,
	open,
	onClose,
}: {
	board: BoardInfo;
	open: boolean;
	onClose: () => void;
}) {
	const headingId = useId();
	return (
		<Modal open={open} onClose={onClose} className="save-template-dialog" labelledBy={headingId}>
			{(close) => <SaveTemplatePanel board={board} headingId={headingId} onClose={close} />}
		</Modal>
	);
}

export function SaveTemplatePanel({
	board,
	headingId,
	onClose,
	save = templatesApi.save,
	initialSaved = null,
}: {
	board: Pick<BoardInfo, "id" | "title">;
	headingId?: string;
	onClose: () => void;
	/** Where it's saved; the gallery passes its own. */
	save?: typeof templatesApi.save;
	initialSaved?: TemplateInfo | null;
}) {
	const [title, setTitle] = useState(board.title);
	const [description, setDescription] = useState("");
	const [keepContent, setKeepContent] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState<TemplateInfo | null>(initialSaved);
	const titleId = useId();
	const descriptionId = useId();

	if (saved) {
		return (
			<div className="save-template save-template-done" role="status">
				<svg viewBox="0 0 56 56" aria-hidden="true">
					<circle cx="28" cy="28" r="26" />
					<path d="m17 29 7.5 7.5L39.5 21" pathLength="1" />
				</svg>
				<h2 id={headingId}>Saved as a template</h2>
				<p>
					“{saved.title}” is in New board, under Saved on this Tack, for everyone here to start
					from.
				</p>
				<div className="new-board-actions-end">
					<button type="button" className="new-board-cancel" onClick={onClose}>
						Done
					</button>
					<a
						className="primary new-board-create"
						href={`/?template=${encodeURIComponent(saved.id)}`}
					>
						Make a board from it
					</a>
				</div>
			</div>
		);
	}

	const submit = async () => {
		if (!title.trim() || saving) return;
		setSaving(true);
		setError(null);
		const result = await save({
			board: board.id,
			title: title.trim(),
			...(description.trim() ? { description: description.trim() } : {}),
			keepContent,
		});
		setSaving(false);
		if (result.ok) {
			templateLibrary.added(result.value);
			setSaved(result.value);
			return;
		}
		setError(
			result.error === "too_large"
				? "This board is too big to save as a template. Try without the stickies and cards."
				: result.error === "forbidden"
					? "Only people who can edit this board can save it as a template."
					: "Couldn’t save it just now. Try again?",
		);
	};

	return (
		<form
			className="save-template"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<h2 id={headingId}>Save as template</h2>
			<p className="save-template-lede">
				Everyone on this Tack can start boards from it. The repositories its widgets, inboxes and
				rules read become choices to make each time.
			</p>
			<label className="new-board-field" htmlFor={titleId}>
				<span>Name</span>
				<input
					id={titleId}
					value={title}
					maxLength={TEMPLATE_TITLE_MAX}
					onChange={(event) => setTitle(event.target.value)}
				/>
			</label>
			<label className="new-board-field" htmlFor={descriptionId}>
				<span>What it’s for</span>
				<textarea
					id={descriptionId}
					value={description}
					maxLength={TEMPLATE_DESCRIPTION_MAX}
					placeholder="Our fortnightly retro: what went well, what to fix, who’s doing what."
					onChange={(event) => setDescription(event.target.value)}
				/>
			</label>
			<label className="save-template-keep">
				<input
					type="checkbox"
					checked={keepContent}
					onChange={(event) => setKeepContent(event.target.checked)}
				/>
				<span>
					Keep stickies, cards and action items
					<small>
						Otherwise just its sections, text, widgets and rules. Votes and silent sections become
						steps ready to start.
					</small>
				</span>
			</label>
			{error && (
				<p className="new-board-error" role="alert">
					{error}
				</p>
			)}
			<div className="new-board-actions-end">
				<button type="button" className="new-board-cancel" onClick={onClose}>
					Cancel
				</button>
				<button
					type="submit"
					className="primary new-board-create"
					disabled={!title.trim() || saving}
					aria-busy={saving}
				>
					{saving ? (
						<>
							<span className="new-board-spinner" aria-hidden="true" />
							Saving…
						</>
					) : (
						"Save template"
					)}
				</button>
			</div>
		</form>
	);
}
