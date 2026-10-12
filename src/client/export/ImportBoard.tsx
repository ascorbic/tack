import { type ReactNode, useId, useRef, useState } from "react";
import {
	type BoardExport,
	describeImportError,
	readBoardExport,
	summariseExport,
} from "../../shared/boardExport.ts";
import { sketch } from "../../shared/thumbnail.ts";
import { BoardThumbnail } from "../boards/BoardThumbnail.tsx";
import { imageHashes, useImportProgress } from "./imageFiles.ts";
import "./export.css";

// Importing a board (#59), in the New board picker: a file exported from
// Tack (Export, or a backup on GitHub), dropped, chosen or pasted, checked
// in the browser with the same reading the server uses, and previewed
// before a board is made from it. Its images' files, if it carries them,
// are uploaded once the board's made (the home page does it), and the
// button says how far that's got.

const NOUNS: Record<string, [string, string]> = {
	section: ["section", "sections"],
	sticky: ["sticky", "stickies"],
	card: ["card", "cards"],
	text: ["text", "texts"],
	connector: ["connector", "connectors"],
	decision: ["decision", "decisions"],
	widget: ["widget", "widgets"],
	action: ["action item", "action items"],
	stack: ["stack", "stacks"],
	image: ["image", "images"],
};

function counted(n: number, [one, many]: [string, string]): string {
	return `${n} ${n === 1 ? one : many}`;
}

