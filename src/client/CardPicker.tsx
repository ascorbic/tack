import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Card } from "../shared/cards.ts";
import { parseKey } from "../shared/refs.ts";
import type { QueryError, SearchResult } from "../shared/widgets.ts";
import { StateIcon } from "./CardView.tsx";
import { type AddOutcome, type CardInput, type CardScope, readCardInput } from "./cardInput.ts";
import { cardStore } from "./cardStore.ts";
import { isApplePlatform } from "./shortcuts.ts";

// The card tool (C): paste a link or a reference to add an issue or pull
// request, or type a few words to search the board's repositories for one.
// It stays open after adding, so a run of cards goes in quickly, each placed
// in free space beside the last (see shared/addCards.ts).

const apple = isApplePlatform();
const DEBOUNCE_MS = 250;

export type { AddOutcome, CardScope };

type Results =
	| { status: "idle" }
	| { status: "loading"; q: string; items: Card[] }
	| { status: "done"; q: string; items: Card[]; total: number }
	| { status: "error"; q: string; message: string };

export function CardPicker({
	scope,
	search,
	onBoard,
	onAdd,
	onDone,
}: {
	scope: CardScope;
	/** Searching the forge; without it, only references can be added. */
	search?: (host: string, q: string) => Promise<SearchResult | QueryError>;
	/** Whether an item already has a card on the board. */
	onBoard: (key: string) => boolean;
	/** Add cards, or with `copies`, another card for items already on the board. */
	onAdd: (keys: string[], copies?: boolean) => AddOutcome;
	onDone: () => void;
}) {
	const [value, setValue] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	// Items already on the board that were asked for: shown there, with a copy on offer.
	const [already, setAlready] = useState<{ keys: string[]; text: string } | null>(null);
	const [active, setActive] = useState(0);
	const [results, setResults] = useState<Results>({ status: "idle" });
	// Added while the tool's been open, to tick them off in the list.
	const [added, setAdded] = useState<Set<string>>(() => new Set());
	const input = useRef<HTMLInputElement>(null);
	const listId = useId();
	useEffect(() => input.current?.focus(), []);

	const read = useMemo(() => readCardInput(value, scope), [value, scope]);
	const canSearch = read.kind === "search" && search !== undefined;
	const q = read.kind === "search" ? read.q : null;
	const host = read.kind === "search" ? read.host : scope.host;

	// Search as you type, a moment after you stop.
	useEffect(() => {
		if (!canSearch || q === null || !search) {
			setResults({ status: "idle" });
			return;
		}
		let live = true;
		setResults((current) => ({
			status: "loading",
			q,
			items: current.status === "done" || current.status === "loading" ? current.items : [],
		}));
		const timer = setTimeout(() => {
			void search(host, q).then((result) => {
				if (!live) return;
				if (result.kind === "error") {
					setResults({ status: "error", q, message: result.message });
					return;
				}
				// Known cards show straight away when added.
				for (const card of result.items) if (!cardStore.get(card.key)) cardStore.set(card);
				setResults({ status: "done", q, items: result.items, total: result.total });
				setActive(0);
			});
		}, DEBOUNCE_MS);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [canSearch, q, host, search]);

	const items: Card[] =
		results.status === "done" || results.status === "loading" ? results.items : [];
	const refCard = read.kind === "ref" ? cardStore.get(read.key) : undefined;
	const options: { key: string; card?: Card }[] =
		read.kind === "ref"
			? [{ key: read.key, card: refCard && !("missing" in refCard) ? refCard : undefined }]
			: items.map((card) => ({ key: card.key, card }));
	const fresh = options.filter((option) => !onBoard(option.key));

	const add = (keys: string[], copies = false) => {
		if (keys.length === 0) return;
		const outcome = onAdd(keys, copies);
		setAdded((current) => new Set([...current, ...outcome.added]));
		setAlready(
			outcome.existing.length > 0 && outcome.notice
				? { keys: outcome.existing, text: outcome.notice }
				: null,
		);
		input.current?.focus();
		// A reference is done with; a search stays, to pick more from.
		if (read.kind === "ref") setValue("");
	};

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (read.kind === "invalid") {
			setProblem(read.message);
			return;
		}
		if (read.kind === "search" && !search) {
			setProblem("Paste a link to an issue or pull request, or owner/repo#123.");
			return;
		}
		const option = options[Math.min(active, options.length - 1)];
		if (option) add([option.key]);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onDone();
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (options.length === 0) return;
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((current) => (current + step + options.length) % options.length);
		} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			// Everything found that isn't on the board yet.
			event.preventDefault();
			add(fresh.map((option) => option.key));
		}
	};

	const status = message(read, results, problem, canSearch, fresh.length);
	const activeId = options.length > 0 ? `${listId}-${Math.min(active, options.length - 1)}` : "";
	return (
		<div className="toolbar-options card-picker" data-chrome>
			{options.length > 0 && (
				<ul
					className="card-results"
					id={listId}
					role="listbox"
					aria-label="Issues and pull requests"
					data-loading={results.status === "loading" || undefined}
				>
					{options.map((option, i) => {
						const there = onBoard(option.key);
						const ref = parseKey(option.key);
						const repo = option.card?.repo ?? ref?.repo ?? "";
						return (
							<li
								key={option.key}
								id={`${listId}-${i}`}
								role="option"
								aria-selected={i === Math.min(active, options.length - 1)}
								className="card-result"
								data-state={option.card?.state}
								onPointerMove={() => setActive(i)}
								onPointerDown={(event) => event.preventDefault()}
								onClick={() => add([option.key])}
							>
								<span className="state-icon" aria-hidden="true">
									{option.card ? (
										<StateIcon card={option.card} />
									) : (
										<span className="card-result-dot" />
									)}
								</span>
								<span className="card-result-number">{option.card?.item ?? ref?.item}</span>
								<span className="card-result-title">
									{option.card?.title ?? `Add ${repo}${ref?.item ?? ""}`}
								</span>
								{option.card && scope.repos.length !== 1 && (
									<span className="card-result-repo">{repo.split("/").pop()}</span>
								)}
								{there && (
									<span
										className="card-result-badge"
										data-added={added.has(option.key) || undefined}
									>
										{added.has(option.key) ? "Added" : "On the board"}
									</span>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{already ? (
				<p className="card-status" role="status">
					{already.text}
					<button
						type="button"
						className="card-status-action"
						onPointerDown={(event) => event.preventDefault()}
						onClick={() => add(already.keys, true)}
					>
						{already.keys.length === 1 ? "Add another copy" : "Add copies"}
					</button>
				</p>
			) : (
				status && (
					<p className="card-status" data-tone={status.tone} role="status">
						{status.text}
					</p>
				)
			)}
			<form className="card-options" onSubmit={submit}>
				<label htmlFor={`${listId}-input`} className="visually-hidden">
					Issue or pull request
				</label>
				<input
					id={`${listId}-input`}
					ref={input}
					value={value}
					role="combobox"
					aria-expanded={options.length > 0}
					aria-controls={listId}
					aria-activedescendant={activeId || undefined}
					aria-autocomplete="list"
					aria-invalid={problem !== null}
					autoComplete="off"
					spellCheck={false}
					placeholder={placeholder(scope, search !== undefined)}
					onChange={(event) => {
						setValue(event.target.value);
						setProblem(null);
						setAlready(null);
						setActive(0);
					}}
					onKeyDown={onKeyDown}
				/>
				<button type="submit" className="primary">
					Add
				</button>
			</form>
		</div>
	);
}

function placeholder(scope: CardScope, searching: boolean): string {
	const [main] = scope.repos;
	if (!searching) return "owner/repo#123 or paste a link";
	if (main) return `Search ${main.split("/").pop()}, or paste a link`;
	return "Paste a link, or owner/repo and words to search";
}

function message(
	read: CardInput,
	results: Results,
	problem: string | null,
	canSearch: boolean,
	fresh: number,
): { text: string; tone?: "error" | "quiet" } | null {
	if (problem) return { text: problem, tone: "error" };
	if (read.kind === "ref") return { text: "↵ to add it", tone: "quiet" };
	// Said quietly as you type; Enter says it louder (`problem`).
	if (read.kind === "invalid") return { text: read.message, tone: "quiet" };
	if (read.kind !== "search" || !canSearch) return null;
	switch (results.status) {
		case "idle":
			return null;
		case "loading":
			return results.items.length > 0 ? null : { text: `Searching ${read.where}…`, tone: "quiet" };
		case "error":
			return { text: results.message, tone: "error" };
		case "done":
			if (results.items.length === 0) return { text: `Nothing in ${read.where} matches.` };
			return {
				text:
					fresh > 1
						? `↑↓ to choose, ↵ to add, ${apple ? "⌘" : "Ctrl+"}↵ to add all ${fresh}`
						: "↑↓ to choose, ↵ to add",
				tone: "quiet",
			};
	}
}
