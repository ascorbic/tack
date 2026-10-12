import { useEffect, useRef, useState } from "react";
import {
	type Card,
	type DiscussionCategory,
	type MissingCard,
	isMissing,
} from "../shared/cards.ts";
import { forgeForHost, forgeName, sentenceCase } from "../shared/refs.ts";
import { cardStore } from "./cardStore.ts";
import { type Entrance, entranceStyle } from "./entering.ts";
import {
	type CardOrigin,
	type CardUnmatched,
	ProvenanceBadge,
	UnmatchedBand,
} from "./Provenance.tsx";
import { CiBar, PullStatus } from "./PullStatus.tsx";
import { safeUrl } from "./changes/inline.ts";

const STATE_LABEL: Record<Card["state"], string> = {
	open: "Open",
	closed: "Closed",
	merged: "Merged",
	draft: "Draft",
};

/** A discussion's reasons for closing, as GitHub shows them. */
const DISCUSSION_CLOSED: Record<string, string> = {
	resolved: "Resolved",
	outdated: "Outdated",
	duplicate: "Duplicate",
};

export function stateLabel(card: Card): string {
	if (card.kind === "discussion") {
		if (card.state === "closed") return DISCUSSION_CLOSED[card.stateReason ?? ""] ?? "Closed";
		return card.discussion?.answered ? "Answered" : "Open";
	}
	if (card.state === "closed" && card.stateReason === "not_planned") return "Not planned";
	return STATE_LABEL[card.state];
}

/**
 * What tints a card: its state, and for discussions whether it's answered
 * (green, with a tick) and why it closed (resolved is done, like a closed
 * issue; outdated and duplicate are set aside, in grey).
 */
export function cardTone(card: Card): {
	"data-state": Card["state"];
	"data-item": Card["kind"];
	"data-answered"?: true;
	"data-reason"?: string;
} {
	return {
		"data-state": card.state,
		"data-item": card.kind,
		...(card.discussion?.answered && card.state === "open" ? { "data-answered": true } : {}),
		...(card.stateReason ? { "data-reason": card.stateReason } : {}),
	};
}

/** A speech bubble: a discussion, with a tick once it's answered or resolved. */
function DiscussionIcon({ card, size }: { card: Card; size: number }) {
	const done = card.state === "open" ? card.discussion?.answered : card.stateReason === "resolved";
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" data-discussion>
			<path d="M2.75 3.25h10.5a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5H8l-3.25 2.5v-2.5h-2a.5.5 0 0 1-.5-.5v-6.5a.5.5 0 0 1 .5-.5z" />
			{done ? (
				<path className="discussion-tick" d="M5.6 7.1l1.7 1.7 3.2-3.4" />
			) : card.state === "closed" ? (
				<path d="M5.75 7h4.5" />
			) : (
				<>
					<circle cx="5.6" cy="7" r="0.9" className="fill" />
					<circle cx="8" cy="7" r="0.9" className="fill" />
					<circle cx="10.4" cy="7" r="0.9" className="fill" />
				</>
			)}
		</svg>
	);
}

export function StateIcon({ card, size = 14 }: { card: Card; size?: number }) {
	if (card.kind === "discussion") return <DiscussionIcon card={card} size={size} />;
	if (card.kind === "pull") {
		return (
			<svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
				<circle cx="4" cy="3.5" r="1.75" />
				<circle cx="4" cy="12.5" r="1.75" />
				{card.state === "merged" ? (
					<>
						<circle cx="12" cy="8" r="1.75" />
						<path d="M4 5.25v5.5M4 5.25c0 2.5 2 2.75 6.25 2.75" />
					</>
				) : (
					<>
						<circle cx="12" cy="12.5" r="1.75" />
						<path d="M4 5.25v5.5M12 10.75V6.5a2 2 0 0 0-2-2H7.5" />
					</>
				)}
			</svg>
		);
	}
	return (
		<svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="6.25" />
			{card.state === "open" ? (
				<circle cx="8" cy="8" r="1.6" className="fill" />
			) : card.stateReason === "not_planned" ? (
				<path d="M4.5 11.5l7-7" />
			) : (
				<path d="M5.5 8l2 2 3-3.5" />
			)}
		</svg>
	);
}

