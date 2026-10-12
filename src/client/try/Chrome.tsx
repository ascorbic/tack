import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { TRY_SCENARIOS, type TryScenarioId } from "./scenarios.ts";

// What the public demo adds around the board (#75): the scenario picker in
// the board's title, Reset, the way to the docs and to running your own,
// and the note that it's a demo where nothing leaves the browser but what
// you ask the AI to read.

/** Where the demo sends people: the docs site it's part of. */
export const LINKS = {
	docs: "/start/introduction/",
	selfHost: "/self-hosting/deploy/",
};

/** Clicking outside `ref`, or Escape, closes. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (!ref.current?.contains(event.target as Node)) close();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close();
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open, close, ref]);
}

function Chevron() {
	return (
		<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
			<path
				d="M3 4.5 6 7.5 9 4.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** The board's title is the scenario: click to pick another. */
export function ScenarioPicker({
	scenario,
	onChoose,
}: {
	scenario: TryScenarioId;
	onChoose: (scenario: TryScenarioId) => void;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const menuId = useId();
	const ids = Object.keys(TRY_SCENARIOS) as TryScenarioId[];
	useDismiss(open, () => setOpen(false), root);

	// Opening puts focus on the board you're on; arrows move, Enter picks.
	useEffect(() => {
		if (!open) return;
		root.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
	}, [open]);

	const onMenuKey = (event: React.KeyboardEvent) => {
		const items = [
			...(root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
		];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const move = (to: number) => items[(to + items.length) % items.length]?.focus();
		if (event.key === "ArrowDown") move(at + 1);
		else if (event.key === "ArrowUp") move(at - 1);
		else if (event.key === "Home") move(0);
		else if (event.key === "End") move(items.length - 1);
		else if (event.key === "Tab") setOpen(false);
		else return;
		if (event.key !== "Tab") event.preventDefault();
	};

	return (
		<div className="try-picker" ref={root}>
			<button
				ref={button}
				type="button"
				className="try-picker-button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="try-picker-kicker">Demo</span>
				<span className="try-picker-name">{TRY_SCENARIOS[scenario].name}</span>
				<Chevron />
			</button>
			{open && (
				<div
					id={menuId}
					className="try-picker-menu"
					role="menu"
					aria-label="Boards to try"
					onKeyDown={onMenuKey}
					data-chrome
				>
					<p className="try-picker-heading">Try a board</p>
					{ids.map((id) => (
						<button
							key={id}
							type="button"
							role="menuitemradio"
							aria-checked={id === scenario}
							className="try-picker-item"
							onClick={() => {
								setOpen(false);
								button.current?.focus();
								if (id !== scenario) onChoose(id);
							}}
						>
							<span className={`try-picker-swatch try-swatch-${id}`} aria-hidden="true" />
							<span className="try-picker-text">
								<span className="try-picker-item-name">{TRY_SCENARIOS[id].name}</span>
								<span className="try-picker-blurb">{TRY_SCENARIOS[id].blurb}</span>
							</span>
						</button>
					))}
					<p className="try-picker-foot">Each board is kept in this browser until you reset it.</p>
				</div>
			)}
		</div>
	);
}

function ResetIcon() {
	return (
		<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
			<path
				d="M3.2 6.2A5 5 0 1 1 3 9.6M3 2.8v3.6h3.6"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** Start the board again, after asking: what you did on it goes. */
export function ResetButton({ scenario, onReset }: { scenario: string; onReset: () => void }) {
	const [asking, setAsking] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const confirm = useRef<HTMLButtonElement>(null);
	const headingId = useId();
	useDismiss(asking, () => setAsking(false), root);
	useEffect(() => {
		if (asking) confirm.current?.focus();
	}, [asking]);
	return (
		<div className="try-reset" ref={root}>
			<button
				type="button"
				className="try-reset-button"
				aria-expanded={asking}
				data-tooltip="Start this board again"
				data-tooltip-align="end"
				onClick={() => setAsking((value) => !value)}
			>
				<ResetIcon />
				<span className="try-label">Reset</span>
			</button>
			{asking && (
				<div
					className="try-popover try-reset-confirm"
					role="dialog"
					aria-labelledby={headingId}
					data-chrome
				>
					<p id={headingId} className="try-popover-title">
						Start “{scenario}” again?
					</p>
					<p className="try-popover-text">
						Everything you’ve done on this board goes, and it’s back as it began.
					</p>
					<div className="try-popover-actions">
						<button type="button" onClick={() => setAsking(false)}>
							Keep it
						</button>
						<button ref={confirm} type="button" className="try-danger" onClick={onReset}>
							Reset board
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/** The demo's own buttons at the end of the top bar, then the way to the real thing. */
export function TryActions({ children }: { children: ReactNode }) {
	return (
		<>
			{children}
			<a className="try-cta" href={LINKS.selfHost}>
				<span className="try-cta-long">Get your own</span>
				<span className="try-cta-short">Get Tack</span>
				<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
					<path
						d="M2.5 6h7M6.5 3l3 3-3 3"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</a>
		</>
	);
}

function LockIcon() {
	return (
		<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
			<rect x="3" y="7" width="10" height="7.5" rx="2" fill="currentColor" />
			<path
				d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
			/>
		</svg>
	);
}

/** What the demo note says in full: its name, and its tooltip. */
const NOTE = "This is a demo: nothing leaves your browser, except what you ask the AI to read";

/**
 * "This is a demo: nothing leaves your browser, except what you ask the AI
 * to read", as a lock beside the board's title where the sync dot would be
 * (the demo is always in step with itself). Where there's room beside the
 * name it says "Only what the AI reads leaves your browser"; where there
 * isn't, it's just the lock, and the name keeps its room. It opens to say
 * how, with the ways on: the docs, running your own, the tour again, and
 * the theme. Links to the pretend forge stay on the board, with a word
 * about why under the lock.
 */
export function DemoNote({ onTour, touring }: { onTour: () => void; touring: boolean }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const panelId = useId();
	useDismiss(open, () => setOpen(false), root);
	const forgeNote = useForgeLinks();
	return (
		<div className="try-note" ref={root} data-chrome>
			<button
				type="button"
				className="try-note-pill"
				aria-expanded={open}
				aria-controls={panelId}
				aria-label={NOTE}
				data-tooltip={NOTE}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="try-note-lock">
					<LockIcon />
				</span>
				<span className="try-note-words" aria-hidden="true">
					<span className="try-note-text">Only what the AI reads leaves your browser</span>
				</span>
			</button>
			{open && (
				<div id={panelId} className="try-popover try-note-panel">
					<p className="try-popover-title">Everything but the AI happens in your browser</p>
					<p className="try-popover-text">
						The board, your teammates and the forge you push to are all pretend, running on this
						page. Nothing is sent anywhere except what you ask the AI to read, like a stack’s
						stickies to name it or a section to summarise: that goes to a real model on Cloudflare
						Workers AI, and Tack doesn’t keep it. Your board is kept in this browser so a refresh
						doesn’t lose it, until you reset it.
					</p>
					<p className="try-popover-text">
						The real Tack does all of this with your GitHub issues and pull requests, on a
						Cloudflare account you own.
					</p>
					<div className="try-note-links">
						<a className="try-note-link try-note-primary" href={LINKS.selfHost}>
							Get your own Tack
						</a>
						<a className="try-note-link" href={LINKS.docs}>
							Read the docs
						</a>
						{!touring && (
							<button
								type="button"
								className="try-note-link"
								onClick={() => {
									setOpen(false);
									onTour();
								}}
							>
								Show me around again
							</button>
						)}
					</div>
					<div className="try-note-theme">
						<span>Theme</span>
						<ThemeToggle labelled />
					</div>
				</div>
			)}
			{forgeNote && (
				<p className="try-forge-note" role="status" key={forgeNote}>
					That’s on the demo forge, which only exists in this browser.
				</p>
			)}
		</div>
	);
}

/**
 * Links to the pretend forge (cards' titles, pushed changes) would lead off
 * the demo to nowhere: they stay put, and say why. Returns a key for the
 * note while it shows.
 */
function useForgeLinks(): number | null {
	const [note, setNote] = useState<number | null>(null);
	useEffect(() => {
		let timer = 0;
		// Last, after the board's own handlers: a card that selects itself
		// on a first click has prevented the link already.
		const onClick = (event: MouseEvent) => {
			if (event.defaultPrevented) return;
			const link = (event.target as Element | null)?.closest?.("a[href]");
			if (!(link instanceof HTMLAnchorElement)) return;
			if (new URL(link.href, location.href).host !== "fake.tack") return;
			event.preventDefault();
			setNote(Date.now());
			clearTimeout(timer);
			timer = window.setTimeout(() => setNote(null), 3200);
		};
		window.addEventListener("click", onClick);
		window.addEventListener("auxclick", onClick);
		return () => {
			window.removeEventListener("click", onClick);
			window.removeEventListener("auxclick", onClick);
			clearTimeout(timer);
		};
	}, []);
	return note;
}
