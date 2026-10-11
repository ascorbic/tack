// A weekly digest as an email (#68): plain text, and HTML that holds up in
// mail clients (tables, inline styles, system fonts, no images or scripts).
// Everything from the board or the forge is escaped; links are only ever
// the board's, the items' own (http(s), from the forge) and unsubscribing.

import {
	type DigestAction,
	type WeeklyDigest,
	describeRange,
	digestHighlights,
	isQuietWeek,
} from "../shared/digests.ts";

export interface DigestEmailLinks {
	/** One click, no sign-in: stops this board's digest for this person. */
	unsubscribe: string;
	/** When it goes out, in words: "Mondays at 9:00 (Europe/London)". */
	schedule: string;
}

const escape = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
	);

/** Only web links, from the forge or this instance, go in an email. */
const safeHref = (url: string) => (/^https?:\/\//i.test(url) ? escape(url) : null);

function actionLine(action: DigestAction, kind: "done" | "opened" | "overdue"): string {
	const owner = action.owner ? ` (@${action.owner})` : "";
	const due =
		kind === "overdue" && action.dueWords
			? `, ${action.dueWords}`
			: kind === "opened" && action.dueWords
				? `, due ${action.dueWords}`
				: "";
	return `${action.text}${owner}${due}`;
}

/** The email's plain-text part. */
export function digestText(digest: WeeklyDigest, links: DigestEmailLinks): string {
	const out: string[] = [];
	out.push(
		`${digest.board.title}: ${describeRange(digest.from, digest.to, digest.timeZone, true)}`,
		"",
	);
	const highlights = digestHighlights(digest);
	if (highlights.length > 0) out.push(highlights.join(" · "), "");
	const section = (title: string, rows: string[]) => {
		if (rows.length === 0) return;
		out.push(title.toUpperCase(), ...rows.map((row) => `- ${row}`), "");
	};
	section(
		"Decisions",
		digest.decisions.map((d) => `${d.title}${d.by ? `, decided by ${d.by}` : ""}`),
	);
	section("Action items", [
		...digest.actions.done.map((a) => `Done: ${actionLine(a, "done")}`),
		...digest.actions.opened
			.filter((a) => !digest.actions.done.some((d) => d.id === a.id))
			.map((a) => `New: ${actionLine(a, "opened")}`),
		...digest.actions.overdue.map((a) => `Overdue: ${actionLine(a, "overdue")}`),
	]);
	section(
		"On GitHub",
		digest.items.map(
			(item) => `${item.ref} ${item.title}: ${item.activity.join(", ")}\n  ${item.url}`,
		),
	);
	section(
		"Pushed from the board",
		digest.pushes.map(
			(push) =>
				`${push.by} pushed ${push.applied + push.failed} changes${push.failed ? ` (${push.failed} failed)` : ""}`,
		),
	);
	section("On the board", [
		...digest.people.map((person) => `${person.name} ${person.summary}`),
		...(digest.moreEdits > 0 ? [`…and ${digest.moreEdits} more changes`] : []),
	]);
	if (isQuietWeek(digest)) out.push("A quiet week: nothing changed.", "");
	out.push(
		`Open the board: ${digest.board.url}`,
		"",
		"--",
		`You asked for this board's weekly digest, sent ${links.schedule}.`,
		`Stop getting it: ${links.unsubscribe}`,
	);
	return out.join("\n");
}

// Colours from the app's light theme (styles.css): ink, quiet ink, lines, accent.
const C = {
	page: "#f4f3ef",
	card: "#ffffff",
	ink: "#17191c",
	quiet: "#5a5f66",
	line: "#e5e4e0",
	accent: "#3b4cca",
	done: "#1f7a3d",
	late: "#c2372b",
	chip: "#f1efea",
};
const FONT =
	"-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'";

/** The email's HTML part. */
export function digestHtml(digest: WeeklyDigest, links: DigestEmailLinks): string {
	const range = escape(describeRange(digest.from, digest.to, digest.timeZone, true));
	const board = escape(digest.board.title);
	const boardUrl = safeHref(digest.board.url) ?? "#";
	const blocks: string[] = [];

	const highlights = digestHighlights(digest);
	if (highlights.length > 0) {
		blocks.push(
			`<p style="margin:0 0 20px">${highlights
				.map(
					(h) =>
						`<span style="display:inline-block;margin:0 6px 6px 0;padding:3px 10px;border-radius:999px;background:${C.chip};color:${C.ink};font-size:13px">${escape(h)}</span>`,
				)
				.join("")}</p>`,
		);
	}

	const section = (title: string, rows: string[]) => {
		if (rows.length === 0) return;
		blocks.push(
			`<h2 style="margin:24px 0 8px;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:${C.quiet}">${escape(title)}</h2>`,
			`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows
				.map(
					(row) =>
						`<tr><td style="padding:8px 0;border-top:1px solid ${C.line};font-size:15px;line-height:1.45;color:${C.ink}">${row}</td></tr>`,
				)
				.join("")}</table>`,
		);
	};
	const mark = (symbol: string, color: string) =>
		`<span style="display:inline-block;width:20px;color:${color};font-weight:600">${symbol}</span>`;
	const quiet = (text: string) => `<span style="color:${C.quiet}">${text}</span>`;
	const ownerOf = (a: DigestAction) => (a.owner ? quiet(` @${escape(a.owner)}`) : "");

	section(
		"Decisions",
		digest.decisions.map(
			(d) =>
				`${mark("◆", C.accent)}<strong>${escape(d.title)}</strong>${d.by ? quiet(`, decided by ${escape(d.by)}`) : ""}`,
		),
	);
	section("Action items", [
		...digest.actions.done.map(
			(a) =>
				`${mark("✓", C.done)}<span style="text-decoration:line-through;color:${C.quiet}">${escape(a.text)}</span>${ownerOf(a)}`,
		),
		...digest.actions.opened
			.filter((a) => !digest.actions.done.some((d) => d.id === a.id))
			.map(
				(a) =>
					`${mark("+", C.accent)}${escape(a.text)}${ownerOf(a)}${a.dueWords ? quiet(`, due ${escape(a.dueWords)}`) : ""}`,
			),
		...digest.actions.overdue.map(
			(a) =>
				`${mark("!", C.late)}${escape(a.text)}${ownerOf(a)}${a.dueWords ? ` <span style="color:${C.late}">${escape(a.dueWords)}</span>` : ""}`,
		),
	]);
	section(
		"On GitHub",
		digest.items.map((item) => {
			const href = safeHref(item.url);
			const title = escape(item.title);
			const name = href
				? `<a href="${href}" style="color:${C.ink};text-decoration:none;font-weight:600">${title}</a>`
				: `<strong>${title}</strong>`;
			return `${name} ${quiet(escape(item.ref))}<br>${quiet(escape(item.activity.join(", ")))}`;
		}),
	);
	section(
		"Pushed from the board",
		digest.pushes.map((push) => {
			const total = push.applied + push.failed;
			const failed = push.failed
				? ` <span style="color:${C.late}">(${push.failed} failed)</span>`
				: "";
			const summaries = push.summaries.length
				? `<br>${quiet(escape(push.summaries.join("; ")))}`
				: "";
			return `<strong>${escape(push.by)}</strong> pushed ${total} change${total === 1 ? "" : "s"}${failed}${summaries}`;
		}),
	);
	section("On the board", [
		...digest.people.map(
			(person) => `<strong>${escape(person.name)}</strong> ${escape(person.summary)}`,
		),
		...(digest.moreEdits > 0 ? [quiet(`…and ${digest.moreEdits} more changes`)] : []),
	]);
	if (isQuietWeek(digest)) {
		blocks.push(`<p style="margin:0;color:${C.quiet}">A quiet week: nothing changed.</p>`);
	}

	const unsubscribe = safeHref(links.unsubscribe) ?? "#";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${board}: ${range}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};font-family:${FONT};color:${C.ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="padding:0 4px 12px;font-size:13px;color:${C.quiet}">📌 Tack · weekly digest</td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:28px 28px 24px">
<h1 style="margin:0 0 4px;font-size:24px;line-height:1.25;font-weight:700"><a href="${boardUrl}" style="color:${C.ink};text-decoration:none">${board}</a></h1>
<p style="margin:0 0 20px;font-size:15px;color:${C.quiet}">${range}</p>
${blocks.join("\n")}
<p style="margin:28px 0 0"><a href="${boardUrl}" style="display:inline-block;padding:10px 18px;border-radius:10px;background:${C.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px">Open the board</a></p>
</td></tr>
<tr><td style="padding:16px 4px;font-size:12px;line-height:1.5;color:${C.quiet}">You asked for this board’s weekly digest, sent ${escape(links.schedule)}. <a href="${unsubscribe}" style="color:${C.quiet}">Stop getting it</a>.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The confirmation email: one link, and what it's for. */
export function confirmationEmail(input: { board: string; confirm: string; schedule: string }): {
	subject: string;
	text: string;
	html: string;
} {
	const board = escape(input.board);
	const href = safeHref(input.confirm) ?? "#";
	return {
		subject: `Confirm the weekly digest of ${input.board}`,
		text: [
			`Someone (hopefully you) asked Tack to email this address the weekly digest of “${input.board}”, ${input.schedule}.`,
			"",
			`Confirm it: ${input.confirm}`,
			"",
			"If it wasn't you, ignore this email: nothing more will be sent.",
		].join("\n"),
		html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Confirm your digest</title></head>
<body style="margin:0;padding:32px 16px;background:${C.page};font-family:${FONT};color:${C.ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${C.card};border:1px solid ${C.line};border-radius:16px">
<tr><td style="padding:28px">
<p style="margin:0 0 12px;font-size:13px;color:${C.quiet}">📌 Tack</p>
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3">Get “${board}” every week?</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.5">Someone (hopefully you) asked Tack to email this address the board’s weekly digest, ${escape(input.schedule)}.</p>
<p style="margin:0 0 20px"><a href="${href}" style="display:inline-block;padding:10px 18px;border-radius:10px;background:${C.accent};color:#ffffff;text-decoration:none;font-weight:600">Confirm my digest</a></p>
<p style="margin:0;font-size:13px;color:${C.quiet}">If it wasn’t you, ignore this email: nothing more will be sent.</p>
</td></tr></table>
</td></tr></table>
</body></html>`,
	};
}