type Field =
	| "title"
	| "state"
	| "labels"
	| "comments"
	| "assignees"
	| "repo"
	| "upvotes"
	| "category";

interface Changes {
	/** How many times each field has changed since mount. */
	counts: Partial<Record<Field, number>>;
	/** Labels added by the most recent label change. */
	newLabels: Set<string>;
	/** Total updates, for the whole-card ripple. */
	total: number;
}

/**
 * Per-field change counters. Keying animated elements on their field's count
 * replays the animation on each change, and overlapping updates to different
 * fields don't cancel each other's animations.
 */
function useChanges(card: Card): Changes {
	const previous = useRef(card);
	const [changes, setChanges] = useState<Changes>({ counts: {}, newLabels: new Set(), total: 0 });

	useEffect(() => {
		const before = previous.current;
		previous.current = card;
		if (before === card || before.key !== card.key) return;
		const fields: Field[] = [];
		if (before.title !== card.title) fields.push("title");
		if (
			before.state !== card.state ||
			before.stateReason !== card.stateReason ||
			// Answered is a discussion's state, as far as the card's concerned.
			!!before.discussion?.answered !== !!card.discussion?.answered
		)
			fields.push("state");
		if ((before.discussion?.upvotes ?? 0) !== (card.discussion?.upvotes ?? 0))
			fields.push("upvotes");
		if (before.discussion?.category.name !== card.discussion?.category.name)
			fields.push("category");
		if (before.comments !== card.comments) fields.push("comments");
		const oldLabels = new Set(before.labels.map((l) => l.name));
		const added = new Set(card.labels.map((l) => l.name).filter((name) => !oldLabels.has(name)));
		if (added.size > 0 || oldLabels.size !== card.labels.length) fields.push("labels");
		if (before.assignees.length !== card.assignees.length) fields.push("assignees");
		// The repository was renamed or transferred.
		if (before.repo !== card.repo) fields.push("repo");
		if (fields.length === 0) return;
		setChanges((current) => {
			const counts = { ...current.counts };
			for (const field of fields) counts[field] = (counts[field] ?? 0) + 1;
			return {
				counts,
				newLabels: fields.includes("labels") ? added : current.newLabels,
				total: current.total + 1,
			};
		});
	}, [card]);

	return changes;
}

export interface CardViewProps {
	card: Card | MissingCard | undefined;
	cardKey: string;
	selected?: boolean;
	/** Simplified rendering for low zoom levels. */
	compact?: boolean;
	/** Animate in, for shapes that were just added. */
	enter?: boolean;
	/** Fly in from elsewhere, as Expand related's cards do (see entering.ts). */
	entrance?: Entrance | null;
	/** What brought it to the board, if it wasn't a person (see Provenance.tsx). */
	origin?: CardOrigin | null;
	/** It no longer matches the inbox or rule that brought it. */
	unmatched?: CardUnmatched | null;
}

/** How a card arrives: flying in, dropping in, or not at all. */
function arrival(enter?: boolean, entrance?: Entrance | null) {
	if (entrance) return { "data-enter": "expand", style: entranceStyle(entrance) };
	return { "data-enter": enter };
}

export function CardView({
	card,
	cardKey,
	selected,
	compact,
	enter,
	entrance,
	origin,
	unmatched,
}: CardViewProps) {
	if (!card)
		return <LoadingCard cardKey={cardKey} selected={selected} enter={enter} entrance={entrance} />;
	if (isMissing(card)) return <MissingCardView card={card} selected={selected} />;
	return (
		<LiveCard
			card={card}
			selected={selected}
			compact={compact}
			enter={enter}
			entrance={entrance}
			origin={origin}
			unmatched={unmatched}
		/>
	);
}

