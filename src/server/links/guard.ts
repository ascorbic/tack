// Fetching a page or image someone put on a board (link cards), safely.
//
// Everywhere else the Worker only fetches forge APIs at fixed hosts. Link
// cards are the one place it fetches an address a person typed, so every
// request goes through `guardedFetch`, which refuses anything that could
// reach somewhere it shouldn't (server-side request forgery):
//
// - http and https only, on their standard ports, with no user or password
//   in the address;
// - no hosts that only mean something locally (`localhost`, `.local`,
//   `.internal`, single labels…), and no IP addresses in private, loopback,
//   link-local (cloud metadata lives at 169.254.169.254), shared, reserved,
//   multicast or documentation ranges, in IPv4 or IPv6, including IPv4
//   written inside IPv6 (mapped, NAT64, 6to4);
// - a host name is resolved first (DNS over HTTPS) and refused if any of
//   its addresses is one of those;
// - redirects are followed by hand, at most `MAX_REDIRECTS`, each hop
//   checked again from the start;
// - every hop has a time limit, and so does the whole;
// - and callers read at most a fixed number of bytes (`readCapped`).
//
// On Cloudflare a Worker's own `fetch` can't reach private networks anyway;
// this is what keeps self-hosted and local runtimes (workerd, `vp dev`) as
// safe, and it doesn't rely on resolving the same answer twice: a host that
// resolves anywhere private, at any hop, is refused.

/** Why an address was refused before anything was fetched. */
export type BlockReason =
	| "scheme"
	| "credentials"
	| "port"
	| "host"
	| "private_address"
	| "too_long"
	| "invalid";

export type FetchFailure =
	| { kind: "blocked"; reason: BlockReason; url: string }
	| { kind: "failed"; reason: "dns" | "timeout" | "network" | "redirects" | "status"; url: string };

export interface GuardedResponse {
	kind: "ok";
	response: Response;
	/** Where it ended up, after redirects. */
	url: string;
}

/** Resolves a host name to its addresses (IPv4 and IPv6), or null if it has none. */
export type Resolver = (host: string) => Promise<string[] | null>;

export interface GuardOptions {
	/** What to fetch with: the global `fetch`, or a fake in tests. */
	fetch?: typeof fetch;
	resolve?: Resolver;
	/** Sent as `Accept`. */
	accept: string;
	/** Per hop. */
	timeoutMs?: number;
	/** All hops together, from the first request to the last response's headers. */
	totalMs?: number;
	maxRedirects?: number;
}

export const MAX_REDIRECTS = 3;
const HOP_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 8_000;
const MAX_URL = 2048;

/** Who's asking, for sites that look: a bot, which says where it's from. */
export const USER_AGENT =
	"Mozilla/5.0 (compatible; TackLinkPreview/1.0; +https://tack.social/docs/self-hosting/security/)";

/** Hosts that only mean something on a local network, by suffix. */
const LOCAL_SUFFIXES = [
	".localhost",
	".local",
	".localdomain",
	".internal",
	".intranet",
	".home.arpa",
	".lan",
	".corp",
	".home",
	".invalid",
	".test",
	".example",
	".onion",
];

/**
 * Whether an address may be fetched at all, before resolving anything:
 * null if so, else why not. Takes a parsed URL; IP literals are checked
 * here (the URL parser has already turned `0x7f.1`, `2130706433` and the
 * like into dotted IPv4).
 */
export function checkUrl(url: URL): BlockReason | null {
	if (url.href.length > MAX_URL) return "too_long";
	if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
	if (url.username || url.password) return "credentials";
	// The URL parser drops a port that's the scheme's default, so any port left isn't.
	if (url.port !== "") return "port";
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (!host) return "host";
	if (host.startsWith("[")) {
		return isPublicAddress(host.slice(1, -1)) ? null : "private_address";
	}
	if (isIPv4(host)) return isPublicAddress(host) ? null : "private_address";
	if (host === "localhost" || !host.includes(".")) return "host";
	if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "host";
	// Anything a DNS name can't be (the parser lets some through).
	if (
		!/^[a-z0-9_.-]+$/.test(host) ||
		host.split(".").some((label) => !label || label.length > 63)
	) {
		return "host";
	}
	return null;
}

