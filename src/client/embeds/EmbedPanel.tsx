import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
	type EmbedFormat,
	type EmbedRegion,
	type EmbedTheme,
	type SnippetFormat,
	type SnippetTheme,
	embedPath,
	embedSnippet,
} from "../../shared/embed.ts";

/** What the panel needs from the board around it. */
export interface EmbedBoard {
	id: string;
	title: string;
	/** The board's own link, which the image links to. */
	link: string;
	/** Where images are served from: this Tack. */
	origin: string;
}

export interface EmbedPrefs {
	theme: SnippetTheme;
	format: SnippetFormat;
	image: EmbedFormat;
}

const PREFS_KEY = "tack:embed";
const DEFAULT_PREFS: EmbedPrefs = { theme: "auto", format: "markdown", image: "svg" };

function loadPrefs(): EmbedPrefs {
	try {
		const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<EmbedPrefs> | null;
		return {
			theme: raw?.theme === "light" || raw?.theme === "dark" ? raw.theme : DEFAULT_PREFS.theme,
			format: raw?.format === "html" ? "html" : DEFAULT_PREFS.format,
			image: raw?.image === "png" ? "png" : DEFAULT_PREFS.image,
		};
	} catch {
		return DEFAULT_PREFS;
	}
}

function savePrefs(prefs: EmbedPrefs): void {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch {
		// Private browsing: the choice lasts this visit.
	}
}

/**
 * Copy embed (#57): a live image of the board, or part of it, for READMEs
 * and docs, linking back to the board. Board-free (the gallery shows every
 * state); `EmbedDialog` puts it on the board.
 */
export function EmbedPanel({
	board,
	region,
	sectionTitle,
	onRegion,
	onPick,
	thisView,
	onClose,
	headingId,
	previewSrc,
	appTheme = "light",
}: {
	board: EmbedBoard;
	region: EmbedRegion;
	sectionTitle: string | null;
	onRegion: (region: EmbedRegion) => void;
	/** Choose a section or area on the board itself. */
	onPick?: () => void;
	/** What's on screen now, as an area of the board. */
	thisView?: () => EmbedRegion | null;
	onClose?: () => void;
	headingId?: string;
	/** Where the preview comes from; the server's image unless the gallery says otherwise. */
	previewSrc?: (path: string) => string;
	/** The app's theme, for previewing a picture that follows the reader's. */
	appTheme?: EmbedTheme;
}) {
	const [prefs, setPrefs] = useState(loadPrefs);
	const update = (next: Partial<EmbedPrefs>) => {
		const merged = { ...prefs, ...next };
		setPrefs(merged);
		savePrefs(merged);
	};
	const name = useId();
	// Both themes need a <picture>, which only HTML can say.
	const format: SnippetFormat = prefs.theme === "auto" ? "html" : prefs.format;
	const snippet = embedSnippet({
		origin: board.origin,
		board: board.id,
		link: board.link,
		title: board.title,
		format,
		theme: prefs.theme,
		region,
		image: prefs.image,
	});
	const previewTheme: EmbedTheme = prefs.theme === "auto" ? appTheme : prefs.theme;
	const path = embedPath(board.id, "svg", { region, theme: previewTheme });
	const imageUrl = `${board.origin}${embedPath(board.id, prefs.image, { region, theme: previewTheme })}`;

	const picked = region.kind !== "board";
	return (
		<div className="share embed">
			<header className="share-head">
				<h2 id={headingId}>
					Embed <span className="share-title">“{board.title}”</span>
				</h2>
				{onClose && (
					<button type="button" className="share-close" aria-label="Close" onClick={onClose}>
						<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
							<path d="M3 3l8 8M11 3l-8 8" />
						</svg>
					</button>
				)}
			</header>
			<p className="embed-lede">
				A live image for a README or docs page. It keeps up as the board changes, and links back
				here.
			</p>

			<Preview src={previewSrc ? previewSrc(path) : path} theme={previewTheme} />

			<div className="embed-options">
				<Field label="Show">
					<div className="segmented embed-region" role="radiogroup" aria-label="What to show">
						<Choice
							name={`${name}-region`}
							checked={region.kind === "board"}
							onChange={() => onRegion({ kind: "board" })}
						>
							Whole board
						</Choice>
						{thisView && (
							<Choice
								name={`${name}-region`}
								checked={false}
								onChange={() => {
									const view = thisView();
									if (view) onRegion(view);
								}}
							>
								This view
							</Choice>
						)}
						{picked && (
							<Choice name={`${name}-region`} checked onChange={() => undefined}>
								<span className="embed-picked">{regionLabel(region, sectionTitle)}</span>
							</Choice>
						)}
					</div>
					{onPick && (
						<button type="button" className="embed-pick" onClick={onPick}>
							<PickIcon />
							{picked ? "Pick again" : "Pick on the board"}
						</button>
					)}
				</Field>
				<Field label="Theme">
					<div className="segmented" role="radiogroup" aria-label="Theme">
						{(
							[
								["auto", "Follow the reader"],
								["light", "Light"],
								["dark", "Dark"],
							] as const
						).map(([value, label]) => (
							<Choice
								key={value}
								name={`${name}-theme`}
								checked={prefs.theme === value}
								onChange={() => update({ theme: value })}
							>
								{label}
							</Choice>
						))}
					</div>
				</Field>
				<Field label="As">
					<div className="segmented" role="radiogroup" aria-label="Snippet format">
						{(
							[
								["markdown", "Markdown"],
								["html", "HTML"],
							] as const
						).map(([value, label]) => (
							<Choice
								key={value}
								name={`${name}-format`}
								checked={format === value}
								disabled={prefs.theme === "auto" && value === "markdown"}
								title={
									prefs.theme === "auto" && value === "markdown"
										? "Following the reader’s theme takes HTML’s <picture>"
										: undefined
								}
								onChange={() => update({ format: value })}
							>
								{label}
							</Choice>
						))}
					</div>
					<div className="segmented embed-image" role="radiogroup" aria-label="Image format">
						{(["svg", "png"] as const).map((value) => (
							<Choice
								key={value}
								name={`${name}-image`}
								checked={prefs.image === value}
								onChange={() => update({ image: value })}
							>
								{value.toUpperCase()}
							</Choice>
						))}
					</div>
				</Field>
			</div>

			<pre className="embed-snippet" aria-label="Embed code" tabIndex={0}>
				<code>{snippet}</code>
			</pre>

			<p className="embed-note">
				Images show what anyone can see: cards from private repositories are “Private item”, and
				silent writing stays face down.
			</p>

			<footer className="share-foot">
				<CopyButton text={imageUrl} label="Copy image link" done="Image link copied" />
				<CopyButton text={snippet} label="Copy embed" done="Embed copied" primary />
			</footer>
		</div>
	);
}

