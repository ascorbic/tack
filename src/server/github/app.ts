// The GitHub App itself: the manifest a fresh instance registers with, and
// the RS256 JWTs the app authenticates with.

import { base64url, fromBase64url } from "../auth/crypto.ts";

/** What GitHub returns when a manifest is converted into an app. */
export interface ManifestConversion {
	id: number;
	slug: string;
	name: string;
	client_id: string;
	client_secret: string;
	webhook_secret: string | null;
	pem: string;
	html_url: string;
	owner: { login: string; id: number; type: string } | null;
}

/** The app's credentials, as stored (encrypted) in the Instance object. */
export interface AppCredentials {
	id: number;
	slug: string;
	name: string;
	clientId: string;
	clientSecret: string;
	webhookSecret: string | null;
	pem: string;
	htmlUrl: string;
	owner: { login: string; id: number; type: string } | null;
}

export function credentialsFromConversion(app: ManifestConversion): AppCredentials {
	return {
		id: app.id,
		slug: app.slug,
		name: app.name,
		clientId: app.client_id,
		clientSecret: app.client_secret,
		webhookSecret: app.webhook_secret,
		pem: app.pem,
		htmlUrl: app.html_url,
		owner: app.owner ? { login: app.owner.login, id: app.owner.id, type: app.owner.type } : null,
	};
}

// `read` for everything we only show, `write` for what Tack pushes: issues,
// pull requests, Discussion posts, and decision records committed to a branch
// (`contents`). Keep /setup's list (SetupPage.tsx) and the self-hosting docs'
// table in step with this.
// Members lets Tack check private org membership for the access allowlist,
// and Actions is needed for `workflow_run` events.
const PERMISSIONS = {
	metadata: "read",
	contents: "write",
	issues: "write",
	pull_requests: "write",
	discussions: "write",
	checks: "read",
	statuses: "read",
	actions: "read",
	members: "read",
} as const;

// `installation` and `installation_repositories` aren't listed: GitHub
// always sends them to apps and rejects them as subscribable events.
// `issue_comment` is for comment commands (#58): apps set up before it was
// added need it turned on in the app's settings, as do `sub_issues` (which
// parent issue each card has), without which cards catch up on their next
// full fetch.
const EVENTS = [
	"issues",
	"issue_comment",
	"sub_issues",
	"pull_request",
	"pull_request_review",
	"check_run",
	"check_suite",
	"status",
	"workflow_run",
	"discussion",
	"repository",
];

/** The manifest for this instance's GitHub App. */
export function appManifest(origin: string) {
	const host = new URL(origin).hostname;
	// GitHub can't deliver webhooks to a local dev server.
	const local = host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
	return {
		name: `Tack (${host})`.slice(0, 34),
		url: origin,
		description: "A GitHub-native whiteboard for open source planning.",
		hook_attributes: { url: `${origin}/webhooks/github`, active: !local },
		redirect_url: `${origin}/setup/callback`,
		callback_urls: [`${origin}/auth/callback`],
		setup_url: `${origin}/setup/installed`,
		setup_on_update: true,
		request_oauth_on_install: false,
		public: false,
		default_permissions: PERMISSIONS,
		default_events: EVENTS,
	};
}

/** GitHub issues PKCS#1 keys (`BEGIN RSA PRIVATE KEY`); WebCrypto wants PKCS#8. */
export function importPrivateKey(pem: string): Promise<CryptoKey> {
	const pkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(pem);
	// fromBase64url also accepts standard base64.
	const der = fromBase64url(
		pem.replace(/-----(BEGIN|END) (RSA )?PRIVATE KEY-----/g, "").replace(/\s+/g, ""),
	);
	return crypto.subtle.importKey(
		"pkcs8",
		pkcs1 ? wrapPkcs1(der) : der,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

/** Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo. */
function wrapPkcs1(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
	const version = [0x02, 0x01, 0x00];
	// AlgorithmIdentifier: rsaEncryption (1.2.840.113549.1.1.1), NULL parameters.
	const algorithm = [
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
	];
	const octets = [0x04, ...derLength(pkcs1.length)];
	const length = version.length + algorithm.length + octets.length + pkcs1.length;
	return new Uint8Array([
		0x30,
		...derLength(length),
		...version,
		...algorithm,
		...octets,
		...pkcs1,
	]);
}

function derLength(length: number): number[] {
	if (length < 0x80) return [length];
	const bytes: number[] = [];
	for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
	return [0x80 | bytes.length, ...bytes];
}

const encoder = new TextEncoder();

/**
 * A JWT for authenticating as the app, valid for nine minutes (GitHub allows
 * ten). Issued a minute in the past to allow for clock drift.
 */
export async function signAppJwt(
	key: CryptoKey,
	issuer: string,
	now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
	const iat = Math.floor(now / 1000) - 60;
	const exp = iat + 60 + 9 * 60;
	const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const payload = base64url(encoder.encode(JSON.stringify({ iat, exp, iss: issuer })));
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		encoder.encode(`${header}.${payload}`),
	);
	return {
		token: `${header}.${payload}.${base64url(new Uint8Array(signature))}`,
		expiresAt: exp * 1000,
	};
}
