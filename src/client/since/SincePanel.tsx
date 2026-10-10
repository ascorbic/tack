import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import type { CommentThread } from "../../shared/comments.ts";
import { liveMessages, starter } from "../../shared/comments.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import { shortRef } from "../../shared/rules.ts";
import { shapesMap } from "../../shared/shapes.ts";
import {
	type Actor,
	type CardActivity,
	type Digest,
	type EditEntry,
	type Highlight,
	actorName,
	commentDigest,
	describeCardActivity,
	describeEdits,
	editsByPerson,
	highlightsFor,
} from "../../shared/since.ts";
import { personColor } from "../auth/me.ts";
import { relativeTime } from "../boards/api.ts";
import { cardStore, useCard } from "../cardStore.ts";
import { StateIcon } from "../CardView.tsx";
import { useComments } from "../comments/store.ts";
import { authorUser, useNow } from "../comments/Thread.tsx";
import { BubbleIcon, ChevronIcon, CloseIcon, PushIcon, SinceIcon } from "../comments/icons.tsx";
import { Avatar } from "../People.tsx";
import { type SinceStore, sinceStore, useSince } from "./store.ts";
import "./since.css";

// The "since you were here" digest (#46): who did what on the board while
// you were away, what happened on GitHub to its cards, pushes, and new
// comments; each one a link to where it is. Steps through the highlights on
// the canvas, and "Mark all as seen" starts the next digest from now.

/** Highlights for the digest, on shapes still on the board. */
export function useHighlights(doc: Y.Doc, digest: Digest | null): Highlight[] {
	const [version, setVersion] = useState(0);
	useEffect(() => {
		const shapes = shapesMap(doc);
		const bump = () => setVersion((n) => n + 1);
		shapes.observe(bump);
		return () => shapes.unobserve(bump);
	}, [doc]);
	return useMemo(() => {
		void version;
		if (!digest || digest.since === null) return [];
		const shapes = shapesMap(doc);
		const byRef = new Map<string, string[]>();
		for (const [id, shape] of shapes) {
			const ref = shape.get("ref");
			if (shape.get("type") === "card" && typeof ref === "string") {
				byRef.set(ref, [...(byRef.get(ref) ?? []), id]);
			}
		}
		return highlightsFor(
			digest,
			(id) => shapes.has(id),
			(key) => byRef.get(key) ?? [],
		);
	}, [doc, digest, version]);
}

function actorUser(actor: Actor) {
	return {
		name: actorName(actor),
		color: actor.id !== undefined ? personColor(actor.id) : "#7a7f87",
		avatarUrl: actor.avatarUrl,
	};
}

