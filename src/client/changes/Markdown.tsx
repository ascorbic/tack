import { type ReactNode, useState } from "react";
import { type Inline, parseInline } from "./inline.ts";

// Just enough GitHub-flavoured Markdown to preview what a push will write:
// paragraphs, headings, lists and task lists, quotes, code, and inline
// Markdown (inline.ts: emphasis, links, images and linked images, @mentions
// and #references). Builds React elements, never HTML strings, so nothing in
// a body can inject markup.

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

/**
 * An image, loaded only from http(s), without telling its host where it was
 * shown. One that can't be shown (an unsafe URL, or it fails to load) is its
 * alt text in a quiet frame, rather than a broken-image icon.
 */
function MdImage({ src, alt, title }: { src?: string; alt: string; title?: string }) {
	const [failed, setFailed] = useState(false);
	if (!src || failed) {
		return (
			<span className="md-image-missing" title={title}>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<rect x="2" y="3" width="12" height="10" rx="2" />
					<path d="m4.5 11 2.5-3 2 2.2 1.5-1.7 1.5 2.5" />
				</svg>
				{alt || "Image"}
			</span>
		);
	}
	return (
		<img
			className="md-image"
			src={src}
			alt={alt}
			title={title}
			loading="lazy"
			decoding="async"
			referrerPolicy="no-referrer"
			onError={() => setFailed(true)}
		/>
	);
}

function render(nodes: readonly Inline[], key = ""): ReactNode[] {
	return nodes.map((node, i) => {
		const k = `${key}${i}`;
		switch (node.type) {
			case "text":
				return node.text;
			case "code":
				return <code key={k}>{node.text}</code>;
			case "strong":
				return <strong key={k}>{render(node.children, `${k}.`)}</strong>;
			case "em":
				return <em key={k}>{render(node.children, `${k}.`)}</em>;
			case "link":
				return (
					<a
						key={k}
						href={node.href}
						title={node.title}
						target="_blank"
						rel="noreferrer"
						data-image={node.children.every((c) => c.type === "image") || undefined}
					>
						{render(node.children, `${k}.`)}
					</a>
				);
			case "image":
				return <MdImage key={k} src={node.src} alt={node.alt} title={node.title} />;
			case "mention":
				return (
					<span key={k} className="md-mention">
						{node.text}
					</span>
				);
			case "ref":
				return (
					<span key={k} className="md-ref">
						{node.text}
					</span>
				);
		}
	});
}

function inline(text: string): ReactNode[] {
	return render(parseInline(text));
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
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_>#]+/g, "")
		.replace(/^\s*[-+]\s+(\[[ xX]\]\s+)?/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
