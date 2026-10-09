import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { inboxQuery } from "../../shared/inbox.ts";
import { repoKeyOf } from "../../shared/refs.ts";
import {
	type Rule,
	type RuleAction,
	type RuleAuthor,
	type RuleLogEntry,
	type RuleTrigger,
	addRule,
	deleteRule,
	describeRule,
	listRules,
	readRuleLog,
	ruleLog,
	ruleProblem,
	rulesMap,
	setRuleEnabled,
	shortRef,
} from "../../shared/rules.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { relativeTime } from "../boards/api.ts";
import {
	BesideIcon,
	BoltIcon,
	CloseIcon,
	IntoSectionIcon,
	PlusIcon,
	TrashIcon,
} from "../inbox/icons.tsx";
import { useBoardRefs } from "../inbox/useTray.ts";
import type { ToastStore } from "../Toasts.tsx";
import "./rules.css";

// The rules panel (#44): a board's rules in words, each with a switch to
// pause it, what it has done ("Placed #431 beside #412, 2 min ago"), and a
// composer for new ones. Rules run on the server, on webhooks; this only
// edits the `rules` map (undoable, like any edit) and reads the log.

interface RulesState {
	rules: Rule[];
	log: RuleLogEntry[];
}

const stores = new WeakMap<Y.Doc, { get(): RulesState; subscribe(l: () => void): () => void }>();

function rulesStore(doc: Y.Doc) {
	let store = stores.get(doc);
	if (store) return store;
	let state: RulesState = { rules: listRules(doc), log: readRuleLog(doc) };
	const listeners = new Set<() => void>();
	const update = () => {
		state = { rules: listRules(doc), log: readRuleLog(doc) };
		for (const listener of listeners) listener();
	};
	rulesMap(doc).observeDeep(update);
	ruleLog(doc).observe(update);
	store = {
		get: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	stores.set(doc, store);
	return store;
}

export function useRules(doc: Y.Doc): RulesState {
	const store = useMemo(() => rulesStore(doc), [doc]);
	return useSyncExternalStore(
		(listener) => store.subscribe(listener),
		() => store.get(),
	);
}

/** Re-render every so often, for relative times. */
function useNow(ms = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(timer);
	}, [ms]);
	return now;
}

function sectionTitle(doc: Y.Doc) {
	return (id: string): string | null => {
		const shape = shapesMap(doc).get(id);
		if (!shape || shape.get("type") !== "section") return null;
		return (shape.get("title") as string | undefined) ?? "";
	};
}

/** An activity entry in words: "Placed #431 beside #412". */
export function describeEntry(entry: RuleLogEntry, title: (id: string) => string | null): string {
	const item = shortRef(entry.key, repoKeyOf(entry.near ?? entry.key));
	const section = entry.section ? title(entry.section) : null;
	const named = section ? `“${section}”` : section === "" ? "an untitled section" : "a section";
	if (entry.outcome === "skipped") {
		if (entry.reason === "no_section") return `Couldn’t add ${item}: its section was deleted`;
		return `Couldn’t find room for ${item}`;
	}
	if (entry.near) return `Placed ${item} beside ${shortRef(entry.near, repoKeyOf(entry.key))}`;
	if (entry.reason === "full") return `Added ${item} below ${named} (it was full)`;
	return `Added ${item} to ${named}`;
}

