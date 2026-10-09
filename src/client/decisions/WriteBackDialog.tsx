import {
	type FormEvent,
	type ReactNode,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type * as Y from "yjs";
import {
	type AdrInput,
	type AdrLink,
	DECISIONS_DIR,
	adrMarkdown,
	adrPath,
	discussionMarkdown,
	itemUrl,
	nextAdrNumber,
	padNumber,
	stagedRecordPaths,
	writeBackOperation,
} from "../../shared/adr.ts";
import { isMissing } from "../../shared/cards.ts";
import { listChanges, unstageChanges } from "../../shared/changes.ts";
import { stageWriteBack, statusOf, tally } from "../../shared/decisions.ts";
import type { RepoMeta } from "../../shared/push.ts";
import { DEFAULT_HOST, repoKeyOf } from "../../shared/refs.ts";
import { cardRefs, readShape, shapesMap } from "../../shared/shapes.ts";
import { cardStore } from "../cardStore.ts";
import { scaledDuration } from "../motion.ts";
import { transactLocal } from "../undo.ts";
import { repoApi } from "./api.ts";
import { DecisionContext } from "./context.ts";
import { DiscussionIcon, RecordIcon } from "./icons.tsx";

type Kind = "pr" | "discussion";

type Load<T> =
	| { state: "loading" }
	| { state: "ready"; value: T }
	| { state: "error"; error: string };

/**
 * Repositories to offer, best first: those of the decision's linked items
 * (most linked first), then the rest of the board's.
 */
export function candidateRepos(boardKeys: Iterable<string>, linked: string[]): string[] {
	const score = new Map<string, number>();
	for (const key of boardKeys) {
		const repo = repoKeyOf(key);
		score.set(repo, (score.get(repo) ?? 0) + 1);
	}
	for (const key of linked) {
		const repo = repoKeyOf(key);
		score.set(repo, (score.get(repo) ?? 0) + 1000);
	}
	return [...score.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.map(([repo]) => repo);
}

/** A repository typed by hand: `owner/repo`, a GitHub URL, or a full key. */
export function parseRepoInput(input: string): string | null {
	const text = input
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
	const parts = text.split("/");
	if (parts.length === 2 && parts.every((part) => /^[\w.-]+$/.test(part))) {
		return `${DEFAULT_HOST}/${text}`.toLowerCase();
	}
	if (
		parts.length === 3 &&
		parts[0]?.includes(".") &&
		parts.slice(1).every((p) => /^[\w.-]+$/.test(p))
	) {
		return text.toLowerCase();
	}
	return null;
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

/** A sensible default Discussion category, if the repository has one like it. */
function defaultCategory(categories: string[]): string {
	return (
		categories.find((c) => /decision|adr|rfc/i.test(c)) ??
		categories.find((c) => /announce/i.test(c)) ??
		categories.find((c) => /general/i.test(c)) ??
		categories[0] ??
		""
	);
}

/**
 * Stage writing a decided decision back: as an ADR pull request or a
 * Discussion post, with a live preview of exactly what will be written.
 * Nothing reaches the forge until someone pushes the board's changes.
 */
export function WriteBackDialog({
	doc,
	decisionId,
	linked,
	retrying,
	onClose,
}: {
	doc: Y.Doc;
	decisionId: string;
	linked: string[];
	/** A failed write-back this one replaces. */
	retrying?: string;
	onClose: () => void;
}) {
	const { user, boardUrl } = useContext(DecisionContext);
	const dialog = useRef<HTMLDialogElement>(null);
	const headingId = useId();
	const [closing, setClosing] = useState(false);

	// The decision as it is when the dialog opens.
	const [decision] = useState(() => {
		const shape = shapesMap(doc).get(decisionId);
		return shape ? readShape(shape) : null;
	});
	const repos = useMemo(() => candidateRepos(cardRefs(doc), linked), [doc, linked]);

	const [kind, setKind] = useState<Kind>("pr");
	const [repo, setRepo] = useState(repos[0] ?? "");
	const [typedRepo, setTypedRepo] = useState("");
	const [category, setCategory] = useState("");
	const [context, setContext] = useState(decision?.text ?? "");
	const [decisionText, setDecisionText] = useState(decision?.title ?? "");
	const [consequences, setConsequences] = useState("");
	const [meta, setMeta] = useState<Load<RepoMeta>>({ state: "loading" });
	const [files, setFiles] = useState<Load<string[]>>({ state: "loading" });

	const target = repos.length > 0 ? repo : parseRepoInput(typedRepo);

	useEffect(() => {
		dialog.current?.showModal();
	}, []);

	useEffect(() => {
		if (!target) return;
		const abort = new AbortController();
		setMeta({ state: "loading" });
		setFiles({ state: "loading" });
		const failed = (error: unknown) =>
			abort.signal.aborted
				? null
				: {
						state: "error" as const,
						error: error instanceof Error ? error.message : String(error),
					};
		repoApi.meta(target, abort.signal).then(
			(value) => {
				if (abort.signal.aborted) return;
				setMeta({ state: "ready", value });
				setCategory((current) =>
					value.discussionCategories.includes(current)
						? current
						: defaultCategory(value.discussionCategories),
				);
			},
			(error) => {
				const state = failed(error);
				if (state) setMeta(state);
			},
		);
		repoApi.files(target, DECISIONS_DIR, abort.signal).then(
			(value) => !abort.signal.aborted && setFiles({ state: "ready", value }),
			(error) => {
				const state = failed(error);
				if (state) setFiles(state);
			},
		);
		return () => abort.abort();
	}, [target]);

	const categories = meta.state === "ready" ? meta.value.discussionCategories : [];
	const discussionsOff = meta.state === "ready" && categories.length === 0;
	useEffect(() => {
		if (discussionsOff && kind === "discussion") setKind("pr");
	}, [discussionsOff, kind]);

	const staged = target ? stagedRecordPaths(listChanges(doc), target) : [];
	const number = nextAdrNumber(files.state === "ready" ? files.value : [], staged);

	const links: AdrLink[] = linked.map((key) => {
		const card = cardStore.get(key);
		const live = card && !isMissing(card) ? card : null;
		return { key, title: live?.title, url: live?.url ?? itemUrl(key) ?? key };
	});
	const counts = tally(decision?.votes);
	const input: AdrInput = {
		title: decision?.title ?? "",
		status: decision ? statusOf(decision) : "decided",
		date: decision?.decidedAt?.slice(0, 10) ?? today(),
		context,
		decision: decisionText,
		consequences,
		links,
		boardUrl,
		votes: { agree: counts.agree.length, disagree: counts.disagree.length },
	};
	const markdown = kind === "pr" ? adrMarkdown({ ...input, number }) : discussionMarkdown(input);

	const ready =
		!!target &&
		!!decision &&
		(kind === "pr" ? files.state !== "loading" : meta.state === "ready" && category !== "");

	const close = () => {
		if (closing) return;
		setClosing(true);
		setTimeout(() => {
			dialog.current?.close();
			onClose();
		}, scaledDuration(140));
	};

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!ready || !target) return;
		const op = writeBackOperation(
			input,
			kind === "pr"
				? { kind: "pr", repo: target, number }
				: { kind: "discussion", repo: target, category },
		);
		transactLocal(doc, () => {
			if (retrying) unstageChanges(doc, [retrying]);
			stageWriteBack(doc, decisionId, op, {
				name: user?.name ?? "Someone",
				color: user?.color,
				login: user?.login,
			});
		});
		close();
	};

	const repoName = (key: string) => key.slice(key.indexOf("/") + 1);
	const path = adrPath(number, decision?.title ?? "");
	const writable = meta.state === "ready" ? meta.value.writable : true;

	return createPortal(
		<dialog
			ref={dialog}
			className="writeback-dialog"
			aria-labelledby={headingId}
			data-closing={closing || undefined}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onClick={(event) => {
				if (event.target === dialog.current) close();
			}}
		>
			<form className="writeback" onSubmit={submit}>
				<header className="writeback-head">
					<div>
						<p className="writeback-kicker">Write back a decision</p>
						<h2 id={headingId}>{decision?.title || "Untitled decision"}</h2>
					</div>
					<button type="button" className="writeback-close" aria-label="Close" onClick={close}>
						<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
							<path d="M4 4l8 8M12 4l-8 8" />
						</svg>
					</button>
				</header>

				<div className="writeback-grid">
					<div className="writeback-form">
						<div className="writeback-kinds" role="radiogroup" aria-label="Write it as">
							<KindOption
								checked={kind === "pr"}
								onSelect={() => setKind("pr")}
								icon={<RecordIcon size={16} />}
								title="ADR pull request"
								detail={`Adds record ${padNumber(number)} for review`}
							/>
							<KindOption
								checked={kind === "discussion"}
								disabled={discussionsOff}
								onSelect={() => setKind("discussion")}
								icon={<DiscussionIcon size={16} />}
								title="Discussion post"
								detail={
									discussionsOff
										? "Discussions are off for this repository"
										: "Announces it for comment"
								}
							/>
						</div>

						<label className="writeback-field">
							<span>Repository</span>
							{repos.length > 0 ? (
								<select value={repo} onChange={(event) => setRepo(event.target.value)}>
									{repos.map((key) => (
										<option key={key} value={key}>
											{repoName(key)}
										</option>
									))}
								</select>
							) : (
								<input
									value={typedRepo}
									placeholder="owner/repo"
									aria-invalid={typedRepo !== "" && !target}
									onChange={(event) => setTypedRepo(event.target.value)}
								/>
							)}
						</label>

						{kind === "pr" ? (
							<p className="writeback-path" data-loading={files.state === "loading" || undefined}>
								<RecordIcon size={13} />
								<span className="mono">
									{DECISIONS_DIR}/<b key={number}>{padNumber(number)}</b>
									{path.slice(DECISIONS_DIR.length + 5)}
								</span>
							</p>
						) : (
							<label className="writeback-field">
								<span>Category</span>
								<select
									value={category}
									disabled={categories.length === 0}
									onChange={(event) => setCategory(event.target.value)}
								>
									{categories.map((name) => (
										<option key={name} value={name}>
											{name}
										</option>
									))}
								</select>
							</label>
						)}

						{files.state === "error" && kind === "pr" && (
							<p className="writeback-note" data-tone="warn">
								Couldn’t read {DECISIONS_DIR} ({files.error}), so the number only counts this
								board’s records. Check it before merging.
							</p>
						)}
						{meta.state === "error" && kind === "discussion" && (
							<p className="writeback-note" data-tone="warn">
								Couldn’t load this repository’s categories ({meta.error}).
							</p>
						)}
						{!writable && (
							<p className="writeback-note" data-tone="warn">
								Tack isn’t installed with write access here yet: it can be staged, but not pushed
								until it is.
							</p>
						)}

						<label className="writeback-field">
							<span>Context</span>
							<textarea
								rows={3}
								value={context}
								placeholder="What prompted this, and what was considered?"
								onChange={(event) => setContext(event.target.value)}
							/>
						</label>
						<label className="writeback-field">
							<span>Decision</span>
							<textarea
								rows={2}
								value={decisionText}
								placeholder="What was decided?"
								onChange={(event) => setDecisionText(event.target.value)}
							/>
						</label>
						<label className="writeback-field">
							<span>Consequences</span>
							<textarea
								rows={2}
								value={consequences}
								placeholder="What becomes easier or harder because of it?"
								onChange={(event) => setConsequences(event.target.value)}
							/>
						</label>
					</div>

					<section className="writeback-preview" aria-label="Preview">
						<p className="writeback-preview-label">
							{kind === "pr" ? path : `Decision: ${decision?.title ?? ""}`}
						</p>
						<div className="writeback-paper">
							<Markdown source={markdown} />
						</div>
					</section>
				</div>

				<footer className="writeback-foot">
					<p className="writeback-hint">
						Staged with the board’s other changes. Nothing is written until someone pushes.
					</p>
					<button type="button" className="writeback-cancel" onClick={close}>
						Cancel
					</button>
					<button type="submit" className="primary writeback-stage" disabled={!ready}>
						{retrying ? "Stage again" : "Stage write-back"}
					</button>
				</footer>
			</form>
		</dialog>,
		document.body,
	);
}

function KindOption({
	checked,
	disabled = false,
	onSelect,
	icon,
	title,
	detail,
}: {
	checked: boolean;
	disabled?: boolean;
	onSelect: () => void;
	icon: ReactNode;
	title: string;
	detail: string;
}) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={checked}
			disabled={disabled}
			className="writeback-kind"
			onClick={onSelect}
		>
			<span className="writeback-kind-icon">{icon}</span>
			<span className="writeback-kind-title">{title}</span>
			<span className="writeback-kind-detail">{detail}</span>
		</button>
	);
}