/** "Section “Now”" or "Area 1200 × 640". */
export function regionLabel(region: EmbedRegion, sectionTitle: string | null): string {
	if (region.kind === "section") return sectionTitle ? `Section “${sectionTitle}”` : "A section";
	if (region.kind === "rect") {
		return `Area ${Math.round(region.rect.w)} × ${Math.round(region.rect.h)}`;
	}
	return "Whole board";
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="embed-field">
			<span className="embed-field-label">{label}</span>
			<div className="embed-field-controls">{children}</div>
		</div>
	);
}

function Choice({
	name,
	checked,
	onChange,
	disabled = false,
	title,
	children,
}: {
	name: string;
	checked: boolean;
	onChange: () => void;
	disabled?: boolean;
	title?: string;
	children: ReactNode;
}) {
	return (
		<label data-checked={checked} data-disabled={disabled || undefined} title={title}>
			<input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} />
			{children}
		</label>
	);
}

/** The image as the server draws it, fading in once it's arrived. */
function Preview({ src, theme }: { src: string; theme: EmbedTheme }) {
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const [shown, setShown] = useState(src);
	// Keep the last image up while the next one draws, so changing an option never flashes empty.
	useEffect(() => {
		setState("loading");
		const image = new Image();
		image.onload = () => {
			setShown(src);
			setState("ready");
		};
		image.onerror = () => setState("error");
		image.src = src;
		return () => {
			image.onload = null;
			image.onerror = null;
		};
	}, [src]);
	return (
		<div
			className="embed-preview"
			data-state={state}
			data-theme-preview={theme}
			aria-busy={state === "loading"}
		>
			{state === "error" ? (
				<p className="embed-preview-error" role="alert">
					Couldn’t draw the board just now. It may have just been made private, or Tack is busy: try
					again in a moment.
				</p>
			) : (
				<img key={shown} src={shown} alt="" data-ready={state === "ready" || undefined} />
			)}
		</div>
	);
}

function CopyButton({
	text,
	label,
	done,
	primary = false,
}: {
	text: string;
	label: string;
	done: string;
	primary?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			window.prompt("Copy this", text);
			return;
		}
		setCopied(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 1800);
	};
	return (
		<button
			type="button"
			className={primary ? "share-copy embed-copy" : "share-copy embed-copy-link"}
			data-copied={copied || undefined}
			data-autofocus={primary ? "" : undefined}
			onClick={() => void copy()}
		>
			<span className="share-copy-icon" aria-hidden="true">
				{copied ? (
					<svg width="16" height="16" viewBox="0 0 16 16">
						<path d="M3.5 8.5l3 3 6-7" />
					</svg>
				) : primary ? (
					<svg width="16" height="16" viewBox="0 0 16 16">
						<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />
					</svg>
				) : (
					<svg width="16" height="16" viewBox="0 0 16 16">
						<rect x="2.5" y="3" width="11" height="10" rx="2" />
						<path d="M2.5 10.5l3.2-3 2.6 2.4 1.7-1.4 3 2.5" />
					</svg>
				)}
			</span>
			<span aria-live="polite">{copied ? done : label}</span>
		</button>
	);
}

function PickIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M2.5 5V3.5a1 1 0 0 1 1-1H5M11 2.5h1.5a1 1 0 0 1 1 1V5M13.5 11v1.5a1 1 0 0 1-1 1H11M5 13.5H3.5a1 1 0 0 1-1-1V11" />
			<path d="M6.5 6.5l3.5 1.4-1.5.6-.6 1.5z" />
		</svg>
	);
}
