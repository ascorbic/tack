import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_TITLE, cleanTitle } from "../../shared/boards.ts";

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
	const [editing, setEditing] = useState(startEditing && editable);
	const [draft, setDraft] = useState(title);
	const [saving, setSaving] = useState(false);
	const field = useRef<HTMLInputElement>(null);
	const sizer = useRef<HTMLSpanElement>(null);
	const [width, setWidth] = useState<number | null>(null);

	useEffect(() => {
		if (!editing) setDraft(title);
	}, [title, editing]);

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
			<h1 className="board-title" data-editable="false">
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
					onBlur={() => void commit()}
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
					title="Rename"
					onClick={() => {
						cancelled.current = false;
						setEditing(true);
					}}
				>
					{title}
				</button>
			)}
		</h1>
	);
}