/** The top bar's button: how many rules are on, and a zap when one fires. */
export function RulesButton({
	doc,
	open,
	onToggle,
	toasts,
	onReveal,
}: {
	doc: Y.Doc;
	open: boolean;
	onToggle: () => void;
	toasts: ToastStore;
	onReveal: (shape: string) => void;
}) {
	const { rules, log } = useRules(doc);
	const active = rules.filter((rule) => rule.enabled).length;
	// A zap for every new log entry, and a toast for cards placed while you watch.
	const seen = useRef(log.length > 0 ? log.at(-1)?.id : null);
	const [zaps, setZaps] = useState(0);
	const openRef = useRef(open);
	openRef.current = open;
	useEffect(() => {
		const last = log.at(-1);
		if (!last || last.id === seen.current) return;
		const start = log.findIndex((entry) => entry.id === seen.current);
		const fresh = log.slice(start + 1);
		seen.current = last.id;
		setZaps((n) => n + 1);
		const placed = fresh.filter((entry) => entry.outcome === "placed" && entry.shape);
		const latest = placed.at(-1);
		if (latest?.shape && !openRef.current) {
			const shape = latest.shape;
			toasts.show({
				message:
					placed.length > 1
						? `Rules placed ${placed.length} cards`
						: `A rule: ${describeEntry(latest, sectionTitle(doc))}`,
				action: { label: "Show", run: () => onReveal(shape) },
			});
		}
	}, [log, doc, toasts, onReveal]);

	return (
		<button
			type="button"
			className="rules-button"
			aria-pressed={open}
			aria-label={`Rules: ${active} on`}
			title="Rules: automation that places cards"
			onClick={onToggle}
			data-active={active > 0}
		>
			<span key={zaps} className="rules-button-icon" data-zap={zaps > 0}>
				<BoltIcon size={15} />
			</span>
			<span>Rules</span>
			{rules.length > 0 && <span className="rules-button-count">{active}</span>}
		</button>
	);
}

export function RulesPanel({
	doc,
	user,
	readOnly,
	onClose,
	onReveal,
	onUndo,
	toasts,
	initiallyComposing = false,
}: {
	doc: Y.Doc;
	user: RuleAuthor;
	readOnly: boolean;
	onClose: () => void;
	onReveal: (shape: string) => void;
	/** Undo this person's last edit (deleting a rule is one). */
	onUndo: () => void;
	toasts: ToastStore;
	/** Open with the composer showing (the gallery). */
	initiallyComposing?: boolean;
}) {
	const { rules, log } = useRules(doc);
	const [composing, setComposing] = useState(initiallyComposing);
	const now = useNow();
	const title = sectionTitle(doc);
	const recent = [...log].reverse().slice(0, 30);
	const ruleIds = new Set(rules.map((rule) => rule.id));

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (
				event.key === "Escape" &&
				!(event.target as Element | null)?.closest("input, textarea, select")
			) {
				onClose();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<aside className="rules-panel" aria-label="Rules" role="dialog">
			<header className="rules-head">
				<span className="rules-head-icon">
					<BoltIcon size={16} />
				</span>
				<div>
					<h2>Rules</h2>
					<p>Automation that places cards. It never moves what people placed.</p>
				</div>
				<button type="button" className="rules-close" aria-label="Close rules" onClick={onClose}>
					<CloseIcon />
				</button>
			</header>

			<div className="rules-body">
				{rules.length === 0 && !composing && (
					<div className="rules-empty">
						<p>No rules yet. Start with one of these:</p>
						{!readOnly && (
							<Suggestions
								doc={doc}
								user={user}
								onAdded={(rule) =>
									toasts.show({
										message: `Rule added: ${describeRule(rule, title).when.toLowerCase()}`,
									})
								}
								onCustom={() => setComposing(true)}
							/>
						)}
					</div>
				)}

				{rules.length > 0 && (
					<ul className="rules-list">
						{rules.map((rule) => (
							<RuleRow
								key={rule.id}
								rule={rule}
								now={now}
								title={title}
								readOnly={readOnly}
								onToggle={(enabled) => setRuleEnabled(doc, rule.id, enabled)}
								onDelete={() => {
									deleteRule(doc, rule.id);
									toasts.show({ message: "Rule deleted", action: { label: "Undo", run: onUndo } });
								}}
							/>
						))}
					</ul>
				)}

				{!readOnly &&
					(composing ? (
						<Composer doc={doc} user={user} onDone={() => setComposing(false)} title={title} />
					) : (
						rules.length > 0 && (
							<button type="button" className="rules-new" onClick={() => setComposing(true)}>
								<PlusIcon />
								New rule
							</button>
						)
					))}

				<section className="rules-activity" aria-label="Recent activity">
					<h3>Recent activity</h3>
					{recent.length === 0 ? (
						<p className="rules-quiet">
							Nothing yet. Rules run when GitHub tells the board something changed.
						</p>
					) : (
						<ol>
							{recent.map((entry) => (
								<li key={entry.id} data-outcome={entry.outcome}>
									<button
										type="button"
										className="rules-entry"
										disabled={!entry.shape}
										onClick={() => entry.shape && onReveal(entry.shape)}
									>
										<span className="rules-entry-dot" aria-hidden="true" />
										<span className="rules-entry-text">{describeEntry(entry, title)}</span>
										<time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>
											{relativeTime(Date.parse(entry.at), now)}
										</time>
									</button>
									{!ruleIds.has(entry.rule) && (
										<span className="rules-entry-rule">by a deleted rule</span>
									)}
								</li>
							))}
						</ol>
					)}
				</section>
			</div>

			<footer className="rules-foot">
				Rules run with the app’s access, and only place items from repositories already on this
				board.
			</footer>
		</aside>
	);
}

