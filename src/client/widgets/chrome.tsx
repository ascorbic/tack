import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import type { QueryError, QueryResult } from "../../shared/widgets.ts";
import { ago, clock } from "./describe.ts";
import { ClockIcon, LockIcon, RefreshIcon, SearchIcon, SettingsIcon, WarnIcon } from "./icons.tsx";
import "./chrome.css";

// What the timeline, release draft and dependency map widgets (#43) share
// with each other (and look like the list in): the frame with its header
// and tools, the footer that says how fresh it is, empty and error states,
// and a summary that fades in when the board is zoomed far out, so a widget
// still says something when its rows are too small to read.

/** What a widget has to show, from its config and the latest data. */
export type WidgetState<T> =
	| { kind: "unconfigured" }
	| { kind: "loading" }
	| { kind: "ready"; value: T; at: number; stale: boolean }
	| { kind: "error"; error: QueryError };

/** Results older than this many refresh periods are stale: a refresh must have failed. */
const STALE_PERIODS = 2;

/** A widget's state from one of its query's results. */
export function resultState<K extends QueryResult["kind"]>(
	data: { results: Record<string, QueryResult | QueryError>; at: number } | undefined,
	name: string,
	kind: K,
	refreshSeconds: number,
	now: number,
): WidgetState<Extract<QueryResult, { kind: K }>> {
	const result = data?.results[name];
	if (!data || !result) return { kind: "loading" };
	if (result.kind === "error") return { kind: "error", error: result };
	if (result.kind !== kind) return { kind: "loading" };
	return {
		kind: "ready",
		value: result as Extract<QueryResult, { kind: K }>,
		at: data.at,
		stale: now - data.at > refreshSeconds * 1000 * STALE_PERIODS,
	};
}

export interface ShellProps {
	/** For `widget-{kind}` and the zoomed-out summary. */
	kind: string;
	icon: ReactNode;
	title: string;
	/** A line under the title: what it reads. */
	subtitle?: ReactNode;
	/** Its search names `@me`, so everyone sees their own. */
	personal?: boolean;
	/** A number beside the title (it ticks when it changes). */
	count?: number | null;
	status: WidgetState<unknown>["kind"];
	stale?: boolean;
	selected?: boolean;
	enter?: boolean;
	readOnly?: boolean;
	refreshing?: boolean;
	onRefresh?: () => void;
	onConfigure?: () => void;
	configureLabel: string;
	/** More buttons in the header, before refresh. */
	tools?: ReactNode;
	footer?: ReactNode;
	/** Over the body, e.g. a popover. */
	overlay?: ReactNode;
	/** What it says when zoomed far out. */
	far?: { value: string; label: string };
	/** For the body, to measure it. */
	bodyRef?: RefObject<HTMLDivElement | null>;
	bodyClass?: string;
	children: ReactNode;
}

export function WidgetShell(props: ShellProps) {
	const { status, stale } = props;
	return (
		<section
			className={`widget widget-${props.kind}`}
			data-selected={props.selected || undefined}
			data-enter={props.enter || undefined}
			data-status={status}
			data-stale={stale || undefined}
			aria-label={props.title}
		>
			<header className="widget-head widget-handle">
				<span className="widget-kind" aria-hidden="true">
					{props.icon}
				</span>
				<div className="widget-heading">
					<h3 className="widget-title" title={props.title}>
						{props.title}
					</h3>
					{(props.subtitle || props.personal) && (
						<p className="widget-subtitle">
							{props.personal && <PersonalChip />}
							{props.subtitle}
						</p>
					)}
				</div>
				{props.count !== undefined && props.count !== null ? (
					<Count value={props.count} />
				) : (
					<span />
				)}
				<div className="widget-tools nodrag nopan">
					{props.tools}
					{status !== "unconfigured" && props.onRefresh && (
						<button
							type="button"
							className="widget-tool"
							aria-label="Refresh"
							data-tooltip="Refresh"
							data-spinning={props.refreshing || undefined}
							onClick={props.onRefresh}
						>
							<RefreshIcon />
						</button>
					)}
					{!props.readOnly && props.onConfigure && (
						<button
							type="button"
							className="widget-tool"
							aria-label={props.configureLabel}
							data-tooltip={props.configureLabel}
							data-config-toggle
							onClick={props.onConfigure}
						>
							<SettingsIcon />
						</button>
					)}
				</div>
			</header>
			<div className="widget-main">
				<div
					ref={props.bodyRef}
					className={`widget-body nowheel${props.bodyClass ? ` ${props.bodyClass}` : ""}`}
				>
					{props.children}
				</div>
				{props.overlay}
			</div>
			{props.footer}
			{props.far && (
				<div className="widget-far" aria-hidden="true">
					<span className="widget-far-icon">{props.icon}</span>
					<span className="widget-far-value">{props.far.value}</span>
					<span className="widget-far-label">{props.far.label}</span>
				</div>
			)}
		</section>
	);
}

