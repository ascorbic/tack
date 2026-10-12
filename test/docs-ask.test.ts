import { describe, expect, it } from "vite-plus/test";
import { renderMarkdown, safeHref } from "../site/src/ask/markdown.ts";
import { events, followsOn, messagesFor, sourcesFrom } from "../site/src/ask/stream.ts";

// The docs' Ask (site/src/components/Ask.astro): answers from AI Search are
// Markdown set as innerHTML, so nothing the model writes may become markup.
describe("the docs' Ask: rendering answers", () => {
	it("escapes HTML the model writes", () => {
		const html = renderMarkdown('<img src=x onerror="alert(1)"> and <script>alert(1)</script>');
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<script");
		expect(html).toContain("&lt;img");
	});

	it("only links to the web and the docs, with the docs' own links made relative", () => {
		expect(safeHref("javascript:alert(1)")).toBeUndefined();
		expect(safeHref("data:text/html,hi")).toBeUndefined();
		expect(safeHref("//evil.example/")).toBeUndefined();
		expect(safeHref("https://tack.social/boards/stacks/#names")).toBe("/boards/stacks/#names");
		expect(safeHref("/start/tour/")).toBe("/start/tour/");
		const html = renderMarkdown(
			"[Stacks](https://tack.social/boards/stacks/) and [x](javascript:alert(1))",
		);
		expect(html).toContain('<a href="/boards/stacks/">Stacks</a>');
		expect(html).not.toContain("javascript:");
	});

	it("opens other sites in a new tab", () => {
		expect(renderMarkdown("[GitHub](https://github.com/ascorbic/tack)")).toContain(
			'<a href="https://github.com/ascorbic/tack" target="_blank" rel="noopener noreferrer">GitHub</a>',
		);
	});

	it("keeps quotes in a link from breaking out of its attribute", () => {
		const html = renderMarkdown('[x](https://tack.social/"onmouseover="alert(1))');
		expect(html).not.toMatch(/"\s*onmouseover=/);
	});

	it("renders lists, code, emphasis and headings", () => {
		const html = renderMarkdown(
			"You can deploy Tack in two ways:\n### With the button\n1. Choose **Deploy**.\n2. Keep `tack`.\n\n```sh\npnpm run deploy\n```\n- *one*\n- two",
		);
		expect(html).toContain("<p>You can deploy Tack in two ways:</p>");
		expect(html).toContain('<p class="tk-ask-heading"><strong>With the button</strong></p>');
		expect(html).toContain(
			"<ol><li>Choose <strong>Deploy</strong>.</li><li>Keep <code>tack</code>.</li></ol>",
		);
		expect(html).toContain("<pre><code>pnpm run deploy</code></pre>");
		expect(html).toContain("<ul><li><em>one</em></li><li>two</li></ul>");
	});

	it("draws half-written answers without throwing", () => {
		expect(() => renderMarkdown("1. **Deploy\n```sh\npnpm run")).not.toThrow();
		expect(renderMarkdown("```sh\npnpm run")).toContain("<pre><code>pnpm run</code></pre>");
	});
});

describe("the docs' Ask: talking to AI Search", () => {
	it("reads server-sent events, named and not, across chunk boundaries", async () => {
		const text = 'event: chunks\ndata: [{"a":1}]\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < text.length; i += 7)
					controller.enqueue(encoder.encode(text.slice(i, i + 7)));
				controller.close();
			},
		});
		const seen = [];
		for await (const event of events(body)) seen.push(event);
		expect(seen).toEqual([
			{ event: "chunks", data: '[{"a":1}]' },
			{ event: undefined, data: '{"b":2}' },
			{ event: undefined, data: "[DONE]" },
		]);
	});

	it("turns passages into one source per page, best first, linked to its section", () => {
		const sources = sourcesFrom([
			{
				score: 0.5,
				text: "# Stacks\n\nTheming a planning session…",
				item: { key: "https://tack.social/boards/stacks/", metadata: { title: "Stacks" } },
			},
			{
				score: 0.9,
				text: "## Deploy with the button\n\n[Section titled “Deploy with the button”](#deploy-with-the-button)\n\n1. …",
				item: {
					key: "https://tack.social/self-hosting/deploy/",
					metadata: { title: "Deploy Tack" },
				},
			},
			{
				score: 0.8,
				text: "## Previews\n\nmore",
				item: {
					key: "https://tack.social/self-hosting/deploy/",
					metadata: { title: "Deploy Tack" },
				},
			},
			{
				score: 1,
				text: "elsewhere",
				item: { key: "https://evil.example/", metadata: { title: "Nope" } },
			},
		]);
		expect(sources).toEqual([
			{
				url: "/self-hosting/deploy/#deploy-with-the-button",
				title: "Deploy Tack",
				section: "Deploy with the button",
			},
			{ url: "/boards/stacks/", title: "Stacks" },
		]);
	});

	it("carries the question before into a follow-up's search, and not into a new question", () => {
		const history = [{ question: "What is dot voting?", answer: "Dots to vote with." }];
		expect(followsOn("How many does each person get?")).toBe(false);
		expect(followsOn("Can I rename it?")).toBe(true);
		expect(followsOn("And stickies?")).toBe(true);
		expect(messagesFor("Can I change how many there are?", history).at(-1)?.content).toBe(
			"What is dot voting? Follow-up: Can I change how many there are?",
		);
		expect(messagesFor("How do I deploy Tack?", history).at(-1)?.content).toBe(
			"How do I deploy Tack?",
		);
		expect(messagesFor("How do I deploy Tack?", history)).toHaveLength(3);
	});
});
