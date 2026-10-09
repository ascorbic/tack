import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { inboxQuery, setInbox } from "../../shared/inbox.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import { type ShapeProps, LOCAL_ORIGIN } from "../../shared/shapes.ts";
import { SUBMIT_HINT } from "../actions/Popover.tsx";
import { inboxStore, usePreview } from "./store.ts";
import { useBoardRefs } from "./useTray.ts";

// Setting up an inbox: the query, with a live count of what it matches as
// you type (run as you, on the server), and a few starting points built
// from the repositories already on the board.

const PREVIEW_WAIT_MS = 350;

export function InboxEditor({
	doc,
	id,
	shape,
	onDone,
}: {
	doc: Y.Doc;
	id: string;
	shape: ShapeProps;
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

	const save = () => {
		if (!q.trim()) return;
		setInbox(doc, id, inboxQuery(q, host), LOCAL_ORIGIN);
		onDone();
	};

	const suggestions = suggestionsFor(repos.find((r) => r.host === host)?.repo ?? "owner/repo");

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
			<footer className="inbox-editor-foot">
				{shape.inbox && (
					<button
						type="button"
						className="inbox-link inbox-remove"
						onClick={() => {
							setInbox(doc, id, null, LOCAL_ORIGIN);
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

function suggestionsFor(repo: string): { label: string; q: string }[] {
	return [
		{ label: "Untriaged issues", q: `repo:${repo} is:issue is:open no:label` },
		{ label: "New bugs", q: `repo:${repo} is:issue is:open label:bug` },
		{ label: "Good first issues", q: `repo:${repo} is:open label:"good first issue"` },
		{ label: "Open pull requests", q: `repo:${repo} is:pr is:open` },
	];
}
