// A fake Cloudflare Email Service for integration tests (#68): start the
// Worker with `startWorker({ email: mail.fetch })` and it emails through
// this (`TACK_TEST_EMAIL`, see src/server/email.ts) instead. It keeps what
// was sent, and can refuse the next sends with Email Service's codes.

import type { Request as MfRequest, Response as MfResponse } from "miniflare";
import { Response } from "miniflare";

export interface SentEmail {
	from: { email: string; name?: string };
	to: string;
	subject: string;
	text: string;
	html: string;
	headers?: Record<string, string>;
}

export class FakeEmail {
	readonly sent: SentEmail[] = [];
	private failures: { code: string; to?: string }[] = [];

	/** Refuse the next send (to `to`, if given) with this code, e.g. `E_RATE_LIMIT_EXCEEDED`. */
	fail(code: string, to?: string): void {
		this.failures.push({ code, ...(to ? { to } : {}) });
	}

	/** What went to an address, oldest first. */
	to(address: string): SentEmail[] {
		return this.sent.filter((email) => email.to === address);
	}

	/** A link in an email's text: the first that starts with `prefix`. */
	link(email: SentEmail, prefix: string): string {
		const found = email.text.split(/\s+/).find((word) => word.startsWith(prefix));
		if (!found) throw new Error(`No ${prefix} link in “${email.subject}”`);
		return found;
	}

	fetch = async (request: MfRequest): Promise<MfResponse> => {
		const email = (await request.json()) as SentEmail;
		const failure = this.failures.findIndex((f) => !f.to || f.to === email.to);
		if (failure >= 0) {
			const [{ code }] = this.failures.splice(failure, 1) as [{ code: string }];
			return new Response(JSON.stringify({ code, message: `Refused: ${code}` }), { status: 400 });
		}
		this.sent.push(email);
		return new Response(JSON.stringify({ messageId: `<${this.sent.length}@tack.test>` }), {
			headers: { "content-type": "application/json" },
		});
	};
}
