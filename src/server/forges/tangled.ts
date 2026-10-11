import type { Card, CardState, MissingCard } from "../../shared/cards.ts";
import { itemKey } from "../../shared/refs.ts";
import { hostConfig } from "./config.ts";
import { forgeFetch, rateLimitOf } from "./rateLimit.ts";
import { iso, missingReason, segments, TIMEOUT_MS } from "./rest.ts";
import type { FetchRef, ForgeAdapter, PollResult, RepoIdentity } from "./types.ts";

// Tangled (tangled.org), read-only, #65. Tangled is built on atproto: an
// issue or pull is a record in its author's own repository
// (`sh.tangled.repo.issue`, `sh.tangled.repo.pull`), its state is other
// records (`….issue.state`, `….pull.status`) and comments more still, all
// spread across people's PDSes. Tangled's index, `api.tangled.org`, reads
// them off the network and answers XRPC queries with each record's derived
// state and comment count (`sh.tangled.repo.listIssues`, `listPulls`).
//
// What it doesn't have is the number in an item's link (`/issues/775`):
// Tangled's appview gives those out as it sees records, so the only place
// to learn which record #775 is is the appview's page for it, which names
// the record's AT-URI. Tack reads that once per item and keeps the AT-URI as
// the card's `nodeId`; everything after goes through the index.
//
// Keys: `tangled.org/{handle}/{repo}#n` for issues and `!n` for pulls
// (Tangled numbers them separately). There are no webhooks: repositories
// are polled while a board has them open (one query per author of the
// board's items), and never live. Following the network's firehose instead
// (Jetstream, filtered to Tangled's collections) is the way to make them
// live; see the forges page of the docs for that design.

/** An AT-URI for a Tangled issue or pull: nothing else goes in a query. */
const RECORD_URI =
	/^at:\/\/(did:(?:plc|web):[a-z0-9.:%-]+)\/sh\.tangled\.repo\.(issue|pull)\/([a-z0-9]+)$/i;
const DID = /^did:(?:plc|web):[a-z0-9.:%-]+$/i;
/** How many records one `getIssues`/`getPulls` asks for. */
const BATCH = 50;
/** How many of an author's items one list asks for. */
const LIST_LIMIT = 100;

type Kind = "issue" | "pull";

interface RecordView {
	uri: string;
	value?: {
		title?: string;
		createdAt?: string;
		/** Issues: the repository, as its DID (or, in older records, its record's AT-URI). */
		repo?: string;
		/** Pulls: where they're to merge. */
		target?: { repo?: string };
	};
}

interface ListItem extends RecordView {
	state?: string;
	stateUpdatedAt?: string;
	commentCount?: number;
}

/** The index's address for a Tangled host: `api.` in front. */
function apiBase(host: string): string {
	return `https://api.${host}/xrpc`;
}