/** A short, human span: "3 days", "2 hours". */
export function awayFor(since: number, now: number): string {
	const ago = Math.max(0, now - since);
	const minutes = Math.max(1, Math.round(ago / 60_000));
	const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
	if (minutes < 60) return plural(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (hours < 36) return plural(hours, "hour");
	const days = Math.round(hours / 24);
	if (days < 14) return plural(days, "day");
	return plural(Math.round(days / 7), "week");
}

/** When a visit was, for the digest: "14:05", "Tuesday 14:05", "3 Oct". */
export function sinceWhen(since: number, now: number): string {
	const date = new Date(since);
	const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	const ago = now - since;
	if (ago < 18 * 3_600_000 && date.getDate() === new Date(now).getDate()) return time;
	if (ago < 6 * 86_400_000) {
		return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
	}
	return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The top bar's button: what's new since your last visit, once there's a digest. */
export function SinceButton({
	doc,
	store = sinceStore,
	login,
	youId,
}: {
	doc: Y.Doc;
	store?: SinceStore;
	login?: string;
	youId: number | null;
}) {
	const state = useSince(store);
	const highlights = useHighlights(doc, state.digest);
	const { threads } = useComments();
	const comments = useMemo(
		() => commentDigest(threads.values(), state.digest?.since ?? null, { id: youId, login }),
		[threads, state.digest?.since, youId, login],
	);
	const unseen = highlights.filter((h) => !state.seen.has(h.shape)).length;
	const total = unseen + comments.started.length + comments.replied.length;
	useEffect(() => {
		store.openForComments(comments.started.length + comments.replied.length);
	}, [store, comments.started.length, comments.replied.length]);
	if (!state.digest || state.digest.since === null || (total === 0 && !state.panel)) return null;
	return (
		<button
			type="button"
			className="since-button"
			aria-pressed={state.panel}
			aria-label={`Since you were here: ${total} new`}
			title="What changed since you were last here"
			onClick={() => store.setPanel(!state.panel)}
		>
			<SinceIcon size={15} />
			<span>New</span>
			{total > 0 && <span className="since-button-count">{total}</span>}
		</button>
	);
}

export function SincePanel({
	doc,
	login,
	youId,
	onJump,
	onOpenThread,
	store = sinceStore,
}: {
	doc: Y.Doc;
	login?: string;
	youId: number | null;
	/** Go to a shape on the canvas. */
	onJump: (shape: string) => void;
	onOpenThread: (thread: CommentThread) => void;
	store?: SinceStore;
}) {
	const state = useSince(store);
	const { threads } = useComments();
	const highlights = useHighlights(doc, state.digest);
	const now = useNow();
	const [step, setStep] = useState(-1);
	const digest = state.digest;
	const comments = useMemo(
		() => commentDigest(threads.values(), digest?.since ?? null, { id: youId, login }),
		[threads, digest?.since, youId, login],
	);

	useEffect(() => {
		if (!state.panel) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") store.setPanel(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [state.panel, store]);

	if (!state.panel || !digest || digest.since === null) return null;
	const since = digest.since;
	const people = editsByPerson(digest.edits);
	const commentCount = comments.started.length + comments.replied.length;
	const nothing =
		digest.edits.length === 0 &&
		digest.cards.length === 0 &&
		digest.pushes.length === 0 &&
		commentCount === 0;

	const go = (i: number) => {
		const count = highlights.length;
		if (count === 0) return;
		const next = ((i % count) + count) % count;
		setStep(next);
		const target = highlights[next];
		if (target) onJump(target.shape);
	};

	return (
		<aside className="since-panel" aria-label="Since you were here">
			<header className="since-head">
				<span className="since-head-icon">
					<SinceIcon size={18} />
				</span>
				<div>
					<h2>Since you were here</h2>
					<p>
						Away {awayFor(since, now)}, since{" "}
						<time dateTime={new Date(since).toISOString()}>{sinceWhen(since, now)}</time>
					</p>
				</div>
				<button
					type="button"
					className="since-close"
					aria-label="Close"
					onClick={() => store.setPanel(false)}
				>
					<CloseIcon />
				</button>
			</header>

			<div className="since-body">
				{nothing && (
					<div className="since-empty">
						<strong>All quiet</strong>
						<p>Nothing changed while you were away.</p>
					</div>
				)}

				{people.length > 0 && (
					<section className="since-section" aria-label="On the board">
						<h3>On the board</h3>
						<ul className="since-people">
							{people.map((group, i) => (
								<PersonEdits
									doc={doc}
									key={group.by.id ?? `${group.by.kind}${i}`}
									by={group.by}
									edits={group.edits}
									index={i}
									seen={state.seen}
									onJump={onJump}
								/>
							))}
						</ul>
						{digest.more > 0 && <p className="since-more">…and {digest.more} more changes</p>}
					</section>
				)}

				{digest.cards.length > 0 && (
					<section className="since-section" aria-label="On GitHub">
						<h3>On GitHub</h3>
						<ul className="since-cards">
							{digest.cards.map((activity, i) => (
								<CardLine
									key={`${activity.key}:${activity.kind}`}
									doc={doc}
									activity={activity}
									index={i}
									now={now}
									onJump={onJump}
								/>
							))}
						</ul>
					</section>
				)}

				{digest.pushes.length > 0 && (
					<section className="since-section" aria-label="Pushed">
						<h3>Pushed</h3>
						<ul className="since-pushes">
							{digest.pushes.map((push, i) => (
								<li key={push.pushId} style={{ "--i": i } as React.CSSProperties}>
									<span className="since-glyph" data-kind="push">
										<PushIcon size={14} />
									</span>
									<span className="since-line-main">
										<span>
											<strong>{push.by.name || push.by.login}</strong> pushed {push.applied}{" "}
											{push.applied === 1 ? "change" : "changes"}
											{push.failed > 0 && (
												<span className="since-failed"> · {push.failed} failed</span>
											)}
										</span>
										<span className="since-summaries">{push.summaries.join(" · ")}</span>
									</span>
									<time>{relativeTime(push.at, now)}</time>
								</li>
							))}
						</ul>
					</section>
				)}

				{commentCount > 0 && (
					<section className="since-section" aria-label="Comments">
						<h3>
							Comments
							{comments.mentioned.length > 0 && (
								<span className="since-mentions">
									{comments.mentioned.length} mention{comments.mentioned.length === 1 ? "" : "s"} of
									you
								</span>
							)}
						</h3>
						<ul className="since-comments">
							{[...comments.started, ...comments.replied].slice(0, 12).map((thread, i) => {
								const author = starter(thread);
								const fresh = liveMessages(thread).filter(
									(m) => m.at > since && m.author.id !== youId,
								);
								const isNew = comments.started.includes(thread);
								// A new thread by who started it; replies by the latest.
								const shown = isNew ? fresh[0] : fresh.at(-1);
								if (!author || !shown) return null;
								const replies = isNew ? fresh.length - 1 : fresh.length;
								return (
									<li key={thread.id} style={{ "--i": i } as React.CSSProperties}>
										<button type="button" onClick={() => onOpenThread(thread)}>
											<Avatar user={authorUser(shown.author)} />
											<span className="since-line-main">
												<span>
													<strong>{shown.author.name || shown.author.login}</strong>{" "}
													{isNew ? "commented" : "replied"}
													{replies > (isNew ? 0 : 1) && (
														<span className="since-replies">
															{" "}
															· {replies} {replies === 1 ? "reply" : "replies"}
														</span>
													)}
													{comments.mentioned.includes(thread) && (
														<span className="since-you"> · mentions you</span>
													)}
												</span>
												<span className="since-quote">{shown.body}</span>
											</span>
											<BubbleIcon size={14} />
										</button>
									</li>
								);
							})}
						</ul>
					</section>
				)}
			</div>

			<footer className="since-foot">
				{highlights.length > 0 && (
					<div className="since-stepper" role="group" aria-label="Changes on the board">
						<button type="button" aria-label="Previous change" onClick={() => go(step - 1)}>
							<ChevronIcon dir="left" size={14} />
						</button>
						<span aria-live="polite">
							{step < 0
								? `${highlights.length} on the board`
								: `${step + 1} of ${highlights.length}`}
						</span>
						<button type="button" aria-label="Next change" onClick={() => go(step + 1)}>
							<ChevronIcon size={14} />
						</button>
					</div>
				)}
				<button type="button" className="since-seen" onClick={() => store.markAllSeen()}>
					Mark all as seen
				</button>
			</footer>
		</aside>
	);
}

function PersonEdits({
	doc,
	by,
	edits,
	index,
	seen,
	onJump,
}: {
	doc: Y.Doc;
	by: Actor;
	edits: EditEntry[];
	index: number;
	seen: ReadonlySet<string>;
	onJump: (shape: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const jumpable = edits.filter((edit) => edit.kind !== "removed");
	const unseen = jumpable.filter((edit) => !seen.has(edit.shape)).length;
	return (
		<li style={{ "--i": index } as React.CSSProperties} data-open={open || undefined}>
			<button
				type="button"
				className="since-person"
				aria-expanded={open}
				onClick={() => {
					if (jumpable.length === 1 && jumpable[0]) onJump(jumpable[0].shape);
					else setOpen((value) => !value);
				}}
			>
				<Avatar user={actorUser(by)} />
				<span className="since-line-main">
					<span>
						<strong>{actorName(by)}</strong> {describeEdits(edits)}
					</span>
				</span>
				{unseen > 0 && <span className="since-dot" aria-label={`${unseen} unseen`} />}
				{jumpable.length > 1 && <ChevronIcon size={13} />}
			</button>
			{open && (
				<ul className="since-edits">
					{jumpable.slice(0, 30).map((edit) => (
						<li key={`${edit.shape}:${edit.kind}`}>
							<button type="button" onClick={() => onJump(edit.shape)} data-kind={edit.kind}>
								<span className="since-kind" data-kind={edit.kind}>
									{edit.kind === "added" ? "New" : edit.kind === "moved" ? "Moved" : "Edited"}
								</span>
								<EditTarget doc={doc} shape={edit.shape} type={edit.type} />
							</button>
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

/** What an edit was to, in a few words. */
function EditTarget({ doc, shape, type }: { doc: Y.Doc; shape: string; type: string }) {
	const map = shapesMap(doc).get(shape);
	const text = map?.get("text") ?? map?.get("title");
	const ref = map?.get("ref");
	const card = typeof ref === "string" ? cardStore.get(ref) : undefined;
	const label =
		card && !("missing" in card)
			? `${shortRef(card.key, repoKeyOf(card.key))} ${card.title}`
			: typeof text === "string" && text.trim()
				? text.trim()
				: `A ${type === "text" ? "text block" : type}`;
	return <span className="since-target">{label}</span>;
}

function CardLine({
	doc,
	activity,
	index,
	now,
	onJump,
}: {
	doc: Y.Doc;
	activity: CardActivity;
	index: number;
	now: number;
	onJump: (shape: string) => void;
}) {
	const card = useCard(activity.key);
	const shape = [...shapesMap(doc).entries()].find(
		([, map]) => map.get("type") === "card" && map.get("ref") === activity.key,
	)?.[0];
	const live = card && !("missing" in card) ? card : null;
	return (
		<li style={{ "--i": index } as React.CSSProperties}>
			<button type="button" disabled={!shape} onClick={() => shape && onJump(shape)}>
				<span className="since-glyph" data-kind={activity.kind}>
					{live ? <StateIcon card={live} /> : <span className="since-glyph-dot" />}
				</span>
				<span className="since-line-main">
					<span>
						<strong className="mono">{shortRef(activity.key, repoKeyOf(activity.key))}</strong>{" "}
						<span className="since-activity" data-kind={activity.kind}>
							{describeCardActivity(activity)}
						</span>
					</span>
					{live && <span className="since-card-title">{live.title}</span>}
				</span>
				<time>{relativeTime(activity.at, now)}</time>
			</button>
		</li>
	);
}
