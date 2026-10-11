import { useContext, useEffect, useState } from "react";
import { forgeForHost, forgeNameOf } from "../../shared/refs.ts";
import { cardRefs, shapesMap } from "../../shared/shapes.ts";
import { cardStore } from "../cardStore.ts";
import { DocContext } from "../DocContext.ts";
import { type BoardRepo, boardRepos } from "./repoStatus.ts";

const COPY: Record<BoardRepo["state"], string> = {
	ready: "Live · Tack can push",
	readonly: "Updates while open · read-only",
	checked: "Updates while open · Tack can push",
	unreadable: "Tack can’t read it",
	loading: "Checking…",
};

/**
 * The board's repositories in the Share dialog, for people who can edit:
 * whether each is live and can be pushed to, so a missing installation
 * shows up before the session rather than when the first push fails.
 */
export function BoardRepoList({ returnTo }: { returnTo: string }) {
	const repos = useBoardRepos();
	return <RepoList repos={repos} returnTo={returnTo} />;
}

/** The board's repositories, kept up to date as cards arrive and shapes change. */
function useBoardRepos(): BoardRepo[] {
	const doc = useContext(DocContext);
	const read = () => (doc ? boardRepos(cardRefs(doc), (key) => cardStore.get(key)) : []);
	const [repos, setRepos] = useState(read);
	useEffect(() => {
		if (!doc) return;
		// Cards arrive in bursts: work it out again once a frame at most.
		let frame = 0;
		const update = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				setRepos(boardRepos(cardRefs(doc), (key) => cardStore.get(key)));
			});
		};
		update();
		const shapes = shapesMap(doc);
		shapes.observe(update);
		const unsubscribe = cardStore.subscribeAll(update);
		return () => {
			cancelAnimationFrame(frame);
			shapes.unobserve(update);
			unsubscribe();
		};
	}, [doc]);
	return repos;
}

/** Whether a repository's forge has an app to install (GitHub's, and the test forge standing in for it). */
function hasApp(key: string): boolean {
	const forge = forgeForHost(key.slice(0, key.indexOf("/")));
	return forge === "github" || forge === "fake";
}

/** The list itself, from data: the gallery shows it too. */
export function RepoList({ repos, returnTo }: { repos: BoardRepo[]; returnTo: string }) {
	if (repos.length === 0) return null;
	const install = `/setup/install?state=${encodeURIComponent(returnTo)}`;
	const blocked = repos.filter((repo) => repo.state === "readonly").length;
	const forges = forgeNameOf(repos.map((repo) => repo.key));
	return (
		<section className="share-repos" aria-label="Repositories on this board">
			<h3>
				{forges === "their forges" ? "Repositories" : `On ${forges}`}
				{blocked > 0 && (
					<span className="share-repos-flag">
						{blocked === 1 ? "1 can’t be pushed to" : `${blocked} can’t be pushed to`}
					</span>
				)}
			</h3>
			<ul>
				{repos.map((repo, i) => (
					<li key={repo.key} data-state={repo.state} style={{ "--i": i } as React.CSSProperties}>
						<span className="share-repo-glyph" aria-hidden="true">
							<svg width="14" height="14" viewBox="0 0 16 16">
								{repo.state === "ready" ? (
									<path d="M3.5 8.5l3 3 6-7" />
								) : repo.state === "checked" ? (
									<>
										<circle cx="8" cy="8" r="5.75" />
										<path d="M8 4.75V8l2.25 1.5" />
									</>
								) : repo.state === "loading" ? (
									<circle cx="8" cy="8" r="2" />
								) : (
									<>
										<circle cx="8" cy="8" r="5.75" />
										<path d="M8 5v3.5M8 10.9v.1" />
									</>
								)}
							</svg>
						</span>
						<span className="share-repo-name">{repo.name}</span>
						<span className="share-repo-state">{COPY[repo.state]}</span>
						{repo.state === "readonly" && hasApp(repo.key) && (
							<a
								className="share-repo-install"
								href={install}
								title="Installing needs an owner of the account; GitHub asks one if it isn’t you"
							>
								Install the app
							</a>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}