function LiveCard({
	card,
	selected,
	compact,
	enter,
	entrance,
	origin,
	unmatched,
}: {
	card: Card;
	selected?: boolean;
	compact?: boolean;
	enter?: boolean;
	entrance?: Entrance | null;
	origin?: CardOrigin | null;
	unmatched?: CardUnmatched | null;
}) {
	const { counts, newLabels, total } = useChanges(card);
	/** Key and flag for an element that animates when `field` changes. */
	const anim = (field: Field, prefix: string) => ({
		key: `${prefix}${counts[field] ?? 0}`,
		on: (counts[field] ?? 0) > 0,
	});
	const state = anim("state", "s");
	const title = anim("title", "t");
	const comments = anim("comments", "m");
	const repo = anim("repo", "r");
	const upvotes = anim("upvotes", "u");
	const category = anim("category", "g");
	const discussion = card.discussion;
	const repoName = card.repo.split("/").at(-1);
	const checks = card.pull?.checks;
	const liveness = useLiveness(card.live);
	// The title is a link, but a plain click on a card that isn't selected
	// yet selects it (people click cards to pick them up, drag and vote):
	// it opens on a click once selected, or a ⌘/Ctrl-click, as in FigJam.
	// The end of a drag that started on the title isn't a click either.
	const press = useRef<{ selected: boolean; x: number; y: number } | null>(null);
	const titleLink = {
		onPointerDown: (event: React.PointerEvent) => {
			press.current = { selected: !!selected, x: event.clientX, y: event.clientY };
		},
		onClick: (event: React.MouseEvent) => {
			const p = press.current;
			const moved = p ? Math.hypot(event.clientX - p.x, event.clientY - p.y) > 4 : false;
			// From the keyboard (no pointer, `detail` 0), it's a link like any other.
			const opens =
				event.detail === 0 ||
				(!moved && (event.metaKey || event.ctrlKey || (!!p?.selected && !event.shiftKey)));
			if (!opens) event.preventDefault();
		},
	};
	const openLabel = `Open on ${forgeName(card.host)}`;

	if (compact) {
		return (
			<article
				className="card compact"
				{...cardTone(card)}
				data-ci={checks?.state}
				data-selected={selected}
				{...arrival(enter, entrance)}
				data-live={card.live === false ? "false" : undefined}
				data-unmatched={unmatched ? true : undefined}
			>
				{total > 0 && <span key={total} className="card-pulse" aria-hidden="true" />}
				<span className="state-icon" key={`s${state.key}`} data-pop={state.on}>
					<StateIcon card={card} size={28} />
				</span>
				<span className="compact-title">
					<span className="compact-number">{card.item}</span> {card.title}
				</span>
				{checks && checks.state !== "none" && <CiBar checks={checks} />}
			</article>
		);
	}

	return (
		<article
			className="card"
			{...cardTone(card)}
			data-selected={selected}
			{...arrival(enter, entrance)}
			data-live={card.live === false ? "false" : undefined}
			data-unmatched={unmatched ? true : undefined}
		>
			{total > 0 && <span key={total} className="card-pulse" aria-hidden="true" />}
			<div className="card-head">
				<span className="state-icon" key={`i${state.key}`} data-pop={state.on}>
					<StateIcon card={card} />
				</span>
				<span className="mono">
					<span key={repo.key} data-flash={repo.on}>
						{repoName}
					</span>{" "}
					{card.item}
				</span>
				<span
					className="chip state"
					key={`c${state.key}`}
					data-pop={state.on}
					title={answeredBy(card)}
				>
					{discussion?.answered && card.state === "open" && (
						<svg
							className="answered-tick"
							width="11"
							height="11"
							viewBox="0 0 12 12"
							aria-hidden="true"
						>
							<path d="M2.75 6.25 5 8.5l4.25-4.75" />
						</svg>
					)}
					{stateLabel(card)}
				</span>
				{card.url && (
					<a
						className="card-open nodrag"
						href={safeUrl(card.url)}
						target="_blank"
						rel="noreferrer"
						draggable={false}
						aria-label={openLabel}
						title={openLabel}
					>
						<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
							<path d="M4.5 2.5h5v5M9.5 2.5 3 9" />
						</svg>
					</a>
				)}
			</div>
			<a
				className="card-title"
				href={safeUrl(card.url)}
				target="_blank"
				rel="noreferrer"
				draggable={false}
				{...titleLink}
			>
				<span key={title.key} data-flash={title.on}>
					{card.title}
				</span>
			</a>
			{(card.labels.length > 0 || discussion) && (
				<div className="labels">
					{discussion && (
						<CategoryChip
							category={discussion.category}
							key={`g${category.key}`}
							flash={category.on}
						/>
					)}
					{card.labels.slice(0, discussion ? 3 : 4).map((label) => (
						<span
							key={label.name}
							className="chip label"
							data-new={newLabels.has(label.name)}
							style={{ "--label": `#${label.color}` } as React.CSSProperties}
						>
							{label.name}
						</span>
					))}
				</div>
			)}
			{card.pull && <PullStatus pull={card.pull} forge={card.forge} />}
			<div className="card-foot">
				{card.assignees.length > 0 && (
					<span className="avatars">
						{card.assignees.slice(0, 3).map((a) => (
							<img
								key={a.login}
								src={a.avatarUrl}
								alt={a.login}
								title={a.login}
								draggable={false}
							/>
						))}
					</span>
				)}
				{discussion && card.author && (
					// Discussions have no assignees: whoever started it stands in.
					<span className="avatars" title={`Started by ${card.author.login}`}>
						<img src={card.author.avatarUrl} alt={card.author.login} draggable={false} />
					</span>
				)}
				{discussion?.upvotes !== undefined && (
					<span
						className="count upvotes"
						key={upvotes.key}
						data-tick={upvotes.on}
						title={`${discussion.upvotes} ${discussion.upvotes === 1 ? "upvote" : "upvotes"}`}
					>
						<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
							<path d="M8 3.25 3.5 8.5h3v4.25h3V8.5h3z" />
						</svg>
						<span className="visually-hidden">Upvotes: </span>
						{discussion.upvotes}
					</span>
				)}
				<span className="count" key={comments.key} data-tick={comments.on}>
					<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
						<path d="M2.5 3h11v7.5H7l-3 2.5v-2.5H2.5z" />
					</svg>
					{card.comments}
				</span>
				{discussion?.locked && (
					<span className="count" title="Locked: only people who can write here can comment">
						<LockIcon />
						<span className="visually-hidden">Locked</span>
					</span>
				)}
				{card.reactions > 0 && (
					<span className="count">
						<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
							<path d="M8 13.5s-5.5-3.2-5.5-7A3 3 0 0 1 8 4.8a3 3 0 0 1 5.5 1.7c0 3.8-5.5 7-5.5 7z" />
						</svg>
						{card.reactions}
					</span>
				)}
				{origin && <ProvenanceBadge origin={origin} />}
				{liveness && <Liveness state={liveness} card={card} />}
			</div>
			{unmatched && <UnmatchedBand unmatched={unmatched} card={card} />}
		</article>
	);
}

