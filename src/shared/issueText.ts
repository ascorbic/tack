// A sticky's text as an issue, and back. Its own module so the changes
// model (changes.ts) can read a staged issue from its sticky without
// depending on the actions that stage it.

/** GitHub's limit on issue titles. */
export const TITLE_MAX = 256;

const MARKER = /^(?:#{1,6}\s+|[-*•]\s+|\[[ x]\]\s+)/i;

/**
 * A sticky's text as an issue: the first line is the title (without a
 * leading heading or bullet marker), the rest is the body. A first line too
 * long for a title is cut at a word and kept whole in the body. Null when
 * there's nothing to say.
 */
export function issueFromText(text: string): { title: string; body?: string } | null {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const first = lines.findIndex((line) => line.trim() !== "");
	if (first === -1) return null;
	const line = (lines[first] ?? "").trim().replace(MARKER, "").trim();
	const rest = lines
		.slice(first + 1)
		.join("\n")
		.trim();
	if (line === "") return rest ? issueFromText(rest) : null;
	if (line.length <= TITLE_MAX) return rest ? { title: line, body: rest } : { title: line };
	const cut = line.slice(0, TITLE_MAX - 1);
	const space = cut.lastIndexOf(" ");
	const title = `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
	return { title, body: rest ? `${line}\n\n${rest}` : line };
}

/**
 * A sticky's text for an issue's title and body, so editing either in
 * review writes back to the sticky it's made from: `issueFromText` reads it
 * back as the same title and body.
 */
export function textFromIssue(issue: { title: string; body?: string }): string {
	const title = issue.title.replace(/\s*\n+\s*/g, " ").trim();
	const body = issue.body?.trim();
	return body ? `${title}\n${body}` : title;
}
