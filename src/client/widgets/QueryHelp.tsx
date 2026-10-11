import { useContext, useEffect, useId, useMemo, useState } from "react";
import { boardRepos } from "../../shared/actions.ts";
import { rescueQuery } from "../../shared/queryHelp.ts";
import { mentionsMe, parseSearch, withLogin } from "../../shared/search.ts";
import { ServicesContext, loadRepoMeta } from "../actions/services.ts";
import { DocContext } from "../DocContext.ts";
import { queryChips } from "./describe.ts";
import "./queryHelp.css";

// Help with writing searches, wherever one is written: a list's, a stale
// finder's, a timeline's or a dependency map's panel, an inbox's editor and
// the rule composer. A search that reads as plain words, or that could match
// anything anywhere, gets a suggestion of what it probably meant ("Did you
// mean repo:acme/unpic label:bug?"), one click to take; and one about
// whoever's looking (`@me`) offers to name you instead, so everyone sees the
// same thing. Suggestions only: nothing changes unless it's taken.

/** The forges a widget could search: github.com, and any the board's cards are on. */
export function useForgeHosts(current: string): string[] {
	const doc = useContext(DocContext);
	return useMemo(() => {
		const hosts = doc ? boardRepos(doc).map((entry) => entry.repo.split("/")[0] ?? "") : [];
		return [...new Set(["github.com", current, ...hosts].filter(Boolean))];
	}, [doc, current]);
}

/** Which forge to search: only there when there's more than one to choose from. */
export function ForgeField({
	value,
	onChange,
}: {
	value: string;
	onChange: (host: string) => void;
}) {
	const id = useId();
	const hosts = useForgeHosts(value);
	if (hosts.length < 2) return null;
	return (
		<label className="widget-field" htmlFor={id}>
			<span className="widget-field-label">Forge</span>
			<select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
				{hosts.map((host) => (
					<option key={host} value={host}>
						{host}
					</option>
				))}
			</select>
		</label>
	);
}

/** The board's busiest repository on `host` (`owner/name`) and its labels, as far as they're known. */
export function useSearchContext(host: string): { repo: string | null; labels: string[] } {
	const doc = useContext(DocContext);
	const services = useContext(ServicesContext);
	const repo = useMemo(() => {
		if (!doc) return null;
		const busiest = boardRepos(doc).find((entry) => entry.repo.startsWith(`${host}/`));
		return busiest ? busiest.repo.slice(host.length + 1) : null;
	}, [doc, host]);
	const [labels, setLabels] = useState<string[]>([]);
	useEffect(() => {
		setLabels([]);
		if (!services || !repo) return;
		let live = true;
		void loadRepoMeta(services, `${host}/${repo}`).then((meta) => {
			if (live && meta) setLabels(meta.labels.map((label) => label.name));
		});
		return () => {
			live = false;
		};
	}, [services, host, repo]);
	return useMemo(() => ({ repo, labels }), [repo, labels]);
}

export function QueryHelp({
	q,
	host,
	login,
	onUse,
}: {
	q: string;
	host: string;
	/** Who's writing it, signed in: offered in place of `@me`. */
	login?: string | null;
	/** Take a suggestion: the search, rewritten. */
	onUse: (q: string) => void;
}) {
	const context = useSearchContext(host);
	const rescue = useMemo(() => rescueQuery(q, context), [q, context]);
	const personal = login && mentionsMe(q);
	if (!rescue && !personal) return null;
	return (
		<div className="query-help">
			{rescue && (
				<div className="query-hint" data-kind={rescue.scopeOnly ? "scope" : "rescue"}>
					<span className="query-hint-icon" aria-hidden="true">
						<SparkIcon />
					</span>
					<div className="query-hint-text">
						{rescue.scopeOnly ? (
							<p>
								This searches everywhere you can see. Only{" "}
								<span className="mono">{context.repo}</span>?
							</p>
						) : (
							<>
								<p>Did you mean</p>
								<div className="query-hint-chips" aria-label="Suggestion">
									{queryChips(parseSearch(rescue.q)).map((chip, i) => (
										<span
											key={`${i}:${chip.text}`}
											className="widget-chip mono"
											data-tone={chip.tone}
											data-negated={chip.negated || undefined}
										>
											{chip.text}
										</span>
									))}
								</div>
								<p className="query-hint-detail">Reads {sentence(rescue.changes)}.</p>
							</>
						)}
					</div>
					<button type="button" className="query-hint-use" onClick={() => onUse(rescue.q)}>
						{rescue.scopeOnly ? "Search only there" : "Use this"}
					</button>
				</div>
			)}
			{personal && (
				<div className="query-hint" data-kind="personal">
					<span className="query-hint-icon" aria-hidden="true">
						<PersonIcon />
					</span>
					<div className="query-hint-text">
						<p>
							<span className="mono">@me</span> is whoever's looking: everyone here sees their own.
						</p>
					</div>
					<button
						type="button"
						className="query-hint-use"
						onClick={() => onUse(withLogin(q, login))}
					>
						Use @{login}
					</button>
				</div>
			)}
		</div>
	);
}

/** "a, b and c" */
function sentence(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function SparkIcon() {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
			<path
				d="M8 1.8l1.4 3.6a2 2 0 0 0 1.2 1.2L14.2 8l-3.6 1.4a2 2 0 0 0-1.2 1.2L8 14.2l-1.4-3.6a2 2 0 0 0-1.2-1.2L1.8 8l3.6-1.4a2 2 0 0 0 1.2-1.2z"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function PersonIcon() {
	return (
		<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
			<circle cx="8" cy="5.5" r="2.8" stroke="currentColor" strokeWidth="1.4" />
			<path
				d="M2.8 14c.9-2.6 2.9-4 5.2-4s4.3 1.4 5.2 4"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
			/>
		</svg>
	);
}
