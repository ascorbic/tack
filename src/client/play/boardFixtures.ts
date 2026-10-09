import type { Me, Person } from "../../shared/auth.ts";
import type {
	BoardInfo,
	BoardList,
	BoardMember,
	Thumbnail,
	ThumbnailShape,
	Visibility,
} from "../../shared/boards.ts";
import { THUMBNAIL_SIZE, slugify } from "../../shared/boards.ts";

// Boards for the boards gallery (`/play/boards`): people, sketches, and
// home pages from empty to busy. Deterministic, so screenshots are stable.

export const NOW = Date.UTC(2026, 9, 9, 15, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const OCTOCAT: Person = { id: 583231, login: "octocat", name: "The Octocat", avatarUrl: "" };
export const PRIYA: Person = { id: 4021, login: "priya-s", name: "Priya Shah", avatarUrl: "" };
export const KAI: Person = { id: 4022, login: "kai-a", name: "Kai Andersen", avatarUrl: "" };
export const TOM: Person = { id: 4023, login: "tomo", name: "Tom Okafor", avatarUrl: "" };
export const JO: Person = { id: 4024, login: "jo-rivera", name: "Jo Rivera", avatarUrl: "" };

export const ME_SIGNED_IN: Me = {
	viewer: OCTOCAT,
	admin: false,
	allowed: true,
	signIn: "ready",
	devAuth: false,
};
export const ME_SIGNED_OUT: Me = { ...ME_SIGNED_IN, viewer: null, allowed: false };
export const ME_GUEST: Me = {
	...ME_SIGNED_IN,
	viewer: null,
	allowed: true,
	signIn: "unconfigured",
};

/** A small seeded random number generator (mulberry32). */
function random(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const COLORS = ["yellow", "pink", "blue", "green", "purple"];
const STATES = ["open", "open", "open", "merged", "closed", "draft"];

type Layout = "planning" | "brainstorm" | "triage" | "retro" | "sparse";

/** A plausible board sketch, laid out like the real thing would be. */
export function sketch(layout: Layout, seed = 1): Thumbnail {
	const rand = random(seed);
	const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)] as T;
	const shapes: ThumbnailShape[] = [];
	const card = (x: number, y: number) => shapes.push(["card", x, y, 252, 128, pick(STATES)]);
	const sticky = (x: number, y: number, color = pick(COLORS)) =>
		shapes.push(["sticky", x, y, 176, 176, color]);

	switch (layout) {
		case "planning":
			for (let column = 0; column < 3; column++) {
				const x = column * 340;
				shapes.push(["frame", x, 0, 300, 760, ["blue", "orange", "green"][column] ?? "grey"]);
				shapes.push(["text", x + 20, 20, 160, 44, "1"]);
				const count = 3 + Math.floor(rand() * 2);
				for (let i = 0; i < count; i++) {
					if (rand() < 0.7) card(x + 24, 90 + i * 150);
					else sticky(x + 62, 90 + i * 150);
				}
			}
			break;
		case "brainstorm":
			for (let i = 0; i < 22; i++) {
				const angle = rand() * Math.PI * 2;
				const radius = 120 + rand() * 520;
				sticky(600 + Math.cos(angle) * radius, 400 + Math.sin(angle) * radius * 0.6);
			}
			shapes.push(["text", 470, 360, 360, 70, "1"]);
			break;
		case "triage":
			for (let i = 0; i < 16; i++) card((i % 4) * 280, Math.floor(i / 4) * 160);
			break;
		case "retro":
			["green", "pink", "blue"].forEach((color, column) => {
				shapes.push(["text", column * 420, 0, 220, 44, "1"]);
				for (let i = 0; i < 2 + Math.floor(rand() * 3); i++) {
					sticky(column * 420 + (i % 2) * 196, 70 + Math.floor(i / 2) * 196, color);
				}
			});
			break;
		case "sparse":
			sticky(0, 0, "yellow");
			card(240, 60);
			shapes.push(["text", 0, 220, 300, 80, "2"]);
			break;
	}
	return normalise(shapes);
}

function normalise(shapes: ThumbnailShape[]): Thumbnail {
	const minX = Math.min(...shapes.map((s) => s[1]));
	const minY = Math.min(...shapes.map((s) => s[2]));
	const maxX = Math.max(...shapes.map((s) => s[1] + s[3]));
	const maxY = Math.max(...shapes.map((s) => s[2] + s[4]));
	const scale = THUMBNAIL_SIZE / Math.max(maxX - minX, maxY - minY);
	const at = (n: number) => Math.round(n * scale);
	return {
		width: at(maxX - minX),
		height: at(maxY - minY),
		shapes: shapes
			.sort((a, b) => Number(b[0] === "frame") - Number(a[0] === "frame"))
			.map(([kind, x, y, w, h, tone]) => [kind, at(x - minX), at(y - minY), at(w), at(h), tone]),
	};
}

