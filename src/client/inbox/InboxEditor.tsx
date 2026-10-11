import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { inboxQuery, inboxSections, setInbox } from "../../shared/inbox.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import {
	type Rule,
	type RuleAuthor,
	addRule,
	deleteRule,
	listRules,
	ruleProblem,
} from "../../shared/rules.ts";
import { type ShapeProps, LOCAL_ORIGIN, shapesMap } from "../../shared/shapes.ts";
import { inboxSuggestions } from "../../shared/widgetRegistry.ts";
import { SUBMIT_HINT } from "../actions/Popover.tsx";
import { QueryHelp, useSearchContext } from "../widgets/QueryHelp.tsx";
import { inboxStore, usePreview } from "./store.ts";
import { useBoardRefs } from "./useTray.ts";

// Setting up an inbox: the query, with a live count of what it matches as
// you type (run as you, on the server), help with what a search in plain
// words meant, a few starting points (the section's own name as a label,
// when the repository has one, then the ready-made searches lists use), a
// note when another inbox already collects some of the same items, and a
// switch to place new matches straight in (a rule) rather than queue them.

const PREVIEW_WAIT_MS = 350;

export function InboxEditor({
	doc,
	id,
	shape,
	user,
	onDone,
}: {
	doc: Y.Doc;
	id: string;
	shape: ShapeProps;
	/** Who's editing: the author of a rule the switch makes. */
	user?: RuleAuthor;
	onDone: () => void;
}) {
	const refs = useBoardRefs(doc);
	const repos = useMemo(() => {
		const out = new Map<string, { host: string; repo: string }>();
		for (const key of refs) {
			const repoKey = repoKeyOf(key);
			const slash = repoKey.indexOf("/");
			out.set(repoKey, { host: repoKey.slice(0, slash), repo: repoKey.slice(slash + 1) });
		}
		return [...out.values()];
	}, [refs]);
	const existing = shape.inbox?.query;
	const [host, setHost] = useState(existing?.host ?? repos[0]?.host ?? "github.com");
	const [q, setQ] = useState(existing?.q ?? "");
	const hosts = useMemo(
		() => [...new Set(["github.com", ...repos.map((r) => r.host), host])],
		[repos, host],
	);
	const input = useRef<HTMLTextAreaElement>(null);

	// The live count: ask once typing pauses, and only believe answers that
	// came after the latest ask.
	const [askedAt, setAskedAt] = useState(0);
	const preview = usePreview(id);
	useEffect(() => {
		if (!q.trim()) return;
		const timer = setTimeout(() => {
			setAskedAt(performance.now());
			inboxStore.preview(id, inboxQuery(q, host));
		}, PREVIEW_WAIT_MS);
		return () => clearTimeout(timer);
	}, [id, q, host]);
	const answer = preview && preview.received >= askedAt && askedAt > 0 ? preview.result : null;
	const pending = q.trim() !== "" && !answer;

	useEffect(() => {
		const el = input.current;
		if (!el) return;
		el.focus({ preventScroll: true });
		el.setSelectionRange(el.value.length, el.value.length);
	}, []);

	// The rule that places this inbox's matches straight in, if there is one.
	const placing = useMemo(() => placingRule(doc, id, existing?.q), [doc, id, existing?.q]);
	const [autoPlace, setAutoPlace] = useState(placing !== null);
	const query = inboxQuery(q, host);
	const ruleIssue = q.trim()
		? ruleProblem(doc, { kind: "matches", query }, { kind: "section", section: id })
		: null;

	const save = () => {
		if (!q.trim()) return;
		doc.transact(() => {
			setInbox(doc, id, query, LOCAL_ORIGIN);
			// Placing straight in is a rule beside the inbox: kept in step with its search.
			const keep = autoPlace && !ruleIssue;
			if (
				placing &&
				(!keep || placing.trigger.kind !== "matches" || placing.trigger.query.q !== query.q)
			) {
				deleteRule(doc, placing.id);
			}
			if (
				keep &&
				(!placing || placing.trigger.kind !== "matches" || placing.trigger.query.q !== query.q)
			) {
				addRule(
					doc,
					{ kind: "matches", query },
					{ kind: "section", section: id },
					user ?? { name: "Someone" },
				);
			}
		}, LOCAL_ORIGIN);
		onDone();
	};

	const context = useSearchContext(host);
	const repo = repos.find((r) => r.host === host)?.repo ?? context.repo ?? "owner/repo";
	const title = typeof shape.title === "string" ? shape.title : "";
	const suggestions = inboxSuggestions(repo, title, context.labels);
	const overlaps = useOverlaps(doc, id, answer?.kind === "search" ? answer.items : null);

	return (
		<form
			className="inbox-editor"
			onSubmit={(event) => {
				event.preventDefault();
				save();
			}}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Escape") {
					event.preventDefault();
					onDone();
				}
				if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
					event.preventDefault();
					save();
				}
			}}
		>
			<label className="inbox-editor-label" htmlFor={`inbox-q-${id}`}>
				Collect new matches for
			</label>
			<div className="inbox-editor-field">
				{hosts.length > 1 && (
					<select
						className="inbox-host mono"
						aria-label="Forge"
						value={host}
						onChange={(event) => setHost(event.target.value)}
					>
						{hosts.map((h) => (
							<option key={h} value={h}>
								{h}
							</option>
						))}
					</select>
				)}
				<textarea
					ref={input}
					id={`inbox-q-${id}`}
					className="inbox-editor-input mono"
					rows={2}
					spellCheck={false}
					placeholder="repo:owner/name is:issue is:open no:label"
					value={q}
					onChange={(event) => setQ(event.target.value)}
				/>
			</div>
			<div
				className="inbox-count"
				data-state={pending ? "pending" : (answer?.kind ?? "idle")}
				aria-live="polite"
			>
				{!q.trim() ? (
					<span>Write a search, as on GitHub.</span>
				) : pending ? (
					<span className="inbox-count-dots">Counting</span>
				) : answer?.kind === "search" ? (
					<span>
						<strong key={answer.total} className="inbox-count-number">
							{answer.total.toLocaleString()}
						</strong>{" "}
						{answer.total === 1 ? "match" : "matches"} now
						{answer.incomplete ? " (at least)" : ""}
					</span>
				) : answer?.kind === "error" ? (
					<span>{answer.message}</span>
				) : null}
			</div>
			<QueryHelp q={q} host={host} onUse={(value) => setQ(value)} />
			{overlaps.length > 0 && (
				<p className="inbox-overlap" role="note">
					{overlaps
						.map(({ title: other, count }) => `${other} already collects ${count} of these`)
						.join("; ")}
					. Each item waits in one tray: the narrower search’s.
				</p>
			)}
			<div className="inbox-suggestions" role="group" aria-label="Starting points">
				{suggestions.map((s) => (
					<button
						key={s.label}
						type="button"
						className="inbox-suggestion"
						data-active={q.trim() === s.q}
						onClick={() => {
							setQ(s.q);
							input.current?.focus();
						}}
					>
						{s.label}
					</button>
				))}
			</div>
			<label
				className="inbox-auto"
				title={ruleIssue ?? "A rule places them as they arrive; the tray stays empty"}
				data-disabled={Boolean(ruleIssue) || undefined}
			>
				<input
					type="checkbox"
					checked={autoPlace && !ruleIssue}
					disabled={Boolean(ruleIssue)}
					onChange={(event) => setAutoPlace(event.target.checked)}
				/>
				<span>
					Place new matches straight in
					<span className="inbox-auto-note">
						{ruleIssue && autoPlace
							? ruleIssue
							: "Skips the tray, as a rule. Leave off to review them first."}
					</span>
				</span>
			</label>
			<footer className="inbox-editor-foot">
				{shape.inbox && (
					<button
						type="button"
						className="inbox-link inbox-remove"
						onClick={() => {
							doc.transact(() => {
								setInbox(doc, id, null, LOCAL_ORIGIN);
								if (placing) deleteRule(doc, placing.id);
							}, LOCAL_ORIGIN);
							onDone();
						}}
					>
						Stop collecting
					</button>
				)}
				<span className="inbox-editor-buttons">
					<button type="button" className="inbox-button" onClick={onDone}>
						Cancel
					</button>
					<button type="submit" className="inbox-button primary" disabled={!q.trim()}>
						{shape.inbox ? "Save" : "Start collecting"}
						<kbd>{SUBMIT_HINT}</kbd>
					</button>
				</span>
			</footer>
		</form>
	);
}

/** The rule placing an inbox's matches straight into its section, for its search. */
function placingRule(doc: Y.Doc, section: string, q: string | undefined): Rule | null {
	if (!q) return null;
	return (
		listRules(doc).find(
			(rule) =>
				rule.action.kind === "section" &&
				rule.action.section === section &&
				rule.trigger.kind === "matches" &&
				rule.trigger.query.q === q,
		) ?? null
	);
}

/** Other inboxes on the board whose latest results share items with these. */
function useOverlaps(
	doc: Y.Doc,
	id: string,
	items: { key: string }[] | null,
): { title: string; count: number }[] {
	return useMemo(() => {
		if (!items || items.length === 0) return [];
		const keys = new Set(items.map((item) => item.key));
		const out: { title: string; count: number }[] = [];
		for (const other of inboxSections(doc).keys()) {
			if (other === id) continue;
			const result = inboxStore.get(other)?.result;
			if (result?.kind !== "search") continue;
			const count = result.items.filter((item) => keys.has(item.key)).length;
			if (count === 0) continue;
			const title = shapesMap(doc).get(other)?.get("title");
			out.push({
				title: typeof title === "string" && title ? `“${title}”` : "Another inbox",
				count,
			});
		}
		return out;
	}, [doc, id, items]);
}
