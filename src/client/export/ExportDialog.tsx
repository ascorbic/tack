import { useEffect, useId, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import {
	type ExportOmissions,
	type ExportedImage,
	exportBoard,
	type ExportSummary,
	exportFileName,
	summariseExport,
} from "../../shared/boardExport.ts";
import { describeBytes } from "../../shared/images.ts";
import { Modal } from "../boards/Modal.tsx";
import { cardStore } from "../cardStore.ts";
import { useComments } from "../comments/store.ts";
import { useImages } from "../images/service.ts";
import { SHORTCUTS, isApplePlatform, matchesCombo } from "../shortcuts.ts";
import type { ToastStore } from "../Toasts.tsx";
import { groundColor } from "./image.ts";
import { exportParts, gatherImages, imageHashes } from "./imageFiles.ts";
import { SCALES, imageSize } from "./scope.ts";
import { type ExportFormat, boardTitle, download, exportUI, useExportRequest } from "./store.ts";
import type { BoardExporter, Drawn, ExportScope } from "./useBoardExport.ts";
import "../boards/templates.css";
import "./export.css";

// Export (#59): the board, or what's selected, as a PNG or SVG, and the
// whole board as JSON to import elsewhere. Opened with ⌘⇧E or from the
// board's menu. Images show a preview as they'll come out, and say how big
// they'll be; JSON says what it holds and what it leaves out, and carries
// the files its image shapes show (fetched from the board as it's chosen).
// JSON can also carry what people did on the board (votes, stamps, hands up,
// comments and the items its cards show), for reading it elsewhere.

const FORMATS: { format: ExportFormat; label: string; hint: string }[] = [
	{ format: "png", label: "PNG", hint: "An image, for docs, slides and chat" },
	{ format: "svg", label: "SVG", hint: "Sharp at any size; opens in browsers" },
	{ format: "json", label: "JSON", hint: "The board as data, to import into a new board" },
];

const PREVIEW_SIDE = 640;

const OPEN = SHORTCUTS.find((shortcut) => shortcut.id === "export")?.combos ?? [];

/** Remembered in this browser: how people like their images. */
const PREFS_KEY = "tack:export";

interface Prefs {
	format: ExportFormat;
	scale: number;
	background: boolean;
	/** JSON: include what people did on the board. */
	activity: boolean;
}

function loadPrefs(): Prefs {
	const fallback: Prefs = { format: "png", scale: 2, background: true, activity: false };
	try {
		const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
		return {
			format: raw?.format === "svg" || raw?.format === "json" ? raw.format : fallback.format,
			scale: SCALES.includes(raw?.scale as never) ? (raw?.scale as number) : fallback.scale,
			background: typeof raw?.background === "boolean" ? raw.background : fallback.background,
			activity: typeof raw?.activity === "boolean" ? raw.activity : fallback.activity,
		};
	} catch {
		return fallback;
	}
}

function savePrefs(prefs: Prefs): void {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch {
		// Private windows: just not remembered.
	}
}

const number = new Intl.NumberFormat();

function plural(n: number, one: string, many = `${one}s`): string {
	return `${number.format(n)} ${n === 1 ? one : many}`;
}

/** The export dialog, inside the board. Opens on ⌘⇧E and `exportUI.open()`. */
export function ExportDialog({
	doc,
	exporter,
	selected,
	toasts,
	name,
}: {
	doc: Y.Doc;
	exporter: BoardExporter;
	selected: ReadonlySet<string>;
	toasts: ToastStore;
	/** What the board's called, where the page's title doesn't say (the playground). */
	name: string;
}) {
	const request = useExportRequest();
	const headingId = useId();
	// ⌘⇧E (Ctrl+Shift+E): from anywhere on the board but a text field.
	useEffect(() => {
		const apple = isApplePlatform();
		const onKey = (event: KeyboardEvent) => {
			if (!OPEN.some((combo) => matchesCombo(event, combo, apple))) return;
			event.preventDefault();
			if (exportUI.get()) exportUI.close();
			else exportUI.open();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	return (
		<Modal
			open={request !== null}
			onClose={() => exportUI.close()}
			className="export-dialog"
			labelledBy={headingId}
		>
			{(close) => (
				<ExportPanel
					doc={doc}
					exporter={exporter}
					hasSelection={selected.size > 0}
					name={name}
					initialFormat={request?.format}
					headingId={headingId}
					toasts={toasts}
					onClose={close}
				/>
			)}
		</Modal>
	);
}

type Preview =
	| { status: "drawing"; previous: Drawn | null }
	| { status: "ready"; drawn: Drawn; url: string }
	| { status: "failed"; message: string };

/** A JSON export's image files: fetched when JSON's chosen, for the file to carry. */
type Files =
	| { status: "fetching"; done: number; total: number }
	| { status: "ready"; images: ExportedImage[]; missing: number };

function ExportPanel({
	doc,
	exporter,
	hasSelection,
	initialFormat,
	headingId,
	toasts,
	onClose,
	name,
}: {
	doc: Y.Doc;
	exporter: BoardExporter;
	hasSelection: boolean;
	initialFormat?: ExportFormat;
	headingId: string;
	toasts: ToastStore;
	onClose: () => void;
	name: string;
}) {
	const [prefs, setPrefs] = useState(() => {
		const loaded = loadPrefs();
		return initialFormat ? { ...loaded, format: initialFormat } : loaded;
	});
	const [scope, setScope] = useState<ExportScope>(hasSelection ? "selection" : "board");
	const [busy, setBusy] = useState<"download" | "copy" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const update = (change: Partial<Prefs>) => {
		setPrefs((current) => {
			const next = { ...current, ...change };
			savePrefs(next);
			return next;
		});
		setError(null);
	};
	const { format, scale, background, activity } = prefs;
	const image = format !== "json";
	const title = boardTitle(name);

	const { draw } = exporter;
	// The preview: drawn when the dialog opens, and again when what's drawn changes.
	const [preview, setPreview] = useState<Preview>({ status: "drawing", previous: null });
	useEffect(() => {
		if (!image) return;
		let cancelled = false;
		let url: string | null = null;
		setPreview((current) => ({
			status: "drawing",
			previous: current.status === "ready" ? current.drawn : null,
		}));
		const timer = setTimeout(() => {
			draw({ scope, format: "png", scale: { fit: PREVIEW_SIDE }, background })
				.then((drawn) => {
					if (cancelled) return;
					url = URL.createObjectURL(drawn.blob);
					setPreview({ status: "ready", drawn, url });
				})
				.catch((err: unknown) => {
					if (!cancelled) {
						setPreview({
							status: "failed",
							message: err instanceof Error ? err.message : "Couldn’t draw the board",
						});
					}
				});
		}, 60);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			if (url) URL.revokeObjectURL(url);
		};
	}, [image, scope, background, draw]);

	const region =
		preview.status === "ready"
			? preview.drawn.region
			: preview.status === "drawing"
				? (preview.previous?.region ?? null)
				: null;
	const size = region ? imageSize(region, format === "svg" ? 1 : scale) : null;

	// JSON: what's in it, and what's left out, worked out once it's chosen.
	const { threads } = useComments();
	const json = useMemo(() => {
		if (format !== "json") return null;
		const { data, omitted } = exportBoard(doc, {
			title,
			includeCard: (key) => {
				const card = cardStore.get(key);
				return !(card && "missing" in card && card.reason === "private");
			},
			...(activity
				? { activity: { cards: (key: string) => cardStore.get(key), threads: threads.values() } }
				: {}),
		});
		return { data, omitted, summary: summariseExport(data) };
	}, [doc, format, title, activity, threads]);

	// Its image shapes' files, fetched from the board for the file to carry.
	const images = useImages();
	const total = useMemo(() => (json ? imageHashes(json.data).length : 0), [json]);
	const [fetched, setFetched] = useState<{ of: unknown; files: Files } | null>(null);
	// Until they're fetched for this export, they're being fetched: never a file without them.
	const files = useMemo<Files>(
		() =>
			total === 0 || !images
				? { status: "ready", images: [], missing: total }
				: fetched && fetched.of === json?.data
					? fetched.files
					: { status: "fetching", done: 0, total },
		[total, images, fetched, json],
	);
	useEffect(() => {
		if (!json || total === 0 || !images) return;
		const abort = new AbortController();
		const of = json.data;
		void gatherImages(of, images, {
			signal: abort.signal,
			onProgress: (done) => {
				if (!abort.signal.aborted) setFetched({ of, files: { status: "fetching", done, total } });
			},
		}).then(({ images: found, missing }) => {
			if (!abort.signal.aborted) {
				setFetched({ of, files: { status: "ready", images: found, missing: missing.length } });
			}
		});
		return () => abort.abort();
	}, [json, total, images]);

	// The file, in pieces: the images' base64 never joins one enormous string.
	const file = useMemo(() => {
		if (!json || files.status !== "ready") return null;
		const parts = exportParts(
			files.images.length ? { ...json.data, images: files.images } : json.data,
		);
		return { parts, bytes: parts.reduce((sum, part) => sum + part.length, 0) };
	}, [json, files]);
	const gathering = json !== null && files.status === "fetching";

	const imageName = (extension: string) =>
		exportFileName(scope === "selection" ? `${title} selection` : title, extension);

	const save = async () => {
		setError(null);
		if (format === "json") {
			if (!file) return;
			download(new Blob(file.parts, { type: "application/json" }), exportFileName(title, "json"));
			const included = files.status === "ready" ? files.images.length : 0;
			toasts.show({
				message: `Exported “${title}” as JSON${included ? `, with ${plural(included, "image")}` : ""}`,
			});
			onClose();
			return;
		}
		setBusy("download");
		try {
			const drawn = await exporter.draw({ scope, format, scale, background });
			download(drawn.blob, imageName(format));
			toasts.show({
				message: `Exported ${format.toUpperCase()}${format === "png" ? `, ${number.format(drawn.width)} × ${number.format(drawn.height)}` : ""}`,
			});
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn’t draw the board. Try again?");
		} finally {
			setBusy(null);
		}
	};

	const copy = async () => {
		setError(null);
		try {
			if (json) {
				if (!file) return;
				await navigator.clipboard.writeText(file.parts.join(""));
				toasts.show({ message: "Copied the board’s JSON" });
				onClose();
				return;
			}
			setBusy("copy");
			// Made inside the click, as Safari asks, with the drawing to come.
			const drawing = exporter.draw({ scope, format: "png", scale, background });
			await navigator.clipboard.write([
				new ClipboardItem({ "image/png": drawing.then((drawn) => drawn.blob) }),
			]);
			toasts.show({ message: "Copied the image" });
			onClose();
		} catch {
			setError("Your browser wouldn’t let Tack copy that. Try downloading it instead.");
		} finally {
			setBusy(null);
		}
	};

	const canCopy =
		typeof navigator !== "undefined" &&
		Boolean(navigator.clipboard) &&
		(json !== null || (format === "png" && typeof ClipboardItem !== "undefined"));

	return (
		<div className="export" data-format={format}>
			<header className="export-head">
				<h2 id={headingId}>Export</h2>
				<p className="export-lede">
					{image
						? "An image of the board as it is, without anyone’s cursors, selections or comment pins."
						: "The board as data: import it into a new board, here or on another Tack."}
				</p>
			</header>

			<Segmented
				label="Format"
				value={format}
				options={FORMATS.map((option) => ({
					value: option.format,
					label: option.label,
					hint: option.hint,
				}))}
				onChange={(value) => update({ format: value })}
			/>

			{image ? (
				<>
					<Segmented
						label="What"
						value={scope}
						options={[
							{
								value: "selection",
								label: "Selection",
								disabled: !hasSelection,
								hint: hasSelection ? undefined : "Select something first",
							},
							{ value: "board", label: "Whole board" },
						]}
						onChange={setScope}
					/>
					<PreviewFrame preview={preview} background={background} />
					<div className="export-options">
						{format === "png" && (
							<div className="export-scales" role="radiogroup" aria-label="Scale">
								{SCALES.map((option) => (
									<button
										key={option}
										type="button"
										role="radio"
										aria-checked={scale === option}
										className="export-scale"
										onClick={() => update({ scale: option })}
									>
										{option}×
									</button>
								))}
							</div>
						)}
						<label className="export-switch">
							<input
								type="checkbox"
								role="switch"
								checked={background}
								onChange={(event) => update({ background: event.target.checked })}
							/>
							<span className="export-switch-track" aria-hidden="true">
								<span className="export-switch-knob" />
							</span>
							Background
						</label>
						<span className="export-size" aria-live="polite">
							{size
								? format === "svg"
									? `${number.format(size.width)} × ${number.format(size.height)}`
									: `${number.format(size.width)} × ${number.format(size.height)} px`
								: " "}
							{size?.capped && <span className="export-capped"> · as big as browsers draw</span>}
						</span>
					</div>
				</>
			) : (
				json && (
					<JsonSummary
						summary={json.summary}
						omitted={json.omitted}
						files={files}
						bytes={file?.bytes ?? null}
						activity={activity}
						onActivity={(include) => update({ activity: include })}
					/>
				)
			)}

			{error && (
				<p className="new-board-error" role="alert">
					{error}
				</p>
			)}
			<div className="new-board-actions-end export-actions">
				<button type="button" className="new-board-cancel" onClick={onClose}>
					Cancel
				</button>
				{canCopy && (
					<button
						type="button"
						className="export-copy"
						disabled={busy !== null || gathering || (image && preview.status === "failed")}
						aria-busy={busy === "copy"}
						onClick={() => void copy()}
					>
						{busy === "copy" ? "Copying…" : "Copy"}
					</button>
				)}
				<button
					type="button"
					className="primary new-board-create"
					disabled={busy !== null || gathering || (image && preview.status === "failed")}
					aria-busy={busy === "download" || gathering}
					onClick={() => void save()}
				>
					{busy === "download" || gathering ? (
						<>
							<span className="new-board-spinner" aria-hidden="true" />
							{gathering ? "Gathering images…" : "Drawing…"}
						</>
					) : (
						<>
							<DownloadIcon />
							Download {format.toUpperCase()}
						</>
					)}
				</button>
			</div>
		</div>
	);
}

function PreviewFrame({ preview, background }: { preview: Preview; background: boolean }) {
	return (
		<figure
			className="export-preview"
			data-status={preview.status}
			data-transparent={!background || undefined}
			style={background ? { background: groundColor() } : undefined}
		>
			{preview.status === "ready" ? (
				<img key={preview.url} src={preview.url} alt="What the image will look like" />
			) : preview.status === "failed" ? (
				<figcaption className="export-preview-note">{preview.message}</figcaption>
			) : (
				<figcaption className="export-preview-note">
					<span className="export-drawing" aria-hidden="true">
						<span />
						<span />
						<span />
					</span>
					Drawing the board…
				</figcaption>
			)}
		</figure>
	);
}

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

function JsonSummary({
	summary,
	omitted,
	files,
	bytes,
	activity,
	onActivity,
}: {
	summary: ExportSummary;
	omitted: ExportOmissions;
	files: Files;
	/** The file's size, once its images are in. */
	bytes: number | null;
	activity: boolean;
	onActivity: (include: boolean) => void;
}) {
	const activityId = useId();
	const counts = Object.entries(NOUNS).flatMap(([type, [one, many]]) => {
		const n = summary.counts[type as keyof typeof summary.counts] ?? 0;
		return n > 0 ? [plural(n, one, many)] : [];
	});
	if (summary.rules) counts.push(plural(summary.rules, "rule"));
	if (summary.prepared) counts.push(plural(summary.prepared, "prepared step"));
	return (
		<div className="export-json">
			<p className="export-json-counts">
				{counts.length ? counts.join(" · ") : "Nothing on the board yet"}
				<span className="export-json-size"> · {bytes === null ? "…" : describeBytes(bytes)}</span>
			</p>
			<ImagesNote files={files} />
			<div className="export-json-activity">
				<label className="export-switch">
					<input
						type="checkbox"
						role="switch"
						checked={activity}
						aria-describedby={activityId}
						onChange={(event) => onActivity(event.target.checked)}
					/>
					<span className="export-switch-track" aria-hidden="true">
						<span className="export-switch-knob" />
					</span>
					Include votes, stamps and comments
				</label>
				<p id={activityId} className="export-json-activity-note" aria-live="polite">
					{summary.activity ? (
						<ActivityCounts counts={summary.activity} />
					) : (
						"Who voted, stamped, put their hand up and commented, and what the cards show, for reading the board elsewhere. Importing leaves them out."
					)}
				</p>
			</div>
			<ul className="export-json-notes">
				{activity && (
					<li>
						It names who voted, stamped, put their hand up and commented, except in hidden votes, as
						the board does. Importing it leaves all that behind.
					</li>
				)}
				<li>History and staged changes stay here: they only mean something on this board.</li>
				{omitted.cards > 0 && (
					<li>
						{plural(omitted.cards, "card")} from repositories you can’t read{" "}
						{omitted.cards === 1 ? "is" : "are"} left out.
					</li>
				)}
				{omitted.faceDown > 0 && (
					<li>
						{plural(omitted.faceDown, "sticky", "stickies")} still face down in silent mode{" "}
						{omitted.faceDown === 1 ? "is" : "are"} left out.
					</li>
				)}
				<li>To make a board from it, choose New board on the home page, then Import a board.</li>
			</ul>
		</div>
	);
}

/** What people did, as the file carries it: "2 votes · 9 stamps · 12 comment threads · 3 cards’ details". */
function ActivityCounts({ counts }: { counts: NonNullable<ExportSummary["activity"]> }) {
	const parts = [
		counts.votes ? plural(counts.votes, "vote") : null,
		counts.stamps ? plural(counts.stamps, "stamp") : null,
		counts.volunteers ? plural(counts.volunteers, "hand up", "hands up") : null,
		counts.comments ? plural(counts.comments, "comment thread") : null,
		counts.items ? plural(counts.items, "card’s details", "cards’ details") : null,
	].filter((part) => part !== null);
	return <>{parts.length ? parts.join(" · ") : "No votes, stamps, hands up or comments yet"}</>;
}

/** The board's images in the file: a bar while they're fetched, then how many went in. */
function ImagesNote({ files }: { files: Files }) {
	if (files.status === "fetching") {
		return (
			<div className="export-json-images" data-status="fetching" role="status">
				<span>
					Gathering images… {number.format(files.done)} of {number.format(files.total)}
				</span>
				<span className="export-json-images-bar" aria-hidden="true">
					<span
						style={
							{ "--progress": files.total ? files.done / files.total : 0 } as React.CSSProperties
						}
					/>
				</span>
			</div>
		);
	}
	const { images, missing } = files;
	if (images.length === 0 && missing === 0) return null;
	return (
		<div className="export-json-images" data-status="ready" role="status">
			{images.length > 0 && (
				<span>
					{plural(images.length, "image")} {images.length === 1 ? "goes" : "go"} in the file too, so
					the board comes back whole.
				</span>
			)}
			{missing > 0 && (
				<span className="export-json-images-missing">
					{plural(missing, "image")} couldn’t be fetched, so {missing === 1 ? "it’ll" : "they’ll"}{" "}
					show as unavailable on a board made from it.
				</span>
			)}
		</div>
	);
}

/** A segmented control: one choice of a few, with a thumb that slides between them. */
export function Segmented<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { value: T; label: string; hint?: string; disabled?: boolean }[];
	onChange: (value: T) => void;
}) {
	const index = Math.max(
		0,
		options.findIndex((option) => option.value === value),
	);
	const group = useRef<HTMLDivElement>(null);
	return (
		<div className="export-row">
			<span className="export-row-label" aria-hidden="true">
				{label}
			</span>
			<div
				ref={group}
				className="export-segmented"
				role="radiogroup"
				aria-label={label}
				style={{ "--count": options.length, "--index": index } as React.CSSProperties}
				onKeyDown={(event) => {
					const by = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
					if (!by) return;
					event.preventDefault();
					for (let i = 1; i <= options.length; i++) {
						const next = options[(index + by * i + options.length) % options.length];
						if (next && !next.disabled) {
							onChange(next.value);
							const at = options.indexOf(next);
							group.current?.querySelectorAll<HTMLElement>("[role=radio]")[at]?.focus();
							return;
						}
					}
				}}
			>
				<span className="export-segmented-thumb" aria-hidden="true" />
				{options.map((option) => (
					<button
						key={option.value}
						type="button"
						role="radio"
						aria-checked={option.value === value}
						tabIndex={option.value === value ? 0 : -1}
						disabled={option.disabled}
						title={option.hint}
						onClick={() => onChange(option.value)}
					>
						{option.label}
					</button>
				))}
			</div>
		</div>
	);
}

function DownloadIcon() {
	return (
		<svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
		</svg>
	);
}