let next = 0;

export function board(
	title: string,
	options: Partial<BoardInfo> & { layout?: Layout | null; ago?: number } = {},
): BoardInfo {
	const { layout = "planning", ago = HOUR, ...rest } = options;
	const id = `gallery${(next++).toString(36).padStart(3, "0")}`;
	const members = rest.members ?? [OCTOCAT];
	return {
		id,
		slug: slugify(title),
		title,
		owner: OCTOCAT,
		visibility: "instance",
		instanceRole: "editor",
		createdAt: NOW - 30 * DAY,
		updatedAt: NOW - ago,
		archivedAt: null,
		thumbnail: layout ? sketch(layout, next) : null,
		members,
		memberCount: members.length,
		role: "owner",
		canManage: true,
		visitedAt: NOW - ago / 2,
		...rest,
	};
}

const LAYOUTS: Layout[] = ["planning", "brainstorm", "triage", "retro", "sparse"];
const TITLES = [
	"unpic 5.0 release",
	"Q4 roadmap",
	"Triage: open issues",
	"Sprint 42 retro",
	"Docs restructure",
	"Image CDN adapters",
	"Astro integration ideas",
	"Bug bash, October",
	"Perf budget",
	"Contributor onboarding",
	"API design: transforms",
	"Incident review: CDN outage",
	"Hackathon brainstorm",
	"Now / Next / Later",
	"Design crit",
	"Release checklist",
];

export const FEW: BoardList = {
	recent: [],
	mine: [
		board("unpic 5.0 release", {
			layout: "planning",
			ago: 12 * MINUTE,
			members: [OCTOCAT, PRIYA, KAI],
		}),
		board("Sprint 42 retro", {
			layout: "retro",
			ago: 3 * HOUR,
			visibility: "private",
			members: [OCTOCAT, JO],
		}),
		board("A fresh idea", { layout: null, ago: 2 * MINUTE }),
	],
	shared: [
		board("Hackathon brainstorm", {
			layout: "brainstorm",
			ago: 2 * DAY,
			owner: PRIYA,
			members: [PRIYA, OCTOCAT, TOM, KAI, JO],
			memberCount: 7,
			role: "editor",
			canManage: false,
		}),
	],
	archived: [],
	open: [],
	canCreate: true,
};
FEW.recent = [FEW.mine[0], FEW.shared[0], FEW.mine[1]].filter((b): b is BoardInfo => !!b);
FEW.open = [...FEW.mine.filter((b) => b.visibility !== "private"), ...FEW.shared];

export const MANY: BoardList = (() => {
	const visibilities: Visibility[] = ["instance", "private", "public", "instance"];
	const all = TITLES.flatMap((title, i) =>
		[0, 1].map((round) =>
			board(round ? `${title} (${2025 - round})` : title, {
				layout: LAYOUTS[(i + round) % LAYOUTS.length],
				ago: (i * 7 + round * 50 + 1) * HOUR,
				visibility: visibilities[i % visibilities.length],
				members: [OCTOCAT, PRIYA, KAI, TOM].slice(0, 1 + (i % 4)),
				...(i % 3 === 0 ? { owner: KAI, role: i % 2 ? "viewer" : "editor", canManage: false } : {}),
			}),
		),
	);
	const mine = all.filter((b) => b.owner?.id === OCTOCAT.id);
	return {
		recent: all.slice(0, 8),
		mine,
		shared: all.filter((b) => b.owner?.id !== OCTOCAT.id),
		archived: [
			board("Old roadmap (2024)", { layout: "triage", ago: 90 * DAY, archivedAt: NOW - 20 * DAY }),
		],
		open: all.filter((b) => b.visibility !== "private"),
		canCreate: true,
	};
})();

export const EMPTY: BoardList = {
	recent: [],
	mine: [],
	shared: [],
	archived: [],
	open: [],
	canCreate: true,
};

export const EMPTY_WITH_TEAM: BoardList = { ...EMPTY, open: FEW.open };

export const PUBLIC: BoardList = {
	...EMPTY,
	canCreate: false,
	open: [
		board("unpic roadmap", {
			layout: "planning",
			visibility: "public",
			role: "viewer",
			canManage: false,
			members: [OCTOCAT, PRIYA],
			ago: 5 * HOUR,
		}),
		board("Good first issues", {
			layout: "triage",
			visibility: "public",
			role: "viewer",
			canManage: false,
			ago: 2 * DAY,
		}),
	],
};

export const GUEST: BoardList = { ...EMPTY, open: FEW.open.map((b) => ({ ...b, owner: null })) };

export const MEMBERS: BoardMember[] = [
	{ login: "octocat", person: OCTOCAT, role: "owner" },
	{ login: "priya-s", person: PRIYA, role: "editor" },
	{ login: "kai-a", person: KAI, role: "viewer" },
	{ login: "new-contributor", person: null, role: "editor" },
];
