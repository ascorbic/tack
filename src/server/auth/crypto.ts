// Cryptography for instance secrets, all derived from `TACK_SECRET`: HMAC
// for signed cookies, and AES-GCM for credentials stored in the Instance
// Durable Object. Keys are derived with HKDF, one per purpose, so the same
// secret never keys two different algorithms.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
	const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** A random, URL-safe token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 of a string, base64url-encoded. Used to store session ids. */
export async function sha256(text: string): Promise<string> {
	return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

type Purpose = "cookie" | "encrypt";

const keys = new Map<string, Promise<CryptoKey>>();

function deriveKey(secret: string, purpose: Purpose): Promise<CryptoKey> {
	const id = `${purpose}\0${secret}`;
	let key = keys.get(id);
	if (!key) {
		key = (async () => {
			const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
				"deriveKey",
			]);
			const params = {
				name: "HKDF",
				hash: "SHA-256",
				salt: encoder.encode("tack"),
				info: encoder.encode(`tack/${purpose}/v1`),
			};
			return purpose === "cookie"
				? crypto.subtle.deriveKey(params, material, { name: "HMAC", hash: "SHA-256" }, false, [
						"sign",
						"verify",
					])
				: crypto.subtle.deriveKey(params, material, { name: "AES-GCM", length: 256 }, false, [
						"encrypt",
						"decrypt",
					]);
		})();
		keys.set(id, key);
	}
	return key;
}

/**
 * Encrypt a string. `context` is bound in as additional data, so a value
 * encrypted for one purpose (say, one user's token) can't be swapped in for
 * another.
 */
export async function encrypt(secret: string, plaintext: string, context: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: encoder.encode(context) },
		await deriveKey(secret, "encrypt"),
		encoder.encode(plaintext),
	);
	return `v1.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

/** Decrypt a value from `encrypt`. Throws if it was tampered with. */
export async function decrypt(
	secret: string,
	ciphertext: string,
	context: string,
): Promise<string> {
	const [version, iv, sealed] = ciphertext.split(".");
	if (version !== "v1" || !iv || !sealed) throw new Error("Unrecognised ciphertext");
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64url(iv), additionalData: encoder.encode(context) },
		await deriveKey(secret, "encrypt"),
		fromBase64url(sealed),
	);
	return decoder.decode(plaintext);
}

interface SignedPayload<T> {
	/** What the value is for, so one kind of cookie can't stand in for another. */
	p: string;
	/** Expiry, in seconds since the epoch. */
	e: number;
	d: T;
}

/** Sign a JSON value for a cookie, valid for `maxAge` seconds. */
export async function sign<T>(
	secret: string,
	purpose: string,
	data: T,
	maxAge: number,
): Promise<string> {
	const payload: SignedPayload<T> = {
		p: purpose,
		e: Math.floor(Date.now() / 1000) + maxAge,
		d: data,
	};
	const body = base64url(encoder.encode(JSON.stringify(payload)));
	const mac = await crypto.subtle.sign(
		"HMAC",
		await deriveKey(secret, "cookie"),
		encoder.encode(body),
	);
	return `${body}.${base64url(new Uint8Array(mac))}`;
}

/** Verify a value from `sign`, returning its data, or null if it's invalid or expired. */
export async function unsign<T>(
	secret: string,
	purpose: string,
	value: string | null | undefined,
): Promise<T | null> {
	if (!value) return null;
	const dot = value.indexOf(".");
	if (dot < 0) return null;
	const body = value.slice(0, dot);
	try {
		const valid = await crypto.subtle.verify(
			"HMAC",
			await deriveKey(secret, "cookie"),
			fromBase64url(value.slice(dot + 1)),
			encoder.encode(body),
		);
		if (!valid) return null;
		const payload = JSON.parse(decoder.decode(fromBase64url(body))) as SignedPayload<T>;
		if (payload.p !== purpose || payload.e * 1000 <= Date.now()) return null;
		return payload.d;
	} catch {
		return null;
	}
}
