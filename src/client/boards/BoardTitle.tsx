import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_TITLE, cleanTitle } from "../../shared/boards.ts";

/** How long a just-created board's title keeps focus while the board mounts. */
const SETTLE_MS = 1500;

/**
 * The board's title in the top bar. Anyone who can edit renames it in
 * place: click, type, Enter (Escape puts it back). The field grows with
 * the text, so it reads as the same title, just editable.
 */
export function BoardTitle({
	title,
	editable,
	onRename,
	startEditing = false,
}: {
	title: string;
	editable: boolean;
	/** Resolves once saved; rejects to put the old title back. */
	onRename: (title: string) => Promise<void>;
	/** Start with the title selected, for a board that was just created. */
	startEditing?: boolean;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title);
	const [saving, setSaving] = useState(false);
	const field = useRef<HTMLInputElement>(null);
	const sizer = useRef<HTMLSpanElement>(null);
	const [width, setWidth] = useState<number | null>(null);

	useEffect(() => {
		if (!editing) setDraft(title);
	}, [title, editing]);

	// A just-created board starts with its title selected, as soon as the
	// title can be edited (access may arrive after the first render).
	const started = useRef(false);
	useEffect(() => {
		if (!startEditing || !editable || started.current) return;
		started.current = true;
		settleUntil.current = performance.now() + SETTLE_MS;
		setEditing(true);
	}, [startEditing, editable]);

	// While the board is still mounting, something else can take focus
	// (the canvas, a toolbar). Until the person acts, or the board settles,
	// take it back rather than treating that as finishing the edit.
	const settleUntil = useRef(0);
	useEffect(() => {
		const acted = () => {
			settleUntil.current = 0;
		};
		window.addEventListener("pointerdown", acted, true);
		window.addEventListener("keydown", acted, true);
		return () => {
			window.removeEventListener("pointerdown", acted, true);
			window.removeEventListener("keydown", acted, true);
		};
	}, []);

	useEffect(() => {
		if (!editing) return;
		field.current?.focus();
		field.current?.select();
	}, [editing]);

	// Size the field to its text, measured from a hidden twin.
	useLayoutEffect(() => {
		if (sizer.current) setWidth(sizer.current.offsetWidth);
	}, [draft, editing]);

	const cancelled = useRef(false);

	const commit = async () => {
		if (!editing) return;
		const next = cleanTitle(draft);
		setEditing(false);
		if (cancelled.current) {
			cancelled.current = false;
			setDraft(title);
			return;
		}
		if (next === title) return;
		setSaving(true);
		try {
			await onRename(next);
		} catch {
			setDraft(title);
		} finally {
			setSaving(false);
		}
	};

	if (!editable) {
		return (
			<h1 className="board-title" data-editable="false" title={title}>
				{title}
			</h1>
		);
	}

	return (
		<h1 className="board-title" data-editable="true" data-saving={saving || undefined}>
			<span className="board-title-sizer" ref={sizer} aria-hidden="true">
				{(editing ? draft : title) || " "}
			</span>
			{editing ? (
				<input
					ref={field}
					className="board-title-field"
					aria-label="Board title"
					value={draft}
					maxLength={MAX_TITLE}
					style={width ? { width: width + 2 } : undefined}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={(event) => {
						if (!event.relatedTarget && performance.now() < settleUntil.current) {
							const input = event.currentTarget;
							requestAnimationFrame(() => {
								input.focus();
								input.select();
							});
							return;
						}
						void commit();
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							field.current?.blur();
						} else if (event.key === "Escape") {
							cancelled.current = true;
							field.current?.blur();
						}
					}}
				/>
			) : (
				<button
					type="button"
					className="board-title-button"
					// The whole title, when it's cut short.
					data-tooltip={title.length > 28 ? `${title}\nClick to rename` : "Click to rename"}
					onClick={() => {
						cancelled.current = false;
						setEditing(true);
					}}
				>
					<span className="board-title-text">{title}</span>
					<svg
						className="board-title-pencil icon"
						width="13"
						height="13"
						viewBox="0 0 16 16"
						aria-hidden="true"
					>
						<path d="M10.75 2.75l2.5 2.5L6 12.5l-3.25.75L3.5 10z" />
					</svg>
				</button>
			)}
		</h1>
	);
}