/** Links in a line of Markdown, as text with the link text underlined. */
function inline(text: string): ReactNode[] {
	const out: ReactNode[] = [];
	const pattern = /\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|_([^_]+)_|`([^`]+)`/g;
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		const at = match.index ?? 0;
		if (at > last) out.push(text.slice(last, at));
		if (match[1] !== undefined) {
			out.push(
				<span key={at} className="writeback-md-link" title={match[2]}>
					{match[1].replace(/\\(.)/g, "$1")}
				</span>,
			);
		} else if (match[3] !== undefined) out.push(<strong key={at}>{match[3]}</strong>);
		else if (match[4] !== undefined) out.push(<em key={at}>{match[4]}</em>);
		else if (match[5] !== undefined) out.push(<code key={at}>{match[5]}</code>);
		last = at + match[0].length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

/**
 * Just enough Markdown for the record's preview: headings, lists and
 * paragraphs, rendered as text (never as HTML), so what people type shows
 * as it'll read on the forge.
 */
function Markdown({ source }: { source: string }) {
	const blocks = source.trim().split(/\n{2,}/);
	return (
		<div className="writeback-md">
			{blocks.map((block, i) => {
				const key = `${i}:${block.slice(0, 12)}`;
				if (block.startsWith("# ")) return <h1 key={key}>{inline(block.slice(2))}</h1>;
				if (block.startsWith("## ")) return <h2 key={key}>{inline(block.slice(3))}</h2>;
				if (block.split("\n").every((line) => line.startsWith("- "))) {
					return (
						<ul key={key}>
							{block.split("\n").map((line, j) => (
								<li key={`${j}:${line}`}>{inline(line.slice(2))}</li>
							))}
						</ul>
					);
				}
				return (
					<p key={key}>
						{block
							.split("\n")
							.flatMap((line, j) =>
								j === 0 ? inline(line) : [<br key={`b${j}`} />, ...inline(line)],
							)}
					</p>
				);
			})}
		</div>
	);
}
