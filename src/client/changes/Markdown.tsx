import type { ReactNode } from "react";

// Just enough GitHub-flavoured Markdown to preview what a push will write:
// paragraphs, headings, lists and task lists, quotes, code, emphasis, links,
// @mentions and #references. Builds React elements, never HTML strings, so
// nothing in a body can inject markup.

type Block =
	| { type: "p"; text: string }
	| { type: "h"; level: number; text: string }
	| { type: "ul" | "ol"; items: { text: string; task?: boolean; done?: boolean }[] }
	| { type: "quote"; text: string }
	| { type: "code"; text: string; lang: string }
	| { type: "hr" };

function parseBlocks(source: string): Block[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const fence = /^\s*(```|~~~)\s*([\w-]*)/.exec(line);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "```")) {
				body.push(lines[i] ?? "");
				i++;
			}
			i++;
			blocks.push({ type: "code", text: body.join("\n"), lang: fence[2] ?? "" });
			continue;
		}
		if (!line.trim()) {
			i++;
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			blocks.push({ type: "h", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
			i++;
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			blocks.push({ type: "hr" });
			i++;
			continue;
		}
		const bullet = /^\s*([-*+]|\d+[.)])\s+/;
		if (bullet.test(line)) {
			const ordered = /^\s*\d/.test(line);
			const items: { text: string; task?: boolean; done?: boolean }[] = [];
			while (i < lines.length && bullet.test(lines[i] ?? "")) {
				const text = (lines[i] ?? "").replace(bullet, "");
				const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
				items.push(task ? { text: task[2] ?? "", task: true, done: task[1] !== " " } : { text });
				i++;
			}
			blocks.push({ type: ordered ? "ol" : "ul", items });
			continue;
		}
		if (line.startsWith(">")) {
			const quote: string[] = [];
			while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
				quote.push((lines[i] ?? "").replace(/^>\s?/, ""));
				i++;
			}
			blocks.push({ type: "quote", text: quote.join(" ") });
			continue;
		}
		const para: string[] = [];
		while (
			i < lines.length &&
			(lines[i] ?? "").trim() &&
			!/^(#{1,6}\s|>|```|~~~|\s*([-*+]|\d+[.)])\s+)/.test(lines[i] ?? "")
		) {
			para.push((lines[i] ?? "").trim());
			i++;
		}
		blocks.push({ type: "p", text: para.join(" ") });
	}
	return blocks;
}

const INLINE =
	/(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<)]+)|((?<![\w/])@[a-z\d](?:[a-z\d-]{0,38}))|((?<![\w/&])#\d+)/gi;

function safeHref(href: string): string | undefined {
	return /^https?:\/\//i.test(href) ? href : undefined;
}

function inline(text: string, key = ""): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let n = 0;
	for (const match of text.matchAll(INLINE)) {
		const at = match.index ?? 0;
		if (at > last) out.push(text.slice(last, at));
		const [whole, code, strong, em, link, url, mention, ref] = match;
		const k = `${key}${n++}`;
		if (code) out.push(<code key={k}>{code.slice(1, -1)}</code>);
		else if (strong) out.push(<strong key={k}>{inline(strong.slice(2, -2), `${k}.`)}</strong>);
		else if (em) out.push(<em key={k}>{inline(em.slice(1, -1), `${k}.`)}</em>);
		else if (link) {
			const [, label = "", href = ""] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(link) ?? [];
			out.push(
				<a key={k} href={safeHref(href)} target="_blank" rel="noreferrer">
					{inline(label, `${k}.`)}
				</a>,
			);
		} else if (url) {
			out.push(
				<a key={k} href={safeHref(url)} target="_blank" rel="noreferrer">
					{url}
				</a>,
			);
		} else if (mention)
			out.push(
				<span key={k} className="md-mention">
					{mention}
				</span>,
			);
		else if (ref)
			out.push(
				<span key={k} className="md-ref">
					{ref}
				</span>,
			);
		else out.push(whole);
		last = at + whole.length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

/** Render a Markdown body for preview. */
export function Markdown({ source, className }: { source: string; className?: string }) {
	const blocks = parseBlocks(source);
	return (
		<div className={className ? `md ${className}` : "md"}>
			{blocks.map((block, i) => {
				switch (block.type) {
					case "p":
						return <p key={i}>{inline(block.text)}</p>;
					case "h": {
						const Tag = block.level <= 2 ? "h4" : "h5";
						return <Tag key={i}>{inline(block.text)}</Tag>;
					}
					case "ul":
					case "ol": {
						const Tag = block.type;
						return (
							<Tag
								key={i}
								className={block.items.some((item) => item.task) ? "md-tasks" : undefined}
							>
								{block.items.map((item, j) => (
									<li key={j} data-task={item.task || undefined}>
										{item.task && (
											<span className="md-check" data-done={item.done} aria-hidden="true" />
										)}
										{inline(item.text)}
									</li>
								))}
							</Tag>
						);
					}
					case "quote":
						return <blockquote key={i}>{inline(block.text)}</blockquote>;
					case "code":
						return (
							<pre key={i} data-lang={block.lang || undefined}>
								<code>{block.text}</code>
							</pre>
						);
					case "hr":
						return <hr key={i} />;
				}
			})}
		</div>
	);
}

/** Plain text from Markdown, for one-line excerpts. */
export function plainText(source: string, max = 120): string {
	const text = source
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[`*_>#]+/g, "")
		.replace(/^\s*[-+]\s+(\[[ xX]\]\s+)?/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
