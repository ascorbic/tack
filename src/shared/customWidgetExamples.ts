import type { CustomConfig } from "./customWidgets.ts";

// Starting points for custom widgets (#66): the gallery in the widget's
// editor, and the picker. Each is a working widget over the board's busiest
// repository, short enough to read in one go, written against the sandbox's
// API (`tack.search`, `tack.cards`, `tack.avatar`, `tack.config`,
// `tack.onUpdate`) and its stylesheet's tokens (`var(--ink)` and friends).

export interface CustomExample {
	id: string;
	title: string;
	/** One line for the gallery. */
	description: string;
	code: string;
	/** Its settings for a board, filled in with the board's busiest repository (`owner/name`). */
	settings(repo: string | null): Record<string, unknown>;
}

const burndown = `// Burndown: what's still open in a milestone, day by day, from when
// each item was opened and closed. Settings: { "repo", "milestone" }.
const { repo, milestone } = tack.config;
const DAY = 86_400_000;
const NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, ns) {
  const node = ns ? document.createElementNS(ns, name) : document.createElement(name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function say(message) {
  const p = el("p", { class: "empty" });
  p.textContent = message;
  document.body.replaceChildren(p);
}

async function draw() {
  if (!repo || !milestone) return say("Name a repo and a milestone in this widget’s settings.");
  let result;
  try {
    result = await tack.search(\`repo:\${repo} milestone:"\${milestone}"\`, { limit: 100 });
  } catch (error) {
    return say(error.message);
  }
  const items = result.items.filter((item) => item.createdAt);
  if (items.length === 0) return say(\`Nothing in \${milestone} yet.\`);

  const now = Date.now();
  const start = Math.min(...items.map((item) => Date.parse(item.createdAt)));
  const dueOn = items.find((item) => item.milestone?.dueOn)?.milestone.dueOn;
  const due = dueOn ? Date.parse(dueOn) : null;
  const end = Math.max(now, due ?? now);
  const openAt = (t) =>
    items.filter(
      (item) =>
        Date.parse(item.createdAt) <= t && (!item.closedAt || Date.parse(item.closedAt) > t),
    ).length;
  const points = [];
  for (let t = start; t < now; t += DAY) points.push([t, openAt(t)]);
  points.push([now, openAt(now)]);

  const W = 360, H = 150, top = Math.max(...points.map(([, n]) => n), 1);
  const x = (t) => ((t - start) / Math.max(end - start, DAY)) * W;
  const y = (n) => H - (n / top) * (H - 8);
  const line = points.map(([t, n], i) => \`\${i ? "L" : "M"}\${x(t).toFixed(1)},\${y(n).toFixed(1)}\`).join("");

  const svg = el("svg", { viewBox: \`0 0 \${W} \${H}\`, preserveAspectRatio: "none", class: "chart" }, NS);
  svg.append(
    el("path", { d: \`\${line}L\${x(now)},\${H}L0,\${H}Z\`, fill: "var(--accent-soft)" }, NS),
    el("path", { d: line, fill: "none", stroke: "var(--chart-done)", "stroke-width": 2, "vector-effect": "non-scaling-stroke", class: "draw" }, NS),
  );
  if (due) {
    svg.append(el("path", { d: \`M0,\${y(points[0][1])}L\${x(due)},\${H}\`, stroke: "var(--muted)", "stroke-dasharray": "4 4", "vector-effect": "non-scaling-stroke" }, NS));
  }

  const left = openAt(now);
  const head = el("div", { class: "head" });
  const big = el("strong");
  big.textContent = left;
  const words = el("span", { class: "muted" });
  words.textContent = \` of \${items.length} still open in \${milestone}\${dueOn ? \`, due \${new Date(dueOn).toLocaleDateString(undefined, { month: "short", day: "numeric" })}\` : ""}\`;
  head.append(big, words);
  const style = el("style");
  style.textContent = \`
    .head { margin-bottom: 10px }
    .head strong { font-size: 28px; font-weight: 650; letter-spacing: -0.02em }
    .chart { width: 100%; height: calc(100vh - 80px); min-height: 90px; overflow: visible }
    .draw { stroke-dasharray: 2000; stroke-dashoffset: 2000; animation: draw calc(900ms * var(--motion)) ease-out forwards }
    @keyframes draw { to { stroke-dashoffset: 0 } }\`;
  document.body.replaceChildren(style, head, svg);
}

tack.onUpdate(draw);
draw();
`;