function RuleRow({
	rule,
	now,
	title,
	readOnly,
	onToggle,
	onDelete,
}: {
	rule: Rule;
	now: number;
	title: (id: string) => string | null;
	readOnly: boolean;
	onToggle: (enabled: boolean) => void;
	onDelete: () => void;
}) {
	const described = describeRule(rule, title);
	const does = described.does;
	// The query is shown on its own below.
	const when =
		rule.trigger.kind === "matches" ? "When an item matching this search appears" : described.when;
	const fired = rule.fired ?? 0;
	const stats = !rule.enabled
		? "Paused"
		: fired === 0
			? "Hasn’t placed anything yet"
			: `Placed ${fired} ${fired === 1 ? "card" : "cards"}${rule.lastAt ? `, last ${relativeTime(Date.parse(rule.lastAt), now)}` : ""}`;
	return (
		<li className="rule" data-enabled={rule.enabled}>
			<span className="rule-icon" aria-hidden="true">
				{rule.trigger.kind === "pull-links" ? <BesideIcon /> : <IntoSectionIcon />}
			</span>
			<div className="rule-text">
				<p>
					<span className="rule-when">{when}</span>, <span className="rule-does">{does}</span>.
				</p>
				{rule.trigger.kind === "matches" && (
					<code className="rule-query mono">{rule.trigger.query.q}</code>
				)}
				<span className="rule-stats" key={fired} data-bumped={fired > 0}>
					{stats}
				</span>
			</div>
			<span className="rule-controls">
				<label className="switch" title={rule.enabled ? "Pause" : "Resume"}>
					<input
						type="checkbox"
						role="switch"
						checked={rule.enabled}
						disabled={readOnly}
						aria-label={rule.enabled ? "Pause this rule" : "Resume this rule"}
						onChange={(event) => onToggle(event.target.checked)}
					/>
					<span aria-hidden="true" />
				</label>
				{!readOnly && (
					<button
						type="button"
						className="rules-icon-button"
						aria-label="Delete this rule"
						title="Delete"
						onClick={onDelete}
					>
						<TrashIcon />
					</button>
				)}
			</span>
		</li>
	);
}

function Suggestions({
	doc,
	user,
	onAdded,
	onCustom,
}: {
	doc: Y.Doc;
	user: RuleAuthor;
	onAdded: (rule: Pick<Rule, "trigger" | "action">) => void;
	onCustom: () => void;
}) {
	const trigger: RuleTrigger = { kind: "pull-links" };
	const action: RuleAction = { kind: "beside-linked" };
	return (
		<div className="rules-suggestions">
			<button
				type="button"
				className="rules-template"
				onClick={() => {
					addRule(doc, trigger, action, user);
					onAdded({ trigger, action });
				}}
			>
				<span className="rule-icon">
					<BesideIcon />
				</span>
				<span>
					<strong>Pull requests beside their issues</strong>
					<span>When a pull request mentions a card here, place it beside the card.</span>
				</span>
			</button>
			<button type="button" className="rules-template" onClick={onCustom}>
				<span className="rule-icon">
					<IntoSectionIcon />
				</span>
				<span>
					<strong>New matches into a section</strong>
					<span>When an issue matching a search appears, add it to a section.</span>
				</span>
			</button>
		</div>
	);
}

