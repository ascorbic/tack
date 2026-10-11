import {
	CONFIGURABLE_FORGES,
	type ConfigurableForge,
	DEFAULT_FORGE_HOSTS,
	type ForgeHost,
	HOST_RE,
	setForgeHosts,
} from "../../shared/refs.ts";
import { log } from "../log.ts";

// The forges an instance serves besides GitHub (#65): GitLab, Forgejo
// (Codeberg, Gitea) and Tangled hosts, with the credentials Tack uses there.
//
// gitlab.com, codeberg.org and tangled.org are on out of the box, read
// anonymously (public repositories only). `TACK_FORGES`, an optional secret
// holding JSON, adds self-hosted instances, gives any host a token and a
// webhook secret, turns writes on, or turns a default host off:
//
//   [
//     { "host": "git.example.com", "forge": "gitlab", "name": "Acme GitLab",
//       "token": "glpat-…", "webhookSecret": "…", "writes": true },
//     { "host": "codeberg.org", "token": "…", "webhookSecret": "…" },
//     { "host": "tangled.org", "off": true }
//   ]
//
// Tokens are the instance's own (a bot account's), never a person's: on
// these forges Tack has no sign-in, so everything it reads or writes there
// is as that account. Writes are off unless `writes` is true, and then any
// editor of a board may push through it, or only the GitHub logins in
// `writers`. Repositories that aren't public are never shown to anyone (see
// `canRead` in each adapter): Tack can't tell who may read them.

export interface ForgeHostConfig extends ForgeHost {
	forge: ConfigurableForge;
	name: string;
	/** The instance's token for the host's API. */
	token: string | null;
	/** Webhooks from the host are checked against this. Without it, they're refused. */
	webhookSecret: string | null;
	/** Whether pushing writes there (with `token`). */
	writes: boolean;
	/** GitHub logins (lowercase) who may push there; null for any editor. */
	writers: string[] | null;
}

const DEFAULTS: ForgeHostConfig[] = DEFAULT_FORGE_HOSTS.map((entry) => ({
	host: entry.host,
	forge: entry.forge as ConfigurableForge,
	name: entry.name ?? entry.host,
	token: null,
	webhookSecret: null,
	writes: false,
	writers: null,
}));

const isForge = (value: unknown): value is ConfigurableForge =>
	typeof value === "string" && (CONFIGURABLE_FORGES as readonly string[]).includes(value);

const text = (value: unknown): string | null =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * Read `TACK_FORGES`. Entries that don't make sense are left out (and the
 * reason logged), never guessed at; the rest still apply.
 */
export function readForgeConfig(raw: string | undefined): {
	hosts: ForgeHostConfig[];
	problems: string[];
} {
	const problems: string[] = [];
	const hosts = new Map(DEFAULTS.map((entry) => [entry.host, { ...entry }]));
	if (!raw?.trim()) return { hosts: [...hosts.values()], problems };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { hosts: [...hosts.values()], problems: ["TACK_FORGES isn't JSON"] };
	}
	if (!Array.isArray(parsed)) {
		return { hosts: [...hosts.values()], problems: ["TACK_FORGES isn't a list"] };
	}
	parsed.forEach((value: unknown, index) => {
		const entry = (value ?? {}) as Record<string, unknown>;
		const host = text(entry.host)?.toLowerCase().replace(/\/+$/, "") ?? "";
		if (!HOST_RE.test(host)) {
			problems.push(`entry ${index + 1}: “host” must be a host name, like git.example.com`);
			return;
		}
		if (host === "github.com" || host === "fake.tack") {
			problems.push(`entry ${index + 1}: ${host} can't be configured here`);
			return;
		}
		const existing = hosts.get(host);
		if (entry.off === true) {
			hosts.delete(host);
			return;
		}
		const forge = entry.forge === undefined ? existing?.forge : entry.forge;
		if (!isForge(forge)) {
			problems.push(
				`entry ${index + 1} (${host}): “forge” must be one of ${CONFIGURABLE_FORGES.join(", ")}`,
			);
			return;
		}
		const writers = Array.isArray(entry.writers)
			? entry.writers.flatMap((login) =>
					typeof login === "string" && /^[\w-]+$/.test(login.trim())
						? [login.trim().toLowerCase()]
						: [],
				)
			: null;
		hosts.set(host, {
			host,
			forge,
			name: text(entry.name) ?? existing?.name ?? host,
			token: text(entry.token),
			webhookSecret: text(entry.webhookSecret),
			// Tangled is read-only (see tangled.ts).
			writes: entry.writes === true && forge !== "tangled",
			writers,
		});
	});
	return { hosts: [...hosts.values()], problems };
}

let cached: { raw: string | undefined; hosts: ForgeHostConfig[] } | null = null;

/** Every configured forge host besides GitHub's, defaults included (cached per isolate). */
export function forgeConfig(env: Pick<Env, "TACK_FORGES">): ForgeHostConfig[] {
	const raw = env.TACK_FORGES;
	if (cached && cached.raw === raw) return cached.hosts;
	const { hosts, problems } = readForgeConfig(raw);
	if (problems.length > 0) log.warn("forge.config.invalid", { problems });
	cached = { raw, hosts };
	setForgeHosts(hosts.map(({ host, forge, name }) => ({ host, forge, name })));
	return hosts;
}

/** The configuration for one host, if this instance serves it. */
export function hostConfig(env: Pick<Env, "TACK_FORGES">, host: string): ForgeHostConfig | null {
	const wanted = host.toLowerCase();
	return forgeConfig(env).find((entry) => entry.host === wanted) ?? null;
}

/**
 * Make sure the hosts that keys may name (`parseKey`, `parseRef`) are this
 * instance's. Every entry point calls it (the Worker's handlers, and each
 * Durable Object as it starts), since each may run in its own isolate.
 */
export function configureForges(env: Pick<Env, "TACK_FORGES">): void {
	// Set every time (it's a handful of hosts): whatever set them last, they're this instance's now.
	setForgeHosts(forgeConfig(env).map(({ host, forge, name }) => ({ host, forge, name })));
}

/** What the client needs to know about the hosts (no credentials): for `/api/me`. */
export function publicForgeHosts(env: Pick<Env, "TACK_FORGES">): ForgeHost[] {
	return forgeConfig(env).map(({ host, forge, name }) => ({ host, forge, name }));
}

/**
 * Whether this person may push to a host's repositories through its token.
 * `login` is their GitHub login; writes must be on.
 */
export function mayWrite(config: ForgeHostConfig | null, login: string | null): boolean {
	if (!config?.writes || !config.token) return false;
	if (config.writers === null) return true;
	return login !== null && config.writers.includes(login.toLowerCase());
}
