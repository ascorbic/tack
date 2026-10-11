import { useEffect, useId, useRef, useState } from "react";
import type { InstallationList, InstallationSummary } from "../../shared/auth.ts";
import type { Loaded } from "./setupChecks.ts";

type Load =
	| { status: "loading" }
	| { status: "ready"; installations: InstallationSummary[]; notInstalled: string[] }
	| { status: "failed" };

/** Show a filter once there are this many repositories to look through. */
const FILTER_FROM = 10;

export async function fetchInstallations(): Promise<InstallationList> {
	const response = await fetch("/api/setup/installations", {
		headers: { accept: "application/json" },
	});
	if (!response.ok) throw new Error(`${response.status}`);
	return (await response.json()) as InstallationList;
}

/** How an installation is doing, in a few words, and how it should look. */
export function installationState(installation: InstallationSummary): {
	tone: "ok" | "warn" | "off";
	label: string;
	detail: string | null;
} {
	if (installation.suspended) {
		return {
			tone: "off",
			label: "Suspended",
			detail: "Nothing updates live, and Tack can’t push. Unsuspend it in the account’s settings.",
		};
	}
	if (!installation.writable) {
		return {
			tone: "warn",
			label: "Live, read-only",
			detail:
				"Tack can’t push here until the account accepts the permissions it asks for (review them in its settings).",
		};
	}
	return { tone: "ok", label: "Live · Tack can push", detail: null };
}

/**
 * Where the app is installed, for admins on `/setup`: each account, the
 * repositories it covers, and whether Tack can push there. Check every
 * repository you'll plan with is here before a session, rather than
 * finding out when a push fails.
 */
export function Installations({
	installUrl,
	load = fetchInstallations,
	onChange,
}: {
	installUrl: string;
	load?: () => Promise<InstallationList>;
	/** Told what's loaded, for the setup checklist. */
	onChange?: (state: Loaded<InstallationList>) => void;
}) {
	const [state, setState] = useState<Load>({ status: "loading" });
	const [round, setRound] = useState(0);
	const [filter, setFilter] = useState("");
	const changed = useRef(onChange);
	changed.current = onChange;

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		changed.current?.({ status: "loading" });
		load()
			.then((list) => {
				if (cancelled) return;
				setState({
					status: "ready",
					installations: list.installations,
					notInstalled: list.notInstalled ?? [],
				});
				changed.current?.({ status: "ready", value: list });
			})
			.catch(() => {
				if (cancelled) return;
				setState({ status: "failed" });
				changed.current?.({ status: "failed" });
			});
		return () => {
			cancelled = true;
		};
	}, [load, round]);

	const repositories =
		state.status === "ready"
			? state.installations.reduce((n, i) => n + i.repositories.length, 0)
			: 0;
	const query = filter.trim().toLowerCase();

	return (
		<section
			id="setup-repositories"
			className="installs"
			aria-labelledby="installs-title"
			aria-busy={state.status === "loading"}
		>
			<div className="installs-head">
				<h2 id="installs-title">Where it’s installed</h2>
				{state.status !== "loading" && (
					<button type="button" className="installs-refresh" onClick={() => setRound((n) => n + 1)}>
						Check again
					</button>
				)}
			</div>
			<p className="auth-note">
				Cards from these repositories update live, and Tack can push staged changes to them. Before
				a session, check every repository you’ll plan with is here.
			</p>
			{state.status === "loading" && (
				<ul className="installs-list">
					<li className="install install-skeleton" />
				</ul>
			)}
			{state.status === "failed" && (
				<p className="auth-alert" role="alert">
					Couldn’t ask GitHub where the app is installed.{" "}
					<button type="button" className="installs-retry" onClick={() => setRound((n) => n + 1)}>
						Try again
					</button>
				</p>
			)}
			{state.status === "ready" && state.installations.length === 0 && (
				<p className="installs-none">
					It isn’t installed anywhere yet. <a href={installUrl}>Install it</a> on the repositories
					you plan with.
				</p>
			)}
			{state.status === "ready" && state.installations.length > 0 && (
				<>
					{repositories >= FILTER_FROM && (
						<input
							className="setup-input installs-filter"
							type="search"
							placeholder="Find a repository"
							aria-label="Find a repository"
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
						/>
					)}
					<ul className="installs-list">
						{state.installations.map((installation, i) => (
							<InstallationRow
								key={installation.id}
								installation={installation}
								query={query}
								index={i}
							/>
						))}
					</ul>
					{query &&
						!state.installations.some((i) =>
							i.repositories.some((repo) => repo.name.toLowerCase().includes(query)),
						) && (
							<p className="installs-none" role="status">
								No installation covers “{filter.trim()}” yet.{" "}
								<a href={installUrl}>Install it there</a>.
							</p>
						)}
				</>
			)}
			{state.status === "ready" && state.notInstalled.length > 0 && (
				<NotInstalled
					repos={state.notInstalled.filter((repo) => !query || repo.includes(query))}
					installUrl={installUrl}
				/>
			)}
		</section>
	);
}

