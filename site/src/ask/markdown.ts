// A small Markdown renderer for the docs' Ask answers: the model writes
// Markdown, and this turns it into HTML that's safe to set as innerHTML.
// Everything is escaped first; the only tags are the ones made here, and the
// only links are to http(s) addresses or paths (the docs' own, made relative
// so they work on any host). It renders half-written Markdown too, since an
// answer is drawn again as each word streams in.

const SITE = "https://tack.social";

export function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function unescapeHtml(text: string): string {
	return text
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&");
}

/** A link's address, if it may be one: the docs' pages as paths, other sites as they are. */
export function safeHref(raw: string): string | undefined {
	const href = raw.trim();
	if (href.startsWith("#") || (href.startsWith("/") && !href.startsWith("//"))) return href;
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	if (url.origin === SITE) return `${url.pathname}${url.search}${url.hash}`;
	return url.href;
}

function link(text: string, rawHref: string): string {
	const href = safeHref(unescapeHtml(rawHref));
	if (!href) return text;
	const external = !href.startsWith("/") && !href.startsWith("#");
	const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
	return `<a href="${escapeHtml(href)}"${attrs}>${text}</a>`;
}

/** One line's inline Markdown: code, links, bold and italics. */
export function inline(text: string): string {
	return text
		.split(/(`[^`]*`)/)
		.map((part, i) => {
			if (i % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
			return escapeHtml(part)
				.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label, href) =>
					link(label, href),
				)
				.replace(
					/(^|[\s(])(https:\/\/[^\s<)]+[^\s<).,;:!?])/g,
					(_, before, href) => `${before}${link(href, href)}`,
				)
				.replace(/\*\*(?=\S)(.+?)\*\*/g, "<strong>$1</strong>")
				.replace(/__(?=\S)(.+?)__/g, "<strong>$1</strong>")
				.replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?!\*)/g, "$1<em>$2</em>");
		})
		.join("");
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*(\d+)[.)]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => inline(cell.trim()));
}

/** A whole answer, as HTML. */
export function renderMarkdown(source: string): string {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let paragraph: string[] = [];
	let list: { tag: "ul" | "ol"; start: number; items: string[] } | undefined;

	const flushParagraph = () => {
		if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
		paragraph = [];
	};
	const flushList = () => {
		if (!list) return;
		const start = list.tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
		out.push(
			`<${list.tag}${start}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`,
		);
		list = undefined;
	};
	const flush = () => {
		flushParagraph();
		flushList();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (FENCE.test(line)) {
			flush();
			const fence = line.trim().slice(0, 3);
			const code: string[] = [];
			while (++i < lines.length && !lines[i]!.trim().startsWith(fence)) code.push(lines[i]!);
			out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			out.push(`<p class="tk-ask-heading"><strong>${inline(heading[1]!)}</strong></p>`);
			continue;
		}
		const next = lines[i + 1];
		if (line.includes("|") && next !== undefined && TABLE_RULE.test(next)) {
			flush();
			const head = cells(line);
			const rows: string[][] = [];
			i++;
			while (i + 1 < lines.length && lines[i + 1]!.includes("|") && lines[i + 1]!.trim()) {
				rows.push(cells(lines[++i]!));
			}
			out.push(
				`<table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead>` +
					`<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
			);
			continue;
		}
		const quote = QUOTE.exec(line);
		if (quote) {
			flush();
			out.push(`<blockquote><p>${inline(quote[1]!)}</p></blockquote>`);
			continue;
		}
		const bullet = BULLET.exec(line);
		const number = bullet ? undefined : NUMBER.exec(line);
		if (bullet || number) {
			flushParagraph();
			const tag = bullet ? "ul" : "ol";
			if (list && list.tag !== tag) flushList();
			list ??= { tag, start: number ? Number(number[1]) : 1, items: [] };
			list.items.push(bullet ? bullet[1]! : number![2]!);
			continue;
		}
		// An indented line under a list item carries on that item.
		if (list && /^\s{2,}\S/.test(line)) {
			list.items[list.items.length - 1] += ` ${line.trim()}`;
			continue;
		}
		flushList();
		paragraph.push(line.trim());
	}
	flush();
	return out.join("");
}