export function ImportDetails({
	creating,
	error,
	access,
	onCancel,
	onImport,
	initial = null,
}: {
	creating: boolean;
	error: string | null;
	/** Who can open it, when there's a choice (New board's own field). */
	access?: ReactNode;
	onCancel?: () => void;
	onImport: (data: BoardExport, title: string) => void;
	/** A file already read (the gallery). */
	initial?: { data: BoardExport; name: string } | null;
}) {
	const [file, setFile] = useState(initial);
	const [problem, setProblem] = useState<string | null>(null);
	const [title, setTitle] = useState(initial?.data.title ?? "");
	const [dragging, setDragging] = useState(false);
	const [pasting, setPasting] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const titleId = useId();
	const pasteId = useId();
	const progress = useImportProgress();
	const uploading = creating && progress && progress.total > 0 ? progress : null;

	const read = (text: string, name: string) => {
		const result = readBoardExport(text);
		if (!result.ok) {
			setProblem(describeImportError(result.error));
			return;
		}
		setProblem(null);
		setFile({ data: result.data, name });
		setTitle(result.data.title);
	};
	const readFile = async (chosen: File | undefined) => {
		if (!chosen) return;
		read(await chosen.text(), chosen.name);
	};

	if (!file) {
		return (
			<aside className="new-board-details import-details" aria-label="Import a board">
				<label
					className="import-drop"
					data-dragging={dragging || undefined}
					onDragOver={(event) => {
						event.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={(event) => {
						event.preventDefault();
						setDragging(false);
						void readFile(event.dataTransfer.files[0]);
					}}
				>
					<input
						ref={input}
						type="file"
						accept=".json,application/json"
						onChange={(event) => void readFile(event.target.files?.[0])}
					/>
					<span className="import-drop-art" aria-hidden="true">
						<span className="import-drop-sheet" />
						<span className="import-drop-arrow">
							<svg width="22" height="22" viewBox="0 0 16 16">
								<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7" />
							</svg>
						</span>
					</span>
					<span className="import-drop-title">Drop a board’s .json here</span>
					<span className="import-drop-hint">or click to choose one</span>
				</label>
				<h3 className="template-details-title">Import a board</h3>
				<p className="template-details-description">
					A board exported from Tack: from Export in a board’s menu, or a backup on GitHub. It
					becomes a new board with everything in it, and you as its owner.
				</p>
				{pasting ? (
					<label className="new-board-field" htmlFor={pasteId}>
						<span>Paste its JSON</span>
						<textarea
							id={pasteId}
							className="import-paste"
							autoFocus
							spellCheck={false}
							placeholder='{ "format": "tack.board", … }'
							onPaste={(event) => {
								const text = event.clipboardData.getData("text");
								if (text) {
									event.preventDefault();
									read(text, "pasted");
								}
							}}
							onChange={(event) => {
								if (event.target.value.trim().endsWith("}")) read(event.target.value, "pasted");
							}}
						/>
					</label>
				) : (
					<button type="button" className="import-paste-link" onClick={() => setPasting(true)}>
						Or paste the JSON instead
					</button>
				)}
				{(problem ?? error) && (
					<p className="new-board-error" role="alert">
						{problem ?? error}
					</p>
				)}
				{onCancel && (
					<div className="new-board-actions">
						<span className="new-board-actions-end">
							<button type="button" className="new-board-cancel" onClick={onCancel}>
								Cancel
							</button>
						</span>
					</div>
				)}
			</aside>
		);
	}

	const summary = summariseExport(file.data);
	// Files its image shapes name that it doesn't carry (a backup never does).
	const carried = new Set(file.data.images?.map((image) => image.hash));
	const uncarried = imageHashes(file.data).filter((hash) => !carried.has(hash)).length;
	const chips = Object.entries(NOUNS).flatMap(([type, nouns]) => {
		const n = summary.counts[type as keyof typeof summary.counts] ?? 0;
		return n > 0
			? [{ kind: type === "widget" ? "widget" : "section", text: counted(n, nouns) }]
			: [];
	});
	return (
		<aside className="new-board-details import-details" aria-label={`Import ${file.data.title}`}>
			<div className="template-preview">
				<BoardThumbnail thumbnail={sketch(file.data.shapes)} animate />
			</div>
			<h3 className="template-details-title">{file.data.title || "A board"}</h3>
			<p className="template-details-description">
				From {file.name === "pasted" ? "what you pasted" : file.name}
				{file.data.exportedAt
					? `, exported ${new Date(file.data.exportedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`
					: ""}
				.{" "}
				<button
					type="button"
					className="import-paste-link"
					onClick={() => {
						setFile(null);
						setPasting(false);
					}}
				>
					Choose another
				</button>
			</p>
			<ul className="template-inside" aria-label="What’s inside">
				{chips.length === 0 && <li data-kind="more">Nothing on it</li>}
				{chips.map((chip, i) => (
					<li key={chip.text} data-kind={chip.kind} style={{ "--i": i } as React.CSSProperties}>
						{chip.text}
					</li>
				))}
				{summary.rules > 0 && (
					<li data-kind="rule">{summary.rules === 1 ? "A rule" : `${summary.rules} rules`}</li>
				)}
				{summary.prepared > 0 && (
					<li data-kind="steps">
						{summary.prepared === 1 ? "A step" : `${summary.prepared} steps`} ready to start
					</li>
				)}
			</ul>
			{uncarried > 0 && (
				<p className="import-note">
					{uncarried === 1
						? "One image’s file isn’t in it"
						: `${uncarried} images’ files aren’t in it`}
					{file.data.images?.length ? "" : " (backups leave them out)"}, so{" "}
					{uncarried === 1 ? "it’ll" : "they’ll"} show as unavailable.
				</p>
			)}
			<form
				className="new-board-form"
				onSubmit={(event) => {
					event.preventDefault();
					if (!creating) onImport(file.data, title.trim());
				}}
			>
				<label className="new-board-field" htmlFor={titleId}>
					<span>Name</span>
					<input
						id={titleId}
						value={title}
						placeholder="Untitled board"
						maxLength={120}
						onChange={(event) => setTitle(event.target.value)}
					/>
				</label>
				{access}
				{error && (
					<p className="new-board-error" role="alert">
						{error}
					</p>
				)}
				<div className="new-board-actions">
					<span className="new-board-actions-end">
						{onCancel && (
							<button type="button" className="new-board-cancel" onClick={onCancel}>
								Cancel
							</button>
						)}
						<button
							type="submit"
							className="primary new-board-create"
							disabled={creating}
							aria-busy={creating}
						>
							{creating ? (
								<>
									<span className="new-board-spinner" aria-hidden="true" />
									{uploading
										? `Uploading ${Math.min(uploading.done + 1, uploading.total)} of ${uploading.total} ${uploading.total === 1 ? "image" : "images"}…`
										: "Importing…"}
								</>
							) : (
								"Import board"
							)}
						</button>
					</span>
				</div>
				{uploading && (
					<span
						className="import-progress-bar"
						role="progressbar"
						aria-label="Uploading its images"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(uploading.fraction * 100)}
					>
						<span style={{ "--progress": uploading.fraction } as React.CSSProperties} />
					</span>
				)}
			</form>
		</aside>
	);
}