const labelCloud = `// Label cloud: the labels on whatever a search finds, sized by how
// often each turns up. Settings: { "query" }.
const { query } = tack.config;

function say(message) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = message;
  document.body.replaceChildren(p);
}

// Dark text on light labels, light text on dark ones.
function inkFor(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? "#17191c" : "#ffffff";
}

async function draw() {
  if (!query) return say("Write a search in this widget’s settings.");
  let result;
  try {
    result = await tack.search(query, { limit: 100 });
  } catch (error) {
    return say(error.message);
  }
  const counts = new Map();
  for (const item of result.items) {
    for (const label of item.labels) {
      const seen = counts.get(label.name) ?? { ...label, n: 0 };
      seen.n++;
      counts.set(label.name, seen);
    }
  }
  if (counts.size === 0) return say("No labels on anything this finds.");
  const labels = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 40);
  const most = labels[0].n;
  const cloud = document.createElement("div");
  cloud.className = "cloud";
  labels
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((label, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = label.name;
      chip.title = \`\${label.n} of \${result.items.length}\`;
      chip.style.fontSize = \`\${12 + Math.round((label.n / most) * 14)}px\`;
      chip.style.background = \`#\${label.color}\`;
      chip.style.color = inkFor(label.color);
      chip.style.animationDelay = \`calc(\${i * 25}ms * var(--motion))\`;
      cloud.append(chip);
    });
  const style = document.createElement("style");
  style.textContent = \`
    .cloud { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; justify-content: center; min-height: 100%; align-content: center }
    .chip { padding: 0.15em 0.6em; border-radius: 999px; font-weight: 550; line-height: 1.4; animation: pop calc(380ms * var(--motion)) cubic-bezier(0.3, 1.4, 0.5, 1) backwards }
    @keyframes pop { from { opacity: 0; scale: 0.6 } }\`;
  document.body.replaceChildren(style, cloud);
}

tack.onUpdate(draw);
draw();
`;

const contributors = `// Contributors: who opened the pull requests a search finds, most first,
// with their faces. Settings: { "query", "limit" }.
const { query, limit = 12 } = tack.config;

function say(message) {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = message;
  document.body.replaceChildren(p);
}

async function draw() {
  if (!query) return say("Write a search in this widget’s settings.");
  let result;
  try {
    result = await tack.search(query, { limit: 100, sort: "updated" });
  } catch (error) {
    return say(error.message);
  }
  const people = new Map();
  for (const item of result.items) {
    if (!item.author) continue;
    const person = people.get(item.author.login) ?? { ...item.author, n: 0 };
    person.n++;
    people.set(item.author.login, person);
  }
  if (people.size === 0) return say("Nobody yet.");
  const ranked = [...people.values()].sort((a, b) => b.n - a.n).slice(0, limit);
  const list = document.createElement("ol");
  for (const [i, person] of ranked.entries()) {
    const row = document.createElement("li");
    row.style.animationDelay = \`calc(\${i * 40}ms * var(--motion))\`;
    const face = document.createElement("img");
    face.alt = "";
    tack.avatar(person.avatarUrl, 48).then((src) => (face.src = src), () => {});
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = person.login;
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.style.setProperty("--share", person.n / ranked[0].n);
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = person.n;
    row.append(face, name, bar, count);
    list.append(row);
  }
  const style = document.createElement("style");
  style.textContent = \`
    ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px }
    li { display: grid; grid-template-columns: 24px 9em 1fr 2.5em; gap: 8px; align-items: center; animation: in calc(320ms * var(--motion)) ease-out backwards }
    img { width: 24px; height: 24px; border-radius: 50%; background: var(--skeleton) }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550 }
    .bar { height: 8px; border-radius: 4px; background: var(--accent); width: calc(var(--share) * 100%); transform-origin: left; animation: grow calc(600ms * var(--motion)) cubic-bezier(0.2, 0.8, 0.2, 1) backwards }
    .count { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted) }
    @keyframes in { from { opacity: 0; translate: 0 4px } }
    @keyframes grow { from { scale: 0 1 } }\`;
  document.body.replaceChildren(style, list);
}

tack.onUpdate(draw);
draw();
`;

export const CUSTOM_EXAMPLES: CustomExample[] = [
	{
		id: "burndown",
		title: "Burndown",
		description: "What’s still open in a milestone, day by day.",
		code: burndown,
		settings: (repo) => ({ repo: repo ?? "", milestone: "" }),
	},
	{
		id: "labels",
		title: "Label cloud",
		description: "The labels on whatever a search finds, sized by count.",
		code: labelCloud,
		settings: (repo) => ({ query: repo ? `repo:${repo} is:open` : "" }),
	},
	{
		id: "contributors",
		title: "Contributors",
		description: "Who opened the merged pull requests, most first.",
		code: contributors,
		settings: (repo) => ({ query: repo ? `repo:${repo} is:pr is:merged` : "", limit: 12 }),
	},
];

/** A custom widget's config from an example, for a board. */
export function exampleConfig(example: CustomExample, repo: string | null): CustomConfig {
	return {
		title: example.title,
		code: example.code,
		data: JSON.stringify(example.settings(repo), null, 2),
	};
}