async function xrpc<T>(host: string, method: string, params: URLSearchParams): Promise<T | null> {
	const response = await forgeFetch(`${apiBase(host)}/${method}?${params.toString()}`, {
		headers: { accept: "application/json", "user-agent": "tack" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		if (response.status === 400 || response.status === 404) return null;
		throw new Error(`${method} answered ${response.status}`);
	}
	return response.json<T>();
}

/** The record an item's number stands for, from the appview's page for it. */
async function recordUri(host: string, repo: string, kind: Kind, n: number): Promise<string> {
	const page = `https://${host}/${segments(repo)}/${kind === "pull" ? "pulls" : "issues"}/${n}`;
	const response = await forgeFetch(page, {
		headers: { accept: "text/html", "user-agent": "tack" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	}).catch(() => null);
	if (!response) return "error";
	if (!response.ok) return missingReason(response);
	const html = await response.text();
	return uriInPage(html, kind) ?? "not_found";
}

/**
 * The item's own AT-URI in its page: the subject of its reactions, or
 * failing that the one named most (references to others are named once).
 */
export function uriInPage(html: string, kind: Kind): string | null {
	const collection = kind === "pull" ? "sh\\.tangled\\.repo\\.pull" : "sh\\.tangled\\.repo\\.issue";
	const uri = `at://did:(?:plc|web):[a-z0-9.:%-]+/${collection}/[a-z0-9]+`;
	const subject = new RegExp(`name="subject-uri"[^>]*value="(${uri})"`, "i").exec(html);
	if (subject?.[1]) return subject[1];
	const counts = new Map<string, number>();
	for (const match of html.matchAll(new RegExp(uri, "gi"))) {
		counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
	}
	const [best] = [...counts].sort((a, b) => b[1] - a[1]);
	return best?.[0] ?? null;
}

const handles = new Map<string, { handle: string | null; until: number }>();

/** Someone's handle, from the PLC directory (cached an hour per isolate). */
async function handleOf(did: string): Promise<string | null> {
	const cached = handles.get(did);
	if (cached && cached.until > Date.now()) return cached.handle;
	let handle: string | null = null;
	if (did.startsWith("did:plc:")) {
		const response = await forgeFetch(`https://plc.directory/${encodeURIComponent(did)}`, {
			headers: { accept: "application/json", "user-agent": "tack" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		}).catch(() => null);
		if (response?.ok) {
			const doc = await response.json<{ alsoKnownAs?: string[] }>().catch(() => null);
			handle = doc?.alsoKnownAs?.find((aka) => aka.startsWith("at://"))?.slice(5) ?? null;
		}
	}
	if (handles.size > 2000) handles.clear();
	handles.set(did, { handle, until: Date.now() + 60 * 60_000 });
	return handle;
}

/** The DID an item's repository goes by, from its record. */
async function repoDidOf(host: string, record: RecordView): Promise<string | null> {
	const repo = record.value?.repo ?? record.value?.target?.repo;
	if (!repo) return null;
	if (DID.test(repo)) return repo;
	// Older records name the repository's own record: its DID is in there.
	if (/^at:\/\/did:[^/]+\/sh\.tangled\.repo\/[\w.-]+$/i.test(repo)) {
		const found = await xrpc<{ value?: { repoDid?: string } }>(
			host,
			"sh.tangled.repo.getRepo",
			new URLSearchParams({ repo }),
		).catch(() => null);
		const did = found?.value?.repoDid;
		return did && DID.test(did) ? did : null;
	}
	return null;
}

/** Records by AT-URI, for one kind, fifty at a time. */
async function getRecords(
	host: string,
	kind: Kind,
	uris: string[],
): Promise<Map<string, RecordView>> {
	const found = new Map<string, RecordView>();
	for (let i = 0; i < uris.length; i += BATCH) {
		const params = new URLSearchParams();
		for (const uri of uris.slice(i, i + BATCH))
			params.append(kind === "pull" ? "pulls" : "issues", uri);
		const answer = await xrpc<{ items?: RecordView[] }>(
			host,
			kind === "pull" ? "sh.tangled.repo.getPulls" : "sh.tangled.repo.getIssues",
			params,
		);
		for (const item of answer?.items ?? []) found.set(item.uri, item);
	}
	return found;
}

/** An author's items in a repository, with their state and comment counts. */
async function listByAuthor(
	host: string,
	kind: Kind,
	repoDid: string,
	author: string,
): Promise<Map<string, ListItem>> {
	const found = new Map<string, ListItem>();
	let cursor: string | undefined;
	for (let page = 0; page < 3; page++) {
		const params = new URLSearchParams({
			subject: repoDid,
			author,
			limit: String(LIST_LIMIT),
			...(cursor ? { cursor } : {}),
		});
		const answer = await xrpc<{ items?: ListItem[]; cursor?: string }>(
			host,
			kind === "pull" ? "sh.tangled.repo.listPulls" : "sh.tangled.repo.listIssues",
			params,
		);
		for (const item of answer?.items ?? []) found.set(item.uri, item);
		cursor = answer?.cursor;
		if (!cursor) break;
	}
	return found;
}

export function stateOf(kind: Kind, state: string | undefined): CardState {
	if (state === "closed") return "closed";
	if (kind === "pull" && state === "merged") return "merged";
	return "open";
}

/** A Tangled item as a card. */
export function normaliseTangled(
	host: string,
	repo: string,
	kind: Kind,
	n: number,
	uri: string,
	record: RecordView,
	listed: ListItem | undefined,
	author: string | null,
): Card {
	const item = `${kind === "pull" ? "!" : "#"}${n}`;
	const createdAt = iso(record.value?.createdAt ?? null);
	const stateAt = iso(listed?.stateUpdatedAt ?? null);
	const updatedAt =
		[createdAt, stateAt]
			.filter((t): t is string => Boolean(t))
			.sort()
			.at(-1) ?? new Date(0).toISOString();
	const state = stateOf(kind, listed?.state);
	return {
		key: itemKey({ host, repo, item }),
		forge: "tangled",
		host,
		repo: repo.toLowerCase(),
		item,
		kind,
		title: record.value?.title ?? `${kind === "pull" ? "Pull" : "Issue"} ${n}`,
		state,
		stateReason: null,
		labels: [],
		assignees: [],
		author: author ? { login: author, avatarUrl: "" } : null,
		comments: listed?.commentCount ?? 0,
		reactions: 0,
		url: `https://${host}/${repo}/${kind === "pull" ? "pulls" : "issues"}/${n}`,
		updatedAt,
		...(createdAt ? { createdAt } : {}),
		closedAt: state === "open" ? null : stateAt,
		...(kind === "pull" ? { mergedAt: state === "merged" ? stateAt : null } : {}),
		nodeId: uri,
		...(kind === "pull"
			? {
					pull: {
						detail: "full" as const,
						head: null,
						checks: null,
						review: null,
						reviewers: [],
						mergeable: "unknown" as const,
						linked: [],
					},
				}
			: {}),
	};
}

interface Wanted {
	ref: FetchRef;
	kind: Kind;
	n: number;
	uri?: string;
}

/** Items of one repository, as cards: their records, then each author's list for state. */
async function fetchTangled(
	host: string,
	repo: string,
	wanted: Wanted[],
): Promise<Map<FetchRef, Card | MissingCard>> {
	const results = new Map<FetchRef, Card | MissingCard>();
	// Which record each number is: kept on the card, else read off its page.
	await Promise.all(
		wanted.map(async (want) => {
			if (want.uri && RECORD_URI.test(want.uri)) return;
			const found = await recordUri(host, repo, want.kind, want.n);
			if (RECORD_URI.test(found)) want.uri = found;
			else
				results.set(want.ref, {
					key: itemKey(want.ref),
					missing: true,
					reason: found as MissingCard["reason"],
				});
		}),
	);
	for (const kind of ["issue", "pull"] as const) {
		const ofKind = wanted.filter(
			(want) => want.kind === kind && want.uri && !results.has(want.ref),
		);
		if (ofKind.length === 0) continue;
		const records = await getRecords(
			host,
			kind,
			ofKind.map((want) => want.uri as string),
		);
		// State and comments come from each author's list in the repository.
		const lists = new Map<string, Map<string, ListItem>>();
		const repoDid = await (async () => {
			for (const record of records.values()) {
				const did = await repoDidOf(host, record);
				if (did) return did;
			}
			return null;
		})();
		const authors = [
			...new Set(ofKind.map((want) => RECORD_URI.exec(want.uri as string)?.[1] ?? "")),
		].filter(Boolean);
		if (repoDid) {
			await Promise.all(
				authors.map(async (author) => {
					lists.set(author, await listByAuthor(host, kind, repoDid, author).catch(() => new Map()));
				}),
			);
		}
		const names = new Map(
			await Promise.all(authors.map(async (did) => [did, await handleOf(did)] as const)),
		);
		for (const want of ofKind) {
			const uri = want.uri as string;
			const record = records.get(uri);
			if (!record) {
				results.set(want.ref, { key: itemKey(want.ref), missing: true, reason: "not_found" });
				continue;
			}
			const author = RECORD_URI.exec(uri)?.[1] ?? "";
			results.set(
				want.ref,
				normaliseTangled(
					host,
					repo,
					kind,
					want.n,
					uri,
					record,
					lists.get(author)?.get(uri),
					names.get(author) ?? null,
				),
			);
		}
	}
	return results;
}

function wantedOf(ref: FetchRef): Wanted | null {
	const match = /^([#!])(\d+)$/.exec(ref.item);
	if (!match) return null;
	return {
		ref,
		kind: match[1] === "!" ? "pull" : "issue",
		n: Number(match[2]),
		...(ref.nodeId ? { uri: ref.nodeId } : {}),
	};
}

/** Fresh cards for those that changed: their state, comments and titles, read again. */
async function refreshCards(repo: RepoIdentity, cards: Card[]): Promise<PollResult> {
	const wanted = cards.flatMap((card) => {
		const want = wantedOf({
			forge: "tangled",
			host: repo.host,
			repo: repo.name,
			item: card.item,
			...(card.nodeId ? { nodeId: card.nodeId } : {}),
		});
		return want ? [want] : [];
	});
	try {
		const fresh = await fetchTangled(repo.host, repo.name, wanted);
		const byItem = new Map(cards.map((card) => [card.item, card]));
		const changed = [...fresh.values()].filter((entry) => {
			if ("missing" in entry) return entry.reason !== "error";
			const before = byItem.get(entry.item);
			return (
				!before ||
				JSON.stringify({
					...before,
					live: undefined,
					writable: undefined,
					visibility: undefined,
				}) !==
					JSON.stringify({ ...entry, live: undefined, writable: undefined, visibility: undefined })
			);
		});
		return { status: "changed", etag: null, cards: changed };
	} catch (error) {
		const response = error instanceof Response ? error : null;
		const limit = response ? rateLimitOf(response) : null;
		return { status: "error", ...(limit ? { retryAt: limit.retryAt } : {}) };
	}
}

export const tangled: ForgeAdapter = {
	id: "tangled",
	capabilities: {
		subIssues: false,
		blockedBy: false,
		discussions: false,
		draftPulls: false,
		ciStatus: false,
		writes: [],
	},
	// No webhooks: never live, so polled while watched.
	liveFromDeliveries: true,

	async fetchItems(refs, env, repo) {
		const first = refs[0];
		if (!first) return [];
		const host = first.host.toLowerCase();
		const config = hostConfig(env, host);
		const results = new Map<FetchRef, Card | MissingCard>();
		const wanted: Wanted[] = [];
		for (const ref of refs) {
			const want = config?.forge === "tangled" ? wantedOf(ref) : null;
			if (want) wanted.push(want);
			else results.set(ref, { key: itemKey(ref), missing: true, reason: "unsupported" });
		}
		if (wanted.length > 0) {
			const fetched = await fetchTangled(host, repo?.name ?? first.repo, wanted).catch(
				() => new Map(),
			);
			for (const [ref, card] of fetched) results.set(ref, card);
		}
		return refs.map(
			(ref) => results.get(ref) ?? { key: itemKey(ref), missing: true, reason: "error" },
		);
	},

	async reconcile(repo, cards) {
		const result = await refreshCards(repo, cards);
		return result.status === "changed" ? result.cards : [];
	},

	async poll(repo, cards) {
		return refreshCards(repo, cards);
	},
};
