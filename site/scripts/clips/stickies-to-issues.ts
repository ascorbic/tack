// Stickies to issues: six ideas boxed with a marquee, "Make 6 issues" on
// the bar, and each sticky turning into its issue's card. The camera leans
// in on the bar's button for the click, then frames the stickies for the
// rest: their "New issue in unpic" tags, then the cards landing one by
// one, and last it eases in on the top two cards to read them. The issues' panel and the push happen out of sight, through the
// app's own code: nothing but the bar's button is ever on screen.

import type { Page } from "@playwright/test";
import { type Keyframe, around, closeOn } from "./camera.ts";
import type { Recorder, Recording } from "./capture.ts";
import type { Clip } from "./clip.ts";

const NOTES: { text: string; color: string; author: string }[] = [
	{ text: "Blurhash placeholders for every provider", color: "yellow", author: "priya" },
	{ text: "A provider playground", color: "pink", author: "kai" },
	{ text: "Codemods for 5.0", color: "blue", author: "tom" },
	{ text: "Detect the CDN from custom domains", color: "green", author: "kai" },
	{ text: "One docs page per provider", color: "purple", author: "priya" },
	{ text: "Benchmarks in CI", color: "yellow", author: "tom" },
];

type AppImport = <T>(path: string) => Promise<T>;
type Shapes = typeof import("../../../src/shared/shapes.ts");
type Push = typeof import("../../../src/client/play/push.ts");
type Changes = typeof import("../../../src/shared/changes.ts");

/**
 * The issues' panel opens when the bar's button is clicked, but never
 * shows: it's staged from out of sight. Nor do the selection's own tools
 * (arrange, colour) or the toasts: the bar's button and the stickies' tags
 * tell the story.
 */
const HIDE = `
	[role="dialog"][aria-label="Make issues from stickies"] { opacity: 0 !important; pointer-events: none !important; }
	[aria-label="Arrange selection"], .shape-toolbar-clamp, .toasts { display: none !important; }
`;

/**
 * How slowly the pretend forge answers, as a multiple of its usual: slow
 * enough that the cards land one after another, about a third of a second apart.
 */
const PACE = 0.5;

async function seed(page: Page): Promise<void> {
	await page.addStyleTag({ content: HIDE });
	await page.evaluate(async (notes) => {
		const { tackPlayground, tackPush, clipImport } = window as unknown as {
			tackPlayground: { doc: import("yjs").Doc };
			tackPush: { pace: number };
			clipImport: AppImport;
		};
		const { addShape, nextZ } = await clipImport<Shapes>("/src/shared/shapes.ts");
		const { numberFrom } = await clipImport<Push>("/src/client/play/push.ts");
		const doc = tackPlayground.doc;
		const people: Record<string, { name: string; color: string }> = {
			priya: { name: "Priya Shah", color: "#b4467a" },
			kai: { name: "Kai Andersen", color: "#1f7a6b" },
			tom: { name: "Tom Okafor", color: "#a35a12" },
		};
		// Where the issues go: the repository you made issues in last.
		localStorage.setItem("tack.recentRepos", JSON.stringify(["fake.tack/acme/unpic"]));
		numberFrom(431);
		tackPush.pace = 1;
		doc.transact(() => {
			addShape(doc, "clip-title", {
				type: "text",
				text: "Stickies to issues",
				size: "l",
				x: 0,
				y: -86,
				z: nextZ(doc),
			});
			notes.forEach((note, i) => {
				addShape(doc, `clip-sticky-${i}`, {
					type: "sticky",
					text: note.text,
					color: note.color,
					author: people[note.author],
					// Two columns, far enough apart for the cards they'll become, with a gap
					// between them that the camera's last close-up can sit in.
					x: (i % 2) * 340 + ((i * 37) % 9) - 4,
					y: Math.floor(i / 2) * 212 + ((i * 53) % 9) - 4,
					z: nextZ(doc),
				});
			});
		});
	}, NOTES);
}

/** Push every staged change, as the push sheet's "Push 6 changes" does, without the sheet. */
async function push(page: Page, pace: number): Promise<void> {
	await page.evaluate(async (pace) => {
		const { tackPlayground, tackPush, clipImport } = window as unknown as {
			tackPlayground: { doc: import("yjs").Doc };
			tackPush: {
				pace: number;
				push(request: { ids: string[]; as: "user" | "app" }): Promise<unknown>;
			};
			clipImport: AppImport;
		};
		const { listChanges } = await clipImport<Changes>("/src/shared/changes.ts");
		const ids = listChanges(tackPlayground.doc)
			.filter((change) => change.status === "staged")
			.map((change) => change.id);
		// An even rhythm, and no long wait for the first card: the pretend forge's
		// jittered waits are its first answer's and each confirmation's shortest,
		// and each send's longest (they're asked for in that order, alternating).
		let asked = 0;
		Math.random = () => {
			const n = asked++;
			return n > 0 && n % 2 === 1 ? 1 : 0;
		};
		tackPush.pace = pace;
		void tackPush.push({ ids, as: "user" });
	}, pace);
}