function Composer({
	doc,
	user,
	onDone,
	title,
}: {
	doc: Y.Doc;
	user: RuleAuthor;
	onDone: () => void;
	title: (id: string) => string | null;
}) {
	const refs = useBoardRefs(doc);
	const firstRepo = useMemo(() => {
		const [key] = refs;
		return key ? repoKeyOf(key) : null;
	}, [refs]);
	const sections = useMemo(
		() =>
			[...shapesMap(doc)]
				.filter(([, shape]) => shape.get("type") === "section")
				.map(([id]) => ({ id, title: title(id) || "Untitled section" })),
		// Sections come and go rarely while the composer is open.
		[doc, title],
	);
	const [kind, setKind] = useState<"pull-links" | "matches">("matches");
	const [closesOnly, setClosesOnly] = useState(false);
	const repoPath = firstRepo ? firstRepo.slice(firstRepo.indexOf("/") + 1) : "owner/name";
	const [q, setQ] = useState(`repo:${repoPath} is:issue is:open label:bug`);
	const [section, setSection] = useState(sections[0]?.id ?? "");
	const host = firstRepo ? firstRepo.slice(0, firstRepo.indexOf("/")) : "github.com";

	const trigger: RuleTrigger =
		kind === "pull-links"
			? { kind: "pull-links", ...(closesOnly ? { closesOnly } : {}) }
			: { kind: "matches", query: inboxQuery(q, host) };
	const action: RuleAction =
		kind === "pull-links" ? { kind: "beside-linked" } : { kind: "section", section };
	const problem = ruleProblem(doc, trigger, action);

	return (
		<form
			className="rules-composer"
			onSubmit={(event) => {
				event.preventDefault();
				if (problem) return;
				addRule(doc, trigger, action, user);
				onDone();
			}}
			onKeyDown={(event) => event.stopPropagation()}
		>
			<div className="segmented rules-kind" role="radiogroup" aria-label="When">
				<label data-checked={kind === "matches"}>
					<input
						type="radio"
						name="rule-kind"
						checked={kind === "matches"}
						onChange={() => setKind("matches")}
					/>
					Matching items
				</label>
				<label data-checked={kind === "pull-links"}>
					<input
						type="radio"
						name="rule-kind"
						checked={kind === "pull-links"}
						onChange={() => setKind("pull-links")}
					/>
					Linked pull requests
				</label>
			</div>
			{kind === "matches" ? (
				<>
					<label className="rules-field">
						<span>When an item matching</span>
						<textarea
							className="mono"
							rows={2}
							spellCheck={false}
							value={q}
							onChange={(event) => setQ(event.target.value)}
						/>
					</label>
					<label className="rules-field">
						<span>appears, add it to</span>
						<select value={section} onChange={(event) => setSection(event.target.value)}>
							{sections.length === 0 && <option value="">No sections on the board</option>}
							{sections.map((s) => (
								<option key={s.id} value={s.id}>
									{s.title}
								</option>
							))}
						</select>
					</label>
				</>
			) : (
				<label className="rules-check">
					<input
						type="checkbox"
						checked={closesOnly}
						onChange={(event) => setClosesOnly(event.target.checked)}
					/>
					Only pull requests that close the card (“Fixes #12”)
				</label>
			)}
			<p className="rules-sentence" data-problem={Boolean(problem)} aria-live="polite">
				{problem ??
					(() => {
						const { when, does } = describeRule({ trigger, action }, title);
						// The query is right above.
						const short =
							trigger.kind === "matches" ? "When an item matching this search appears" : when;
						return `${short}, ${does}.`;
					})()}
			</p>
			<footer>
				<button type="button" className="inbox-button" onClick={onDone}>
					Cancel
				</button>
				<button type="submit" className="inbox-button primary" disabled={Boolean(problem)}>
					Add rule
				</button>
			</footer>
		</form>
	);
}
