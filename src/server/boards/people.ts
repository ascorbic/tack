// Who to invite to a board: people on this Tack, and checking that a login
// is a real GitHub user before an invite is sent to it.
//
//   GET /api/people?q=al        people who've signed in here, by login or name
//   GET /api/people/:login      who a login is (see `PersonLookup`)
//
// Both need instance access. GitHub is asked with the viewer's own token,
// so a lookup costs their rate limit, not the app's; without one (dev
// sign-in, Previews), logins nobody here knows come back `unchecked` and
// invites to them go through as before.

import type { PeopleSuggestions, PersonLookup } from "../../shared/boards.ts";
import { normaliseLogins } from "../auth/logins.ts";
import { json } from "../auth/http.ts";
import { gh } from "../github/api.ts";
import { viewerToken } from "../identity.ts";
import { log } from "../log.ts";
import { instance } from "../namespaces.ts";
import type { Visitor } from "./access.ts";
import { notAllowed, safeDecode, visitorFor } from "./http.ts";

/** How long a GitHub answer about a login is reused, per isolate. */
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; answer: Answer }>();

export async function handlePeople(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== "/api/people" && !url.pathname.startsWith("/api/people/")) return null;
	if (request.method !== "GET") return notAllowed();
	const visitor = await visitorFor(request, env);
	if (!visitor.user) return json({ error: "sign_in_required" }, { status: 401 });
	if (!visitor.allowed) return json({ error: "forbidden" }, { status: 403 });

	if (url.pathname === "/api/people") {
		const q = (url.searchParams.get("q") ?? "").slice(0, 40);
		if (!env.TACK_SECRET || !q.trim()) return json({ people: [] } satisfies PeopleSuggestions);
		const people = await instance(env).people({ q }, 8);
		return json({
			people: people.map(({ allowed, ...person }) => ({
				login: person.login.toLowerCase(),
				status: "known",
				person,
				allowed,
			})),
		} satisfies PeopleSuggestions);
	}

	const login = safeDecode(url.pathname.slice("/api/people/".length));
	const { valid } = normaliseLogins(login ? [login] : []);
	const clean = valid[0];
	if (!clean) return json({ error: "invalid_login" }, { status: 422 });
	const [lookup] = await lookupLogins(env, visitor, [clean]);
	return json(lookup);
}

/**
 * Who each of these (normalised) logins is: people who've signed in here
 * first, then GitHub, asked with the visitor's own token.
 */
export async function lookupLogins(
	env: Env,
	visitor: Visitor,
	logins: string[],
): Promise<PersonLookup[]> {
	const known = new Map(
		(env.TACK_SECRET ? await instance(env).people({ logins }) : []).map(
			({ allowed, ...person }) => [person.login.toLowerCase(), { person, allowed }],
		),
	);
	const unknown = logins.filter((login) => !known.has(login));
	const token =
		unknown.length > 0 && visitor.user
			? await viewerToken(env, visitor.user).catch(() => null)
			: null;
	const asked = new Map(
		await Promise.all(
			unknown.map(async (login) => [login, await askGitHub(login, token)] as const),
		),
	);
	return Promise.all(
		logins.map(async (login): Promise<PersonLookup> => {
			const here = known.get(login);
			if (here) return { login, status: "known", person: here.person, allowed: here.allowed };
			const answer = asked.get(login) ?? { status: "unchecked" as const, person: null };
			const allowed =
				answer.status === "github" || answer.status === "unchecked"
					? env.TACK_SECRET
						? await instance(env).loginAllowed(login)
						: true
					: null;
			return { login, ...answer, allowed };
		}),
	);
}

/** The logins an invite must refuse: GitHub says there's no such user, or it's an organisation. */
export function refusedLogins(lookups: PersonLookup[]): string[] {
	return lookups
		.filter((lookup) => lookup.status === "unknown" || lookup.status === "organization")
		.map((lookup) => lookup.login);
}

type Answer = Pick<PersonLookup, "status" | "person">;

/** What GitHub says about a login, asked with someone's token, and kept a while. */
async function askGitHub(login: string, token: string | null): Promise<Answer> {
	const unchecked: Answer = { status: "unchecked", person: null };
	if (!token) return unchecked;
	const cached = cache.get(login);
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.answer;
	try {
		const response = await gh(`/users/${encodeURIComponent(login)}`, { auth: `Bearer ${token}` });
		let answer: Answer;
		if (response.status === 404) {
			answer = { status: "unknown", person: null };
		} else if (response.ok) {
			const user = await response.json<{
				id: number;
				login: string;
				name: string | null;
				avatar_url: string;
				type?: string;
			}>();
			answer = {
				status: user.type === "Organization" ? "organization" : "github",
				person: { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatar_url },
			};
		} else {
			// Rate limited, or GitHub's having a moment: don't stand in the way.
			log.warn("people.lookup.failed", { login, status: response.status });
			return unchecked;
		}
		if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value ?? "");
		cache.set(login, { at: Date.now(), answer });
		return answer;
	} catch (error) {
		log.warn("people.lookup.failed", { login, error });
		return unchecked;
	}
}