/**
 * Said on a widget whose search names `@me`: everyone looking sees their own
 * results, so on a shared board, "look at the review queue" means eight
 * different lists. It says so, rather than leaving people to read the chip.
 */
export function PersonalChip() {
	return (
		<span
			className="widget-chip widget-personal"
			title="@me is whoever's looking: everyone here sees their own"
		>
			<PersonIcon />
			Your view
		</span>
	);
}

function PersonIcon() {
	return (
		<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
			<circle cx="6" cy="4" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
			<path
				d="M1.8 10.6c.7-2 2.3-3 4.2-3s3.5 1 4.2 3"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
			/>
		</svg>
	);
}

/** A number that pops when it changes. */
export function Count({
	value,
	one,
	many,
}: {
	value: number;
	/** What it counts, for its tooltip: “match”, and “matches”. */
	one?: string;
	many?: string;
}) {
	const [shown, setShown] = useState({ value, bump: 0 });
	if (shown.value !== value) setShown({ value, bump: shown.bump + 1 });
	return (
		<span
			key={shown.bump}
			className="widget-count"
			data-pop={shown.bump > 0 || undefined}
			title={one && many ? `${value} ${value === 1 ? one : many}` : undefined}
		>
			{value > 999 ? `${Math.round(value / 100) / 10}k` : value}
		</span>
	);
}

/** “Updated 2 min ago”, kept current, with a retry when it's stale. */
export function WidgetFoot({
	at,
	stale,
	refreshing,
	now: fixedNow,
	onRefresh,
	children,
}: {
	at: number;
	stale: boolean;
	refreshing?: boolean;
	now?: number;
	onRefresh?: () => void;
	/** On the right. */
	children?: ReactNode;
}) {
	const now = useNow(fixedNow);
	return (
		<footer className="widget-foot" data-stale={stale || undefined}>
			<span className="widget-live" data-live={(!stale && !refreshing) || undefined}>
				<span className="widget-live-dot" aria-hidden="true" />
				{refreshing
					? "Refreshing…"
					: stale
						? `Updated ${ago(at, now)} · couldn't refresh`
						: `Updated ${ago(at, now)}`}
			</span>
			{stale && onRefresh && !refreshing && (
				<button type="button" className="widget-foot-retry nodrag nopan" onClick={onRefresh}>
					Retry
				</button>
			)}
			<span className="widget-foot-count">{children}</span>
		</footer>
	);
}

/** Now, ticking every 30 seconds (or fixed, for the gallery). */
export function useNow(fixed?: number, every = 30_000): number {
	const [now, setNow] = useState(() => fixed ?? Date.now());
	useEffect(() => {
		if (fixed !== undefined) return;
		const timer = setInterval(() => setNow(Date.now()), every);
		return () => clearInterval(timer);
	}, [fixed, every]);
	return fixed ?? now;
}

export function WidgetEmpty({
	icon,
	title,
	detail,
	tone,
	children,
}: {
	icon: ReactNode;
	title: string;
	detail?: ReactNode;
	tone?: "warn" | "wait" | "good";
	children?: ReactNode;
}) {
	return (
		<div className="widget-empty" data-tone={tone}>
			<span className="widget-empty-icon">{icon}</span>
			<p className="widget-empty-title">{title}</p>
			{detail && <p className="widget-empty-detail">{detail}</p>}
			{children}
		</div>
	);
}