/** Who answered a discussion, for the Answered chip's tooltip. */
function answeredBy(card: Card): string | undefined {
	const answer = card.discussion?.answer;
	if (!card.discussion?.answered || card.state !== "open") return undefined;
	return answer?.author ? `Answered by ${answer.author}` : "An answer has been chosen";
}

/** A discussion's category, as GitHub shows it: its emoji, then its name. */
export function CategoryChip({
	category,
	flash,
}: {
	category: DiscussionCategory;
	flash?: boolean;
}) {
	if (!category.name) return null;
	return (
		<span
			className="chip category"
			data-new={flash || undefined}
			title={`Category: ${category.name}`}
		>
			{category.emoji ? (
				<span className="category-emoji" aria-hidden="true">
					{category.emoji}
				</span>
			) : (
				<svg
					className="category-bubble"
					width="11"
					height="11"
					viewBox="0 0 16 16"
					aria-hidden="true"
				>
					<path d="M2.5 3h11v7.5H7l-3 2.5v-2.5H2.5z" />
				</svg>
			)}
			{category.name}
		</span>
	);
}

function LoadingCard({
	cardKey,
	selected,
	enter,
	entrance,
}: {
	cardKey: string;
	selected?: boolean;
	enter?: boolean;
	entrance?: Entrance | null;
}) {
	return (
		<article
			className="card loading"
			data-selected={selected}
			{...arrival(enter, entrance)}
			aria-busy="true"
		>
			<div className="card-head mono">{cardKey.split("/").slice(1).join("/")}</div>
			<div className="skeleton" style={{ width: "86%" }} />
			<div className="skeleton" style={{ width: "58%" }} />
			<div className="skeleton short" />
		</article>
	);
}