/** Whether a host is an IP address rather than a name: no DNS needed. */
function isLiteral(host: string): boolean {
	return host.startsWith("[") || isIPv4(host);
}

function isIPv4(text: string): boolean {
	return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text) && text.split(".").every((part) => +part <= 255);
}

function v4Number(text: string): number {
	return text.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

/** IPv4 ranges that aren't the public internet: [first address, prefix length]. */
const PRIVATE_V4: [string, number][] = [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8], // private
	["100.64.0.0", 10], // shared (carrier-grade NAT; Alibaba's metadata)
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, and cloud metadata (169.254.169.254)
	["172.16.0.0", 12], // private
	["192.0.0.0", 24], // IETF protocol assignments
	["192.0.2.0", 24], // documentation
	["192.31.196.0", 24], // AS112
	["192.52.193.0", 24], // AMT
	["192.88.99.0", 24], // 6to4 relay anycast
	["192.168.0.0", 16], // private
	["192.175.48.0", 24], // AS112
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // documentation
	["203.0.113.0", 24], // documentation
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, and broadcast
];

function privateV4(address: string): boolean {
	const n = v4Number(address);
	return PRIVATE_V4.some(([base, bits]) => {
		const size = 2 ** (32 - bits);
		const start = v4Number(base);
		return n >= start && n < start + size;
	});
}

