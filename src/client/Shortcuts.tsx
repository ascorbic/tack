import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
	SHORTCUTS,
	type Shortcut,
	isApplePlatform,
	sheetShortcuts,
	shortcutKeys,
	toolShortcuts,
} from "./shortcuts.ts";
import { TOOL_KEYS } from "./Toolbar.tsx";

// The shortcut sheet: press ? anywhere on the board. Searchable, grouped,
// and generated from the same list the key handling uses.

const apple = isApplePlatform();

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
	// Stay mounted while the closing animation plays.
	const [mounted, setMounted] = useState(open);
	useEffect(() => {
		if (open) setMounted(true);
	}, [open]);
	if (!mounted) return null;
	return <Sheet closing={!open} onClose={onClose} onClosed={() => setMounted(false)} />;
}

function Sheet({
	closing,
	onClose,
	onClosed,
}: {
	closing: boolean;
	onClose: () => void;
	onClosed: () => void;
}) {
	const [query, setQuery] = useState("");
	const search = useRef<HTMLInputElement>(null);
	const titleId = useId();
	const all = useMemo(() => [...toolShortcuts(TOOL_KEYS), ...SHORTCUTS], []);
	const sections = sheetShortcuts(all, query, apple);

	// Focus the search box, and give focus back to wherever it was on close.
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		search.current?.focus();
		return () => previous?.focus?.({ preventScroll: true });
	}, []);

	return (
		<div
			className="sheet-backdrop"
			data-closing={closing}
			onPointerDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
			onAnimationEnd={(event) => {
				if (closing && event.animationName === "sheet-backdrop-out") onClosed();
			}}
		>
			<div
				className="sheet"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				onKeyDown={(event) => {
					if (event.key === "Escape" || (event.key === "?" && !query)) {
						event.preventDefault();
						onClose();
					}
					// Nothing typed here should reach the board behind.
					event.stopPropagation();
				}}
			>
				<header className="sheet-head">
					<h2 id={titleId}>Keyboard shortcuts</h2>
					<label className="sheet-search">
						<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
							<circle cx="7" cy="7" r="4.75" />
							<path d="M10.5 10.5l3 3" />
						</svg>
						<span className="visually-hidden">Search shortcuts</span>
						<input
							ref={search}
							type="search"
							placeholder="Search, e.g. “undo” or “⌘D”"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<button type="button" className="sheet-close" aria-label="Close" onClick={onClose}>
						<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
							<path d="M3 3l8 8M11 3l-8 8" />
						</svg>
					</button>
				</header>
				<div className="sheet-body" data-searching={query.trim() !== "" || undefined}>
					{sections.length === 0 ? (
						<p className="sheet-empty">
							No shortcuts match “{query}”.
							<span>Try a key like “shift” or an action like “zoom”.</span>
						</p>
					) : (
						sections.map(({ group, shortcuts }) => (
							<section key={group} className="sheet-group">
								<h3>{group}</h3>
								<dl>
									{shortcuts.map((shortcut) => (
										<Row key={shortcut.id} shortcut={shortcut} />
									))}
								</dl>
							</section>
						))
					)}
				</div>
			</div>
		</div>
	);
}

function Row({ shortcut }: { shortcut: Shortcut }) {
	const ways = shortcutKeys(shortcut, apple);
	return (
		<div className="sheet-row">
			<dt>{shortcut.label}</dt>
			<dd>
				{ways.map((keys, i) => (
					<span key={keys.join(" ")} className="keys">
						{i > 0 && <span className="keys-or">or</span>}
						{keys.map((key) => (
							<kbd key={key}>{key}</kbd>
						))}
					</span>
				))}
			</dd>
		</div>
	);
}
