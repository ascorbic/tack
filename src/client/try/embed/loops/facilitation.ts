import { dotVotesMap, placeDot, startVote } from "../../../../shared/dotvotes.ts";
import { type StampEmoji, toggleStamp } from "../../../../shared/facilitation.ts";
import { addSection } from "../../../../shared/structure.ts";
import type { Actor } from "../stage.ts";
import { CAST, type Loop, type LoopContext, jitter, sticky } from "../loop.ts";

// Facilitation: a retro. Priya starts the timer, everyone spends their
// dots on what to improve, and stamps pop on what went well.

const COLUMNS = [
	{
		title: "Went well",
		color: "green",
		notes: [
			["Stacks shipped and people love them", "priya"],
			["Reviews came back within a day", "kai"],
			["The docs search finds things now", "tom"],
		],
	},
	{
		title: "To improve",
		color: "red",
		notes: [
			["Too many pull requests wait on one reviewer", "priya"],
			["We rerun CI three times a day", "jo"],
			["Release notes written the night before", "kai"],
			["Nobody knew who owned the embeds bug", "jo"],
		],
	},
	{
		title: "Ideas",
		color: "yellow",
		notes: [
			["Pair on reviews on Fridays", "tom"],
			["A rota for release notes", "priya"],
			["Demo something every sprint", "kai"],
		],
	},
] as const;

const STICKY_COLOR = { green: "green", red: "pink", yellow: "yellow" } as const;
const SECTION = { w: 440, h: 500, gap: 36 };
const DAY = 86_400_000;

/** Who spends their dots where: the reviewer bottleneck wins. */
const DOTS: [keyof typeof CAST, string][][] = [
	[
		["kai", "Too many pull requests wait on one reviewer"],
		["kai", "We rerun CI three times a day"],
		["kai", "Too many pull requests wait on one reviewer"],
	],
	[
		["tom", "We rerun CI three times a day"],
		["tom", "Too many pull requests wait on one reviewer"],
		["tom", "Release notes written the night before"],
	],
	[
		["jo", "Too many pull requests wait on one reviewer"],
		["jo", "Nobody knew who owned the embeds bug"],
		["jo", "We rerun CI three times a day"],
	],
];

const STAMPS: [keyof typeof CAST, string, StampEmoji][] = [
	["priya", "Stacks shipped and people love them", "🎉"],
	["jo", "Stacks shipped and people love them", "❤️"],
	["tom", "Reviews came back within a day", "👍"],
	["kai", "Pair on reviews on Fridays", "➕"],
	["priya", "Pair on reviews on Fridays", "➕"],
];

export const facilitationLoop: Loop = {
	title: "Facilitation: a retro's timer, dot vote and stamps",
	// Room at the top for the timer and the vote's bar.
	frame: { x: -40, y: -200, w: 1440, h: 900 },
	cards: [],
	cast: ["priya", "kai", "tom", "jo"],
	seed(doc) {
		doc.transact(() => {
			COLUMNS.forEach((column, c) => {
				const x = c * (SECTION.w + SECTION.gap);
				const section = addSection(
					doc,
					{ x, y: 0, w: SECTION.w, h: SECTION.h },
					{ title: column.title, color: column.color },
				);
				column.notes.forEach(([text, author], i) => {
					const at = {
						x: x + 30 + (i % 2) * 200 + jitter(i + c),
						y: 64 + Math.floor(i / 2) * 214 + jitter(i + c + 2, 6),
					};
					sticky(doc, text, STICKY_COLOR[column.color], at, author, section);
				});
				if (column.title === "To improve") {
					startVote(doc, {
						scope: section,
						dots: 3,
						endsAt: new Date(Date.now() + DAY).toISOString(),
						by: CAST.priya,
					});
				}
			});
		});
	},
	async play(context) {
		const { stage, people, services } = context;
		const { d } = stage;
		const { priya } = people;
		people.priya.place({ x: 690, y: 560 });
		people.kai.place({ x: 260, y: 600 });
		people.tom.place({ x: 1120, y: 580 });
		people.jo.place({ x: 900, y: 620 });
		await d.wait(300);

		// Priya starts the timer, from the top of the board.
		await priya.moveTo({ x: 690, y: -70 }, 700);
		priya.press();
		services.facilitator.timer(priya.person, { action: "start", ms: 3 * 60_000, label: "Vote" });
		await d.wait(500);

		// Everyone spends their dots at once.
		const vote = [...dotVotesMap(stage.doc).keys()][0];
		if (!vote) return;
		await Promise.all(
			DOTS.map(async (dots, n) => {
				await d.wait(n * 260);
				for (const [who, text] of dots) await dot(context, people[who], vote, text);
			}),
		);
		await d.wait(300);

		// Stamps on what went well, and an idea.
		for (const [who, text, emoji] of STAMPS) {
			const actor = people[who];
			const id = stage.find(text);
			await actor.moveOnto(id, 0.75, 0.82, 520);
			actor.press();
			actor.edit((doc) => toggleStamp(doc, id, emoji, actor.person.user));
			await d.wait(160);
		}
		// In close, on the dots and the stamps.
		d.also(priya.moveTo({ x: 520, y: 470 }, 1100));
		d.also(people.kai.moveTo({ x: 700, y: 330 }, 1200));
		d.also(people.jo.moveTo({ x: 330, y: 470 }, 1200));
		d.also(people.tom.moveTo({ x: 1150, y: 300 }, 1200));
		await stage.look({ x: -30, y: -175, w: 980, h: 612 }, 1300);
	},
	hold: 2400,
};

/** Head to a sticky and put a dot on it. */
async function dot(
	{ stage }: LoopContext,
	actor: Actor,
	vote: string,
	text: string,
): Promise<void> {
	const id = stage.find(text);
	await actor.moveOnto(id, 0.62, 0.42, 560);
	await stage.d.wait(90);
	actor.press();
	actor.edit((doc) => placeDot(doc, vote, actor.person.user, id));
	await stage.d.wait(160);
}