/** An IPv6 address as eight 16-bit numbers, or null if it isn't one. */
export function parseV6(text: string): number[] | null {
	let address = text.toLowerCase();
	const zone = address.indexOf("%");
	if (zone >= 0) address = address.slice(0, zone);
	// A trailing dotted IPv4 (`::ffff:1.2.3.4`) is the last two groups.
	const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
	if (dotted?.[1]) {
		if (!isIPv4(dotted[1])) return null;
		const n = v4Number(dotted[1]);
		address = `${address.slice(0, dotted.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
	}
	const halves = address.split("::");
	if (halves.length > 2) return null;
	const parse = (part: string) => (part ? part.split(":") : []);
	const head = parse(halves[0] ?? "");
	const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
	return groups.map((group) => Number.parseInt(group, 16));
}

/** The IPv4 address in the last 32 bits of an IPv6 one, dotted. */
function embeddedV4(groups: number[]): string {
	const high = groups[6] ?? 0;
	const low = groups[7] ?? 0;
	return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function privateV6(groups: number[]): boolean {
	const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = groups;
	// Unspecified and loopback (::, ::1), and IPv4-compatible (::a.b.c.d, deprecated).
	if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return true;
	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d): the IPv4 decides.
	if (
		a === 0 &&
		b === 0 &&
		c === 0 &&
		d === 0 &&
		((e === 0 && f === 0xffff) || (e === 0xffff && f === 0))
	) {
		return !isPublicAddress(embeddedV4(groups));
	}
	// NAT64 (64:ff9b::/96): the IPv4 decides. Local-use NAT64 (64:ff9b:1::/48) never.
	if (a === 0x64 && b === 0xff9b) {
		if (c === 1) return true;
		if (c === 0 && d === 0 && e === 0 && f === 0) return !isPublicAddress(embeddedV4(groups));
		return true;
	}
	// 6to4 (2002::/16): the IPv4 in the next 32 bits decides.
	if (a === 0x2002) return !isPublicAddress([b >> 8, b & 0xff, c >> 8, c & 0xff].join("."));
	if (a === 0x0100 && b === 0 && c === 0 && d === 0) return true; // discard (100::/64)
	if (a === 0x2001 && b < 0x0200) return true; // IETF protocol assignments, Teredo (2001::/23)
	if (a === 0x2001 && b === 0x0db8) return true; // documentation
	if (a === 0x3fff && b < 0x1000) return true; // documentation (3fff::/20)
	if ((a & 0xfe00) === 0xfc00) return true; // unique local (fc00::/7), AWS's metadata included
	if ((a & 0xffc0) === 0xfe80) return true; // link-local (fe80::/10)
	if ((a & 0xffc0) === 0xfec0) return true; // site-local (fec0::/10, deprecated)
	if ((a & 0xff00) === 0xff00) return true; // multicast
	return false;
}

/** Whether an IP address (v4 dotted, or v6 without brackets) is on the public internet. */
export function isPublicAddress(address: string): boolean {
	if (isIPv4(address)) return !privateV4(address);
	const groups = parseV6(address);
	return groups ? !privateV6(groups) : false;
}

const DOH = "https://cloudflare-dns.com/dns-query";

/**
 * Resolve a host over DNS over HTTPS (Cloudflare's resolver, as Workers
 * have no DNS of their own): every A and AAAA answer, after CNAMEs. Null
 * if it has none, or the resolver can't say.
 */
export function dohResolver(fetcher: typeof fetch = fetch): Resolver {
	return async (host) => {
		const lookups = await Promise.all(
			(["A", "AAAA"] as const).map(async (type) => {
				const url = `${DOH}?name=${encodeURIComponent(host)}&type=${type}`;
				const response = await fetcher(url, {
					headers: { accept: "application/dns-json" },
					signal: AbortSignal.timeout(3_000),
				}).catch(() => null);
				if (!response?.ok) return null;
				const body = (await response.json().catch(() => null)) as {
					Status?: number;
					Answer?: { type?: number; data?: string }[];
				} | null;
				if (!body || body.Status !== 0) return [];
				return (body.Answer ?? [])
					.filter((answer) => answer.type === 1 || answer.type === 28)
					.map((answer) => String(answer.data ?? ""));
			}),
		);
		if (lookups.every((answers) => answers === null)) return null;
		const addresses = lookups.flatMap((answers) => answers ?? []);
		return addresses.length > 0 ? addresses : null;
	};
}

/**
 * Fetch `input` with every check above, following redirects by hand.
 * Never throws: a refusal or failure comes back as a `FetchFailure`.
 */
export async function guardedFetch(
	input: string,
	options: GuardOptions,
): Promise<GuardedResponse | FetchFailure> {
	const fetcher = options.fetch ?? fetch;
	const resolve = options.resolve ?? dohResolver(fetcher);
	const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
	const deadline = AbortSignal.timeout(options.totalMs ?? TOTAL_TIMEOUT_MS);
	let current = input;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		let url: URL;
		try {
			url = new URL(current);
		} catch {
			return { kind: "blocked", reason: "invalid", url: current };
		}
		const refused = checkUrl(url);
		if (refused) return { kind: "blocked", reason: refused, url: url.href };
		const host = url.hostname.toLowerCase().replace(/\.$/, "");
		if (!isLiteral(host)) {
			const addresses = await resolve(host).catch(() => null);
			if (!addresses || addresses.length === 0)
				return { kind: "failed", reason: "dns", url: url.href };
			if (!addresses.every(isPublicAddress)) {
				return { kind: "blocked", reason: "private_address", url: url.href };
			}
		}
		let response: Response;
		try {
			response = await fetcher(url.href, {
				method: "GET",
				redirect: "manual",
				headers: {
					accept: options.accept,
					"user-agent": USER_AGENT,
					"accept-language": "en;q=0.9, *;q=0.5",
				},
				signal: AbortSignal.any([
					deadline,
					AbortSignal.timeout(options.timeoutMs ?? HOP_TIMEOUT_MS),
				]),
			});
		} catch (cause) {
			const timedOut =
				cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
			return { kind: "failed", reason: timedOut ? "timeout" : "network", url: url.href };
		}
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel().catch(() => {});
			try {
				current = new URL(location, url).href;
			} catch {
				return { kind: "blocked", reason: "invalid", url: location };
			}
			continue;
		}
		return { kind: "ok", response, url: url.href };
	}
	return { kind: "failed", reason: "redirects", url: current };
}

/**
 * The first `max` bytes of a response's body (all of it, if it's shorter),
 * and whether there was more. Stops reading, and cancels the rest, as soon
 * as it has enough: a huge page costs no more than its head.
 */
export async function readCapped(
	response: Response,
	max: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const declared = Number(response.headers.get("content-length") ?? Number.NaN);
	if (!response.body) return { bytes: new Uint8Array(), truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = Number.isFinite(declared) && declared > max;
	try {
		while (size < max) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
		if (size >= max) truncated = true;
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(Math.min(size, max));
	let offset = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.byteLength, bytes.byteLength - offset);
		if (take <= 0) break;
		bytes.set(chunk.subarray(0, take), offset);
		offset += take;
	}
	return { bytes, truncated };
}
