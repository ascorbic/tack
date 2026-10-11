// Sending email (#68), for digests: through Cloudflare Email Service's
// `send_email` binding (`TACK_EMAIL`), from the address in
// `TACK_EMAIL_FROM`. Both are opt-in: an instance needs a sending domain
// onboarded first (see the self-hosting docs, "Email"), so without them
// email is simply unavailable and nothing offers it.
//
// Tests have no Email Service: the harness binds `TACK_TEST_EMAIL`, a fake
// that records what's sent and can refuse, never declared in
// cloudflare.config.ts.

import { log } from "./log.ts";

export interface OutgoingEmail {
	to: string;
	subject: string;
	text: string;
	html: string;
	/** `List-Unsubscribe` and the like. Dropped if the service won't take them. */
	headers?: Record<string, string>;
}

export type SendResult =
	| { ok: true; id: string }
	| {
			ok: false;
			/** Email Service's code, e.g. `E_RECIPIENT_SUPPRESSED`, or `error`. */
			code: string;
			/** In words, for the owner. */
			error: string;
			/** Worth trying again later: rate limits and outages. */
			retryable: boolean;
	  };

export interface EmailSender {
	send(message: OutgoingEmail): Promise<SendResult>;
}

interface EmailEnv {
	TACK_EMAIL?: SendEmail;
	TACK_EMAIL_FROM?: string;
	TACK_TEST_EMAIL?: Fetcher;
}

/** Codes worth trying again: the service, or a quota, not the message. */
const RETRYABLE = new Set([
	"E_RATE_LIMIT_EXCEEDED",
	"E_DAILY_LIMIT_EXCEEDED",
	"E_INTERNAL_SERVER_ERROR",
	"error",
]);

const WORDS: Record<string, string> = {
	E_SENDER_NOT_VERIFIED: "The sending address isn’t verified with Cloudflare Email Service.",
	E_SENDER_DOMAIN_NOT_AVAILABLE:
		"The sending domain isn’t onboarded to Cloudflare Email Service yet.",
	E_RECIPIENT_SUPPRESSED: "The address bounced or complained before, so it’s suppressed.",
	E_RECIPIENT_NOT_ALLOWED: "The email binding isn’t allowed to send to that address.",
	E_DELIVERY_FAILED: "The recipient’s mail server refused it.",
	E_RATE_LIMIT_EXCEEDED: "Sending too fast: it’ll try again.",
	E_DAILY_LIMIT_EXCEEDED: "The account’s daily sending limit is used up: it’ll try again.",
	E_INTERNAL_SERVER_ERROR: "Email Service is having trouble: it’ll try again.",
};

/** "Tack <tack@example.com>" or "tack@example.com", as Email Service takes it. */
export function parseFrom(from: string): { email: string; name?: string } | null {
	const trimmed = from.trim();
	const named = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(trimmed);
	if (named?.[2]) {
		const name = named[1]?.replace(/^"|"$/g, "").trim();
		return { email: named[2], ...(name ? { name } : {}) };
	}
	return /^[^\s@<>]+@[^\s@<>]+$/.test(trimmed) ? { email: trimmed } : null;
}

/** Whether this instance can send email: the binding and a sending address. */
export function emailAvailable(env: Env): boolean {
	return emailSender(env) !== null;
}

/** What sends email here, or null when email isn't set up. */
export function emailSender(env: Env): EmailSender | null {
	const e = env as unknown as EmailEnv;
	const from = parseFrom(e.TACK_EMAIL_FROM ?? "");
	if (!from) return null;
	if (e.TACK_TEST_EMAIL) return testSender(e.TACK_TEST_EMAIL, from);
	const binding = e.TACK_EMAIL;
	if (!binding || typeof binding.send !== "function") return null;
	return {
		async send(message) {
			const attempt = (headers?: Record<string, string>) =>
				binding.send({
					from: from.name ? { email: from.email, name: from.name } : from.email,
					to: message.to,
					subject: message.subject,
					text: message.text,
					html: message.html,
					...(headers ? { headers } : {}),
				});
			try {
				const sent = await attempt(message.headers).catch((error: unknown) => {
					// Not every header is allowlisted: send without rather than not at all.
					if (message.headers && codeOf(error).startsWith("E_HEADER")) return attempt();
					throw error;
				});
				return { ok: true, id: sent.messageId };
			} catch (error) {
				return failure(error);
			}
		},
	};
}

function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "error";
}

function failure(error: unknown): SendResult & { ok: false } {
	const code = codeOf(error);
	const message = error instanceof Error ? error.message : String(error);
	if (!WORDS[code]) log.warn("email.error", { code, message });
	return {
		ok: false,
		code,
		error: WORDS[code] ?? `Couldn’t send the email (${message.slice(0, 200)}).`,
		retryable: RETRYABLE.has(code),
	};
}

/** The tests' fake Email Service: a JSON POST per message, answered `{ messageId }` or `{ code, message }`. */
function testSender(fake: Fetcher, from: { email: string; name?: string }): EmailSender {
	return {
		async send(message) {
			try {
				const response = await fake.fetch("http://email.test/send", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ from, ...message }),
				});
				const body = (await response.json()) as {
					messageId?: string;
					code?: string;
					message?: string;
				};
				if (response.ok && body.messageId) return { ok: true, id: body.messageId };
				return failure(Object.assign(new Error(body.message ?? "refused"), { code: body.code }));
			} catch (error) {
				return failure(error);
			}
		},
	};
}
