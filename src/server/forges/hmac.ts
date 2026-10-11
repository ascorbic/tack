// HMAC-SHA256 webhook signatures, as used by GitHub
// (`X-Hub-Signature-256: sha256=<hex>`) and Forgejo (bare hex), and GitLab's
// shared secret, compared in constant time.

const encoder = new TextEncoder();

function importKey(secret: string, usage: "sign" | "verify") {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		[usage],
	);
}

export async function verifySignature(
	secret: string,
	body: string,
	signature: string | null,
): Promise<boolean> {
	if (!signature?.startsWith("sha256=")) return false;
	const expected = hexToBytes(signature.slice("sha256=".length));
	if (!expected) return false;
	// subtle.verify compares in constant time.
	return crypto.subtle.verify(
		"HMAC",
		await importKey(secret, "verify"),
		expected,
		encoder.encode(body),
	);
}

/** Forgejo and Gitea sign with the same HMAC, as bare hex (`X-Forgejo-Signature: <hex>`). */
export function verifyHexSignature(
	secret: string,
	body: string,
	signature: string | null,
): Promise<boolean> {
	return verifySignature(secret, body, signature ? `sha256=${signature.trim()}` : null);
}

/**
 * Whether a shared secret sent as is (GitLab's `X-Gitlab-Token`) is the one
 * we hold, compared in constant time: HMAC both and let `verify` compare.
 */
export async function sameSecret(expected: string, given: string | null): Promise<boolean> {
	if (given === null) return false;
	const key = await importKey("tack-compare", "sign");
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(expected));
	return crypto.subtle.verify(
		"HMAC",
		await importKey("tack-compare", "verify"),
		mac,
		encoder.encode(given),
	);
}

export async function sign(secret: string, body: string): Promise<string> {
	const mac = new Uint8Array(
		await crypto.subtle.sign("HMAC", await importKey(secret, "sign"), encoder.encode(body)),
	);
	return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A delivery's fingerprint: the SHA-256 of its signed body (#60). The
 * delivery id header isn't signed, so a replayed body can carry any id it
 * likes; the body can't change without breaking the signature, so this is
 * what deduplication goes by.
 */
export async function digestOf(body: string): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
	return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
	if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
	const bytes = new Uint8Array(32);
	for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}
