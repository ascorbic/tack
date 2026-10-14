import {
	GITHUB_REACTIONS,
	MAX_NAMED,
	type ReactionGroup,
	type ReactorsResult,
} from "../../shared/reactions.ts";
import { itemOf, parseRepoKey, repoKeyOf } from "../../shared/refs.ts";
import type { QueryError } from "../../shared/widgets.ts";
import { isError, readToken, run } from "./github-related.ts";
import type { ReadAuth } from "./types.ts";

// Who reacted to an issue, pull request or discussion on GitHub, for the
// tooltip on a card's reaction count: one GraphQL query, its
// `reactionGroups` with the first few `reactors` of each and their names.
// Asked only when someone hovers the count, never with the card's data (a
// card fetch would grow by a connection per kind of reaction). Discussions
// share their repository's numbers, so the query asks for both; the one
// that isn't there comes back null.

const HOST = "github.com";

const GROUPS = `reactionGroups {
	content
	reactors(first: ${MAX_NAMED}) {
		totalCount
		nodes {
			__typename
			... on User { login name }
			... on Bot { login }
			... on Mannequin { login }
			... on Organization { login name }
		}
	}
}`;

const REACTORS = `query TackReactors($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) {
		issueOrPullRequest(number: $number) {
			__typename
			... on Issue { ${GROUPS} }
			... on PullRequest { ${GROUPS} }
		}
		discussion(number: $number) { ${GROUPS} }
	}
}`;

interface GqlGroup {
	content: string;
	reactors: {
		totalCount: number;
		nodes: ({ login?: string; name?: string | null } | null)[];
	} | null;
}

interface ReactorsData {
	repository: {
		issueOrPullRequest?: { reactionGroups?: GqlGroup[] | null } | null;
		discussion?: { reactionGroups?: GqlGroup[] | null } | null;
	} | null;
}

/** Who reacted to an item, by kind, in GitHub's order. */
export async function reactorsGitHub(
	key: string,
	env: Env,
	auth?: ReadAuth,
): Promise<ReactorsResult | QueryError> {
	const parsed = parseRepoKey(repoKeyOf(key));
	const item = itemOf(key);
	const [owner, name] = parsed?.repo.split("/") ?? [];
	if (!parsed || parsed.host !== HOST || !owner || !name || !item?.startsWith("#")) {
		return { kind: "error", reason: "invalid", message: "That isn’t a GitHub item." };
	}
	const token = await readToken(env, parsed.repo, auth);
	if (!token) {
		return { kind: "error", reason: "signed_out", message: "Sign in with GitHub to see who." };
	}
	const data = await run<ReactorsData>(token, "TackReactors", REACTORS, {
		owner,
		name,
		number: Number(item.slice(1)),
	});
	if (isError(data)) return data;
	const node = data.repository?.issueOrPullRequest ?? data.repository?.discussion;
	if (!node) {
		return {
			kind: "error",
			reason: "no_access",
			message: "It doesn’t exist, or you can’t see it.",
		};
	}
	return { kind: "reactors", key, groups: toGroups(node.reactionGroups ?? []) };
}

/** GitHub's groups as ours: only reactions there are, people who are still there. */
export function toGroups(groups: readonly GqlGroup[]): ReactionGroup[] {
	const out: ReactionGroup[] = [];
	for (const group of groups) {
		const emoji = GITHUB_REACTIONS[group.content];
		const count = group.reactors?.totalCount ?? 0;
		if (!emoji || count <= 0) continue;
		out.push({
			emoji,
			count,
			reactors: (group.reactors?.nodes ?? []).flatMap((node) =>
				node?.login ? [{ login: node.login, ...(node.name ? { name: node.name } : {}) }] : [],
			),
		});
	}
	return out;
}