/** Off to GitHub to install the app, and back to this board afterwards. */
export function installUrl(): string {
	const here = typeof location === "undefined" ? "/" : location.pathname + location.search;
	return `/setup/install?state=${encodeURIComponent(here)}`;
}

/** `owner/repo` from a card key like `github.com/owner/repo#1`. */
function repoOfKey(key: string): string {
	return key
		.split("/")
		.slice(1)
		.join("/")
		.replace(/[#!]\d+$/, "");
}

/**
 * Whether a card is live. Not live: a quiet marker, with a tooltip saying
 * why and how to fix it. Just turned live (the app was installed): a brief
 * "Live" that lights up and fades away.
 */
function useLiveness(live: boolean | undefined): "lazy" | "upgraded" | null {
	const previous = useRef(live);
	const [upgraded, setUpgraded] = useState(false);
	useEffect(() => {
		const before = previous.current;
		previous.current = live;
		if (before === false && live === true) setUpgraded(true);
		if (live === false) setUpgraded(false);
	}, [live]);
	if (live === false) return "lazy";
	return upgraded ? "upgraded" : null;
}

/** Forges with an app to install: GitHub (and the test forge, which stands in for it). */
function hasApp(forge: Card["forge"]): boolean {
	return forge === "github" || forge === "fake";
}

function Liveness({ state, card }: { state: "lazy" | "upgraded"; card: Card }) {
	const repo = card.repo;
	if (state === "upgraded") {
		return (
			<span className="liveness" data-live="true" role="status">
				<span className="liveness-dot" aria-hidden="true" />
				Live
			</span>
		);
	}
	if (!hasApp(card.forge)) return <Checked card={card} />;
	return (
		<span className="liveness" data-live="false" tabIndex={0} aria-label="Not live">
			<span className="liveness-dot" aria-hidden="true" />
			Not live
			<span className="liveness-tip nodrag nopan" role="tooltip">
				<strong>Read-only: Tack can’t push here</strong>
				<span>
					The Tack app isn’t installed on <span className="mono">{repo}</span>, so staged changes
					can’t be pushed to it, and updates from GitHub take a minute or so to show up.
				</span>
				<a className="liveness-install nodrag" href={installUrl()}>
					Install the app →
				</a>
				<span className="liveness-who">
					It takes an owner of <span className="mono">{repo.split("/")[0]}</span>: GitHub asks one
					if that isn’t you.
				</span>
			</span>
		</span>
	);
}

/**
 * Not live on a forge without an app (#65): GitLab and Forgejo until a
 * webhook arrives from the repository, Tangled always. Whether Tack can
 * push there is a separate thing: the instance's own token for the host.
 */
function Checked({ card }: { card: Card }) {
	const forge = forgeName(card.host);
	const webhooks = card.forge === "gitlab" || card.forge === "forgejo";
	const where = card.forge === "gitlab" ? "project" : "repository";
	return (
		<span className="liveness" data-live="false" tabIndex={0} aria-label="Not live">
			<span className="liveness-dot" aria-hidden="true" />
			Not live
			<span className="liveness-tip nodrag nopan" role="tooltip">
				<strong>
					{card.writable ? "Checked while you look" : "Read-only, and checked while you look"}
				</strong>
				<span>
					Tack checks {forge} for changes to <span className="mono">{card.repo}</span> while the
					board’s open, so updates take a minute or so to show up.
					{webhooks
						? ` A webhook from the ${where} to this instance brings them as they happen.`
						: ` ${sentenceCase(forge)} has no webhooks to send them sooner.`}
				</span>
				{!card.writable && (
					<span className="liveness-who">
						{card.forge === "tangled"
							? `Tack only reads ${forge}: changes staged here can’t be pushed to it.`
							: `This instance doesn’t write to ${forge}: an admin can turn that on.`}
					</span>
				)}
			</span>
		</span>
	);
}

function LockIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="lock-icon">
			<rect x="3" y="7" width="10" height="7" rx="1.6" />
			<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
		</svg>
	);
}

