// Asking the docs: Cloudflare AI Search's public endpoint for the `tack-docs`
// instance (see "The docs' Ask" in AGENTS.md). Its `/chat/completions` is
// OpenAI's shape, streamed as server-sent events, with one extra event first:
// `event: chunks`, the passages it found, which become the answer's sources.

/** The instance's public endpoint. Only tack.social may call it from a browser. */
export const ASK_ENDPOINT = "https://daee6046-b04a-496d-8927-889dae334388.search.ai.cloudflare.com";

const SITE = "https://tack.social";

export interface Source {
	/** A path on the docs site, with the section's anchor when there is one. */
	url: string;
	title: string;
	section?: string;
}

export type AskEvent = { type: "sources"; sources: Source[] } | { type: "text"; text: string };

export interface Turn {
	question: string;
	answer: string;
}

interface Chunk {
	score?: number;
	text?: string;
	item?: { key?: string; metadata?: { title?: string } };
}

/** Why asking failed, for the person asking. */
export class AskError extends Error {
	constructor(
		readonly reason: "busy" | "failed" | "offline",
		message: string,
	) {
		super(message);
	}
}

/** A passage's section: the heading it starts with, and its anchor on the page. */
function sectionOf(text: string): { section: string; anchor: string } | undefined {
	const match = /^\s*#{2,4}\s+(.+)\n+(?:\[Section titled[^\]]*\]\(#([^)\s]+)\))?/.exec(text);
	if (!match) return undefined;
	const section = match[1]!.trim();
	const anchor =
		match[2] ??
		section
			.toLowerCase()
			.replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
			.replace(/ /g, "-");
	return { section, anchor };
}

/** The pages the passages came from, best first, each once. */
export function sourcesFrom(chunks: readonly Chunk[], limit = 4): Source[] {
	const sources = new Map<string, Source>();
	const ranked = [...chunks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	for (const chunk of ranked) {
		const key = chunk.item?.key;
		if (!key) continue;
		let url: URL;
		try {
			url = new URL(key);
		} catch {
			continue;
		}
		if (url.origin !== SITE || sources.has(url.pathname)) continue;
		const title = chunk.item?.metadata?.title?.trim() || url.pathname;
		const found = sectionOf(chunk.text ?? "");
		sources.set(url.pathname, {
			url: found ? `${url.pathname}#${found.anchor}` : url.pathname,
			title,
			...(found && found.section !== title ? { section: found.section } : {}),
		});
		if (sources.size >= limit) break;
	}
	return [...sources.values()];
}

/**
 * Whether a question plainly leans on the one before it ("Can I rename
 * it?", "And stickies?") rather than standing on its own. A guess: one that
 * doesn't say so ("How many does each person get?") finds no pages on its
 * own, and Ask.astro asks again as a follow-up.
 */
export function followsOn(question: string): boolean {
	const words = question.trim().split(/\s+/);
	return (
		words.length <= 3 ||
		/\b(it|its|it's|that|this|these|those|they|them|their|one|ones|there|same|else|instead|also|too)\b/i.test(
			question,
		)
	);
}

/**
 * What to send. The instance searches on the last message alone, so a
 * follow-up carries the question before it, for the search to find the
 * right pages ("Can I change how many there are?" after "What is dot
 * voting?"). A question that stands on its own is searched for as it is, so
 * the question before doesn't pull in its pages.
 */
export function messagesFor(
	question: string,
	history: readonly Turn[],
	followOn = followsOn(question),
) {
	const earlier = history.slice(-2);
	const messages: { role: "user" | "assistant"; content: string }[] = [];
	for (const turn of earlier) {
		messages.push({ role: "user", content: turn.question });
		if (turn.answer) messages.push({ role: "assistant", content: turn.answer });
	}
	const previous = earlier.at(-1)?.question;
	const content = previous && followOn ? `${previous} Follow-up: ${question}` : question;
	messages.push({ role: "user", content });
	return messages;
}

/** Reads server-sent events: each event's name (if any) and data. */
export async function* events(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }> {
	const reader = body.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	const parse = (block: string) => {
		let event: string | undefined;
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		return data.length ? { event, data: data.join("\n") } : undefined;
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (value) buffer += value.replace(/\r\n?/g, "\n");
			let end: number;
			while ((end = buffer.indexOf("\n\n")) !== -1) {
				const parsed = parse(buffer.slice(0, end));
				buffer = buffer.slice(end + 2);
				if (parsed) yield parsed;
			}
			if (done) break;
		}
		const last = parse(buffer);
		if (last) yield last;
	} finally {
		// Stopped reading early (the answer was dropped): let the stream go.
		reader.cancel().catch(() => {});
	}
}

/** Asks a question; yields the sources as soon as they're found, then the answer as it's written. */
export async function* ask(
	endpoint: string,
	question: string,
	history: readonly Turn[],
	signal?: AbortSignal,
	followOn?: boolean,
): AsyncGenerator<AskEvent> {
	let response: Response;
	try {
		response = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: messagesFor(question, history, followOn), stream: true }),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new AskError("offline", "Couldn't reach the docs' AI.");
	}
	if (response.status === 429) {
		throw new AskError("busy", "Lots of questions at once.");
	}
	if (!response.ok || !response.body) {
		throw new AskError("failed", `The docs' AI answered ${response.status}.`);
	}
	if (!response.headers.get("content-type")?.includes("event-stream")) {
		const json = (await response.json()) as {
			choices?: { message?: { content?: string } }[];
			chunks?: Chunk[];
		};
		yield { type: "sources", sources: sourcesFrom(json.chunks ?? []) };
		yield { type: "text", text: json.choices?.[0]?.message?.content ?? "" };
		return;
	}
	for await (const { event, data } of events(response.body)) {
		if (data === "[DONE]") return;
		let json: unknown;
		try {
			json = JSON.parse(data);
		} catch {
			continue;
		}
		if (event === "chunks") {
			if (Array.isArray(json)) yield { type: "sources", sources: sourcesFrom(json as Chunk[]) };
			continue;
		}
		const parsed = json as {
			error?: unknown;
			choices?: { delta?: { content?: string | null } }[];
		};
		if (parsed.error) throw new AskError("failed", "The docs' AI stopped partway.");
		const text = parsed.choices?.[0]?.delta?.content;
		if (text) yield { type: "text", text };
	}
}