/** Why a query couldn't run, in words, with what can be done about it. */
export function QueryErrorEmpty({
	error,
	noun,
	now = Date.now(),
	readOnly,
	onRefresh,
	onConfigure,
	what = "that",
	editLabel = "Change it",
}: {
	error: QueryError;
	/** What couldn't load: “this timeline”. */
	noun: string;
	now?: number;
	readOnly?: boolean;
	onRefresh?: () => void;
	onConfigure?: () => void;
	/** What GitHub couldn't read, when it was asked something it didn't understand: “this search”. */
	what?: string;
	/** The action that fixes it. */
	editLabel?: string;
}) {
	switch (error.reason) {
		case "signed_out":
			return (
				<WidgetEmpty
					icon={<LockIcon size={20} />}
					title={`Sign in to see ${noun}`}
					detail={error.message}
				>
					<a
						className="widget-action"
						href={`/auth/signin?return_to=${encodeURIComponent(location.pathname)}`}
					>
						Sign in with GitHub
					</a>
				</WidgetEmpty>
			);
		case "rate_limited":
			return (
				<WidgetEmpty
					icon={<ClockIcon size={20} />}
					title="GitHub needs a breather"
					detail={
						error.retryAt && error.retryAt > now
							? `Too many requests for now. Trying again at ${clock(error.retryAt)}.`
							: "Too many requests for now. Trying again shortly."
					}
					tone="wait"
				/>
			);
		case "invalid":
			return (
				<WidgetEmpty
					icon={<SearchIcon size={20} />}
					title={`GitHub couldn't read ${what}`}
					detail={error.message}
					tone="warn"
				>
					{!readOnly && onConfigure && (
						<button type="button" className="widget-action" onClick={onConfigure}>
							{editLabel}
						</button>
					)}
				</WidgetEmpty>
			);
		case "no_access":
			return (
				<WidgetEmpty
					icon={<LockIcon size={20} />}
					title={`Tack can't read ${noun} for you`}
					detail={error.message}
					tone="warn"
				/>
			);
		case "unsupported":
			return (
				<WidgetEmpty
					icon={<WarnIcon size={20} />}
					title="This forge can't do that"
					detail={error.message}
					tone="warn"
				/>
			);
		default:
			return (
				<WidgetEmpty
					icon={<WarnIcon size={20} />}
					title={`Couldn't load ${noun}`}
					detail={error.message}
					tone="warn"
				>
					{onRefresh && (
						<button type="button" className="widget-action" onClick={onRefresh}>
							Try again
						</button>
					)}
				</WidgetEmpty>
			);
	}
}

/** An element's size, kept current as it's resized. */
export function useSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
	const [size, setSize] = useState({ w: 0, h: 0 });
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const read = () => {
			// Layout size, not the board's zoom.
			const next = { w: el.clientWidth, h: el.clientHeight };
			setSize((current) => (current.w === next.w && current.h === next.h ? current : next));
		};
		read();
		const observer = new ResizeObserver(read);
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

/** Copy text, with a fallback for browsers (and frames) without the async clipboard. */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	}
}

/** Placeholder rows while the first results load. */
export function SkeletonRows({
	widths = [0.82, 0.64, 0.9, 0.55, 0.74, 0.6],
}: {
	widths?: number[];
}) {
	return (
		<ul className="widget-rows" aria-busy="true" aria-label="Loading">
			{widths.map((width, i) => (
				<li
					key={i}
					className="widget-row widget-row-skeleton"
					style={{ "--i": i } as CSSProperties}
				>
					<span className="skeleton widget-skeleton-dot" />
					<span className="widget-row-main">
						<span className="skeleton" style={{ width: `${width * 100}%` }} />
						<span className="skeleton short" />
					</span>
				</li>
			))}
		</ul>
	);
}