async function play(rec: Recorder): Promise<void> {
	const { page } = rec;
	const stickies = page.locator(".react-flow__node-sticky");
	const first = await rec.box("first", stickies.first());
	const last = await rec.box("last", stickies.last());
	for (let i = 0; i < (await stickies.count()); i++) await rec.box(`sticky-${i}`, stickies.nth(i));
	await rec.box("title", page.locator(".react-flow__node-text").first());
	// Resting by the first sticky's corner, ready to box them; after, clear of the cards they become.
	const home = { x: last.x + 252 + 60, y: last.y + last.h / 2 };
	await rec.place({ x: first.x - 26, y: first.y - 22 });

	// The board, still, as the pointer fades in.
	await rec.appear();
	await rec.wait(0.8);

	// Box the six stickies, slowly.
	await rec.drag({ x: last.x + last.w + 18, y: last.y + last.h + 18 }, 1.3);
	const make = page.getByRole("button", { name: "Make issues from stickies" });
	await rec.until(make);
	rec.mark("selected");
	await rec.box("make", make);

	// The camera leans in on the bar while the pointer heads for its button.
	// The real mouse jumps there at the end, hovering nothing on the way.
	await rec.wait(0.1);
	await rec.moveTo(await rec.centre(make, { x: -14 }), 1.0, { follow: false });
	await rec.wait(0.4);
	rec.mark("click");
	await rec.click();

	// Back out to the stickies, the pointer back to rest; then they're staged.
	await rec.moveTo(home, 1.0, { follow: false });
	const panel = page.getByRole("dialog", { name: "Make issues from stickies" });
	const stage = panel.getByRole("button", { name: /^Stage \d+ issues/ });
	// Once the camera's back, and the panel knows the repository.
	const back = (rec.marks.click ?? 0) + 1.3;
	while (rec.t < back || !(await stage.isEnabled())) await rec.tick();
	rec.mark("staging");
	await stage.evaluate((button: HTMLButtonElement) => button.click());
	await page.keyboard.press("Escape");
	await rec.until(
		page
			.locator(".react-flow__node-sticky")
			.getByText(/New issue in unpic/)
			.first(),
	);
	rec.mark("staged");
	await rec.wait(1.8);

	// Pushed, out of sight: the stickies make room, and become their cards one by one.
	await push(page, PACE);
	rec.mark("pushed");
	const cards = page.locator(".react-flow__node-card");
	for (let n = 1; n <= NOTES.length; n++) {
		while ((await cards.count()) < n) await rec.tick();
		rec.mark(`card-${n}`);
	}
	rec.mark("landed");
	// Until the last card's settled; then the camera eases in on the top two, the pointer fading as
	// it goes, and holds on them.
	await rec.wait(0.35);
	for (let i = 0; i < NOTES.length; i++) await rec.box(`card-${i}`, cards.nth(i));
	rec.mark("read");
	await rec.wait(0.3);
	await rec.vanish();
	await rec.wait(0.5);
	await rec.wait(1.8);
	rec.mark("end");
	// Still, while it fades back to the first frame.
	await rec.wait(1.0);
}

/** Stickies and cards framed from the start; in on the bar for the click, and back; in on two cards at the end. */
function camera({ marks, boxes }: Recording): Keyframe[] {
	const m = (name: string) => marks[name] ?? 0;
	const all = Object.entries(boxes)
		.filter(([name]) => /^(sticky|card)-\d+$|^title$/.test(name))
		.map(([, box]) => box);
	const board = around(all, { margin: 36, max: 2 });
	// The button, with the stickies it's for just above it.
	const make = boxes.make!;
	const bar = closeOn({ x: make.x + make.w / 2 + 110, y: make.y + make.h / 2 - 70 }, 1.9);
	// The left column's first two cards, big enough to read on a phone: clear of the title above,
	// the column beside them and the row below.
	const top = boxes["card-0"]!;
	const below = boxes["card-2"]!;
	const w = below.y + below.h - top.y + 48;
	const read = {
		x: (Math.min(top.x, below.x) + Math.max(top.x + top.w, below.x + below.w)) / 2 - w / 2,
		y: (top.y + below.y + below.h) / 2 - w / 2 + 6,
		w,
	};
	return [
		{ t: 0, ...board },
		{ t: m("selected") + 0.05, ...board },
		{ t: m("selected") + 1.15, ...bar },
		{ t: m("click") + 0.25, ...bar },
		{ t: m("click") + 1.25, ...board },
		{ t: m("read"), ...board },
		{ t: m("read") + 1.1, ...read },
	];
}

export const clip: Clip = {
	name: "stickies-to-issues",
	setup: {
		url: "/play?scenario=empty",
		title: "Stickies to issues",
		you: { name: "Jo Rivera", color: "#5b5fc7" },
		retext: [[/the test forge/gi, "GitHub"]],
	},
	seed,
	// A little zoomed out, leaving room for the cards they'll become, and the bar below them.
	async framed(page) {
		await page.keyboard.press("Shift+Digit0");
		await page.waitForTimeout(400);
		await page.keyboard.press("Minus");
	},
	play,
	camera,
};
