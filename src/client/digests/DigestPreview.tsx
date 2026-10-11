import type { CSSProperties, ReactNode } from "react";
import {
	type DigestAction,
	type WeeklyDigest,
	describeRange,
	digestHighlights,
	isQuietWeek,
} from "../../shared/digests.ts";
import { safeUrl } from "../changes/inline.ts";

// A weekly digest as its reader gets it (#68): the board, the week, what
// stood out, then decisions, action items, GitHub, pushes and who did what.
// Board-free, so the gallery and the playground draw it too. Sections come
// in one after another, so a fresh preview reads top to bottom.

export function DigestPreview({ digest, label }: { digest: WeeklyDigest; label?: string }) {
	const highlights = digestHighlights(digest);
	const quiet = isQuietWeek(digest);
	let order = 0;
	const section = (title: string, rows: ReactNode[]) =>
		rows.length === 0 ? null : (
			<section className="digest-section" style={{ "--i": order++ } as CSSProperties}>
				<h4>{title}</h4>
				<ul>{rows}</ul>
			</section>
		);
	const fresh = digest.actions.opened.filter(
		(a) => !digest.actions.done.some((done) => done.id === a.id),
	);
	return (
		<article className="digest-paper" aria-label={label ?? "Digest preview"}>
			<header className="digest-paper-head">
				<span className="digest-paper-brand" aria-hidden="true">
					📌 Tack · weekly digest
				</span>
				<h3>{digest.board.title}</h3>
				<p>{describeRange(digest.from, digest.to, digest.timeZone, true)}</p>
				{highlights.length > 0 && (
					<ul className="digest-highlights" aria-label="Highlights">
						{highlights.map((highlight) => (
							<li key={highlight}>{highlight}</li>
						))}
					</ul>
				)}
			</header>
			{quiet ? (
				<div className="digest-quiet">
					<span className="digest-quiet-mark" aria-hidden="true" />
					<p>
						A quiet week so far: nothing’s changed. Quiet weeks send nothing, so nobody gets an
						empty digest.
					</p>
				</div>
			) : (
				<>
					{section(
						"Decisions",
						digest.decisions.map((d) => (
							<li key={d.id} className="digest-row">
								<Glyph kind="decision" />
								<span>
									<strong>{d.title}</strong>
									{d.by && <span className="digest-quiet-text">, decided by {d.by}</span>}
								</span>
							</li>
						)),
					)}
					{section("Action items", [
						...digest.actions.done.map((a) => (
							<ActionRow key={`d${a.id}`} action={a} kind="done" />
						)),
						...fresh.map((a) => <ActionRow key={`n${a.id}`} action={a} kind="new" />),
						...digest.actions.overdue.map((a) => (
							<ActionRow key={`o${a.id}`} action={a} kind="overdue" />
						)),
					])}
					{section(
						"On GitHub",
						digest.items.map((item) => (
							<li key={item.key} className="digest-row">
								<Glyph kind={item.kind === "pull" ? "pull" : "issue"} />
								<span>
									<a href={safeUrl(item.url)} target="_blank" rel="noreferrer">
										{item.title}
									</a>{" "}
									<span className="digest-ref">{item.ref}</span>
									<span className="digest-activity">
										{item.activity.map((words, i) => (
											<span key={`${words}${i}`} data-tone={tone(words)}>
												{words}
											</span>
										))}
									</span>
								</span>
							</li>
						)),
					)}
					{section(
						"Pushed from the board",
						digest.pushes.map((push) => {
							const total = push.applied + push.failed;
							return (
								<li key={`${push.at}${push.by}`} className="digest-row">
									<Glyph kind="push" />
									<span>
										<strong>{push.by}</strong> pushed {total} change{total === 1 ? "" : "s"}
										{push.failed > 0 && (
											<span className="digest-late"> ({push.failed} failed)</span>
										)}
										{push.summaries.length > 0 && (
											<span className="digest-quiet-text digest-block">
												{push.summaries.join("; ")}
											</span>
										)}
									</span>
								</li>
							);
						}),
					)}
					{section("On the board", [
						...digest.people.map((person) => (
							<li key={person.login ?? person.name} className="digest-row">
								<span className="digest-initial" aria-hidden="true" data-hue={hue(person.name)}>
									{person.name.slice(0, 1).toUpperCase()}
								</span>
								<span>
									<strong>{person.name}</strong> {person.summary}
								</span>
							</li>
						)),
						...(digest.moreEdits > 0
							? [
									<li key="more" className="digest-row digest-quiet-text">
										<span aria-hidden="true" />
										<span>…and {digest.moreEdits} more changes</span>
									</li>,
								]
							: []),
					])}
				</>
			)}
		</article>
	);
}

function ActionRow({ action, kind }: { action: DigestAction; kind: "done" | "new" | "overdue" }) {
	const label = { done: "Done", new: "New", overdue: "Overdue" }[kind];
	return (
		<li className="digest-row" data-kind={kind}>
			<Glyph kind={kind} />
			<span>
				<span className="visually-hidden">{label}: </span>
				<span className="digest-action-text">{action.text}</span>
				{action.owner && <span className="digest-quiet-text"> @{action.owner}</span>}
				{action.dueWords && kind !== "done" && (
					<span className={kind === "overdue" ? "digest-late" : "digest-quiet-text"}>
						{kind === "overdue" ? ` · ${action.dueWords}` : ` · due ${action.dueWords}`}
					</span>
				)}
			</span>
		</li>
	);
}

function tone(words: string): string {
	if (words === "merged" || words === "closed" || words === "CI passing" || words === "approved")
		return "good";
	if (words === "CI failing" || words === "changes requested") return "bad";
	return "neutral";
}

/** One of eight hues per name, so people keep a colour from week to week. */
function hue(name: string): number {
	let h = 0;
	for (const char of name) h = (h * 31 + char.charCodeAt(0)) | 0;
	return Math.abs(h) % 8;
}

function Glyph({
	kind,
}: {
	kind: "decision" | "done" | "new" | "overdue" | "issue" | "pull" | "push";
}) {
	const paths: Record<typeof kind, ReactNode> = {
		decision: <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" />,
		done: <path d="m4 8.5 2.5 2.5L12 5.5" />,
		new: <path d="M8 4v8M4 8h8" />,
		overdue: (
			<>
				<circle cx="8" cy="8" r="5.5" />
				<path d="M8 5v3.5M8 10.8v.2" />
			</>
		),
		issue: (
			<>
				<circle cx="8" cy="8" r="5.5" />
				<circle cx="8" cy="8" r="1" />
			</>
		),
		pull: (
			<>
				<circle cx="4.5" cy="4" r="1.5" />
				<circle cx="4.5" cy="12" r="1.5" />
				<circle cx="11.5" cy="12" r="1.5" />
				<path d="M4.5 5.5v5M11.5 10.5V7a2 2 0 0 0-2-2H7.5" />
			</>
		),
		push: <path d="M8 13V3.5M4.5 7 8 3.5 11.5 7" />,
	};
	return (
		<svg
			className="digest-glyph"
			data-kind={kind}
			width="16"
			height="16"
			viewBox="0 0 16 16"
			aria-hidden="true"
		>
			{paths[kind]}
		</svg>
	);
}