/**
 * Repositories Tack has looked for the app on (cards on boards, mostly) and
 * not found it: the ones to install it on before a session.
 */
function NotInstalled({ repos, installUrl }: { repos: string[]; installUrl: string }) {
	const title = useId();
	if (repos.length === 0) return null;
	return (
		<section className="installs-missing" aria-labelledby={title}>
			<div className="installs-head">
				<h3 id={title}>On boards, without the app</h3>
				<a className="install-settings" href={installUrl}>
					Install on these
				</a>
			</div>
			<p className="install-detail">
				Cards from these show, if they’re public, but don’t update live, and Tack can’t push to
				them. Install the app on any you’ll plan with.
			</p>
			<ul className="install-repos" aria-label="Repositories without the app">
				{repos.map((repo) => (
					<li key={repo}>{repo}</li>
				))}
			</ul>
		</section>
	);
}

function InstallationRow({
	installation,
	query,
	index,
}: {
	installation: InstallationSummary;
	query: string;
	index: number;
}) {
	const { tone, label, detail } = installationState(installation);
	const repos = query
		? installation.repositories.filter((repo) => repo.name.toLowerCase().includes(query))
		: installation.repositories;
	if (query && repos.length === 0) return null;
	const count = installation.repositories.length + installation.more;
	return (
		<li className="install" data-tone={tone} style={{ "--i": index } as React.CSSProperties}>
			<div className="install-head">
				<span className="install-account" aria-hidden="true">
					{installation.account.slice(0, 1).toUpperCase()}
				</span>
				<span className="install-who">
					<strong>{installation.account}</strong>
					<span>
						{installation.selection === "all"
							? "All repositories"
							: `${count} ${count === 1 ? "repository" : "repositories"}`}
					</span>
				</span>
				<span className="install-status" data-tone={tone}>
					<StatusGlyph tone={tone} />
					{label}
				</span>
				{installation.settingsUrl && (
					<a className="install-settings" href={installation.settingsUrl}>
						Configure
					</a>
				)}
			</div>
			{detail && <p className="install-detail">{detail}</p>}
			{repos.length > 0 && (
				<ul
					className="install-repos"
					aria-label={`Repositories ${installation.account} installed it on`}
				>
					{repos.map((repo) => (
						<li key={repo.name}>
							{repo.private && (
								<svg
									className="icon"
									width="12"
									height="12"
									viewBox="0 0 16 16"
									role="img"
									aria-label="Private"
								>
									<rect x="3.25" y="7" width="9.5" height="6.5" rx="1.6" />
									<path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7" />
								</svg>
							)}
							{repo.name}
						</li>
					))}
					{!query && installation.more > 0 && (
						<li className="install-more">+{installation.more} more</li>
					)}
				</ul>
			)}
		</li>
	);
}

function StatusGlyph({ tone }: { tone: "ok" | "warn" | "off" }) {
	return (
		<svg className="icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
			{tone === "ok" ? (
				<path d="M3.5 8.5l3 3 6-7" />
			) : tone === "warn" ? (
				<>
					<path d="M8 2.5l6 11H2z" />
					<path d="M8 7v3M8 12v.1" />
				</>
			) : (
				<>
					<circle cx="8" cy="8" r="5.75" />
					<path d="M6 6v4M10 6v4" />
				</>
			)}
		</svg>
	);
}
