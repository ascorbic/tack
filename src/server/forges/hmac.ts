// HMAC-SHA256 webhook signatures, as used by GitHub and Forgejo
// (`X-Hub-Signature-256: sha256=<hex>`).

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