/** A card from a private repository this viewer can't read: nothing but its key. */
function PrivateCardView({ card, selected }: { card: MissingCard; selected?: boolean }) {
	const [checking, setChecking] = useState(false);
	const host = card.key.slice(0, card.key.indexOf("/"));
	// Only GitHub knows who may read what; other forges' private items are hidden from everyone.
	const github = hasApp(forgeForHost(host) ?? "github");
	useEffect(() => {
		if (!checking) return;
		const timer = setTimeout(() => setChecking(false), 1800);
		return () => clearTimeout(timer);
	}, [checking]);
	return (
		<article className="card missing private" data-selected={selected}>
			<div className="card-head">
				<LockIcon />
				<span className="mono">{card.key.split("/").slice(1).join("/")}</span>
				<span className="chip private-chip">Private</span>
			</div>
			<div className="private-bars" aria-hidden="true">
				<span style={{ width: "82%" }} />
				<span style={{ width: "54%" }} />
			</div>
			{github ? (
				<>
					<div className="missing-message">
						This is in a private repository you can’t see on GitHub, so its details stay hidden.
					</div>
					<button
						type="button"
						className="card-action nodrag"
						disabled={checking}
						onClick={() => {
							setChecking(true);
							cardStore.recheck();
						}}
					>
						{checking ? "Checking…" : "Got access? Check again"}
					</button>
				</>
			) : (
				<div className="missing-message">
					This isn’t public on {forgeName(host)}, and Tack only shows what’s public there, so its
					details stay hidden.
				</div>
			)}
		</article>
	);
}

function MissingCardView({ card, selected }: { card: MissingCard; selected?: boolean }) {
	if (card.reason === "private") return <PrivateCardView card={card} selected={selected} />;
	if (card.reason === "demo") {
		// The public demo reads nothing beyond its own pretend forge.
		return (
			<article className="card missing" data-selected={selected} data-reason="demo">
				<div className="card-head mono">{card.key.split("/").slice(1).join("/")}</div>
				<div className="missing-message">
					The demo can’t read real repositories. On your own Tack, this card is live.
				</div>
				<a className="card-action nodrag" href="/self-hosting/deploy/" target="_top">
					Get your own
				</a>
			</article>
		);
	}
	if (card.permission === "discussions") {
		// An install from before Tack read discussions: its owner accepts the new permission.
		const repo = repoOfKey(card.key);
		return (
			<article className="card missing" data-selected={selected} data-permission="discussions">
				<div className="card-head">
					<span className="state-icon">
						<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
							<path d="M2.5 3h11v7.5H7l-3 2.5v-2.5H2.5z" />
						</svg>
					</span>
					<span className="mono">{card.key.split("/").slice(1).join("/")}</span>
				</div>
				<div className="missing-message">
					If this is a discussion, Tack can’t read it yet: the app on{" "}
					<span className="mono">{repo}</span> needs the Discussions permission, which an owner of{" "}
					<span className="mono">{repo.split("/")[0]}</span> can accept on GitHub.
				</div>
				<a className="card-action nodrag" href={installUrl()}>
					Review permissions
				</a>
			</article>
		);
	}
	// Couldn't read the repository, and the app isn't on it: it may be private.
	const installable =
		card.installed === false && (card.reason === "not_found" || card.reason === "forbidden");
	const message = installable
		? `Tack can’t read ${repoOfKey(card.key)}. If it’s private, an owner of ${repoOfKey(card.key).split("/")[0]} can install the app on it.`
		: {
				forbidden: hasApp(forgeForHost(card.key.slice(0, card.key.indexOf("/"))) ?? "github")
					? "You don’t have access to this repository."
					: "Tack can’t show this: it’s confidential, or not public.",
				not_found: "This item doesn’t exist, or was deleted.",
				unsupported: "This forge isn’t supported yet.",
				error: "Couldn’t reach the forge. Retrying…",
				private: "",
				demo: "",
			}[card.reason];
	return (
		<article className="card missing" data-selected={selected}>
			<div className="card-head mono">{card.key.split("/").slice(1).join("/")}</div>
			<div className="missing-message">{message}</div>
			{installable && (
				<a className="card-action nodrag" href={installUrl()}>
					Install the app
				</a>
			)}
		</article>
	);
}
