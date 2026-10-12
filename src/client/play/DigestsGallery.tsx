import { type ReactNode, useState } from "react";
import { describeDue } from "../../shared/actionItems.ts";
import {
	type DigestRun,
	type DigestView,
	type WeeklyDigest,
	describeSchedule,
	digestMarkdown,
} from "../../shared/digests.ts";
import { Markdown } from "../changes/Markdown.tsx";
import type { DigestApi, DigestResult } from "../digests/api.ts";
import { DigestPanel } from "../digests/DigestDialog.tsx";
import { DigestLink } from "../digests/DigestLinkPage.tsx";
import { DigestPreview } from "../digests/DigestPreview.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import "./digestsGallery.css";

// Every state of weekly digests (#68): the dialog for the board's owner
// (not set up, no email on this Tack, set up with how the last ones went,
// a public repository for a private board) and for everyone else (asking
// for it by email, waiting to confirm, getting it, nothing set up); the
// digest itself, busy and quiet, as an email and as a Discussion; and the
// page the links in its emails open. `/play/digests`.

const ZONE = "Europe/London";
/** Monday 12 October 2026, 8:00 in London: an hour before it goes out. */
const NOW = Date.UTC(2026, 9, 12, 7);
const DAY = 24 * 60 * 60_000;
const NEXT = Date.UTC(2026, 9, 12, 8);
const BOARD = { id: "roadmap", title: "Unpic roadmap", visibility: "instance" as const };
const URL = "https://tack.example.com/b/roadmap/unpic-roadmap";

const BUSY: WeeklyDigest = {
	board: { id: BOARD.id, title: BOARD.title, url: URL },
	from: NOW - 7 * DAY,
	to: NOW,
	timeZone: ZONE,
	decisions: [
		{ id: "d1", title: "Move image tests off the shared runners", by: "Priya Shah", at: NOW - DAY },
		{ id: "d2", title: "Ship AVIF behind a flag in 5.1", by: "Kai Andersen", at: NOW - 3 * DAY },
	],
	actions: {
		done: [{ id: "a1", text: "Turn on retries for image downloads", owner: "kai" }],
		opened: [
			{
				id: "a2",
				text: "Write up the runner costs",
				owner: "priya",
				due: "2026-10-16",
				dueWords: describeDue("2026-10-16", "2026-10-12", false),
			},
			{ id: "a1", text: "Turn on retries for image downloads", owner: "kai" },
		],
		overdue: [
			{
				id: "a3",
				text: "Rotate the CI cache keys",
				owner: "jo",
				due: "2026-10-09",
				dueWords: describeDue("2026-10-09", "2026-10-12", false),
			},
		],
	},
	items: [
		{
			key: "github.com/acme/unpic#433",
			ref: "acme/unpic#433",
			title: "Retry flaky image downloads in CI",
			url: "https://github.com/acme/unpic/pull/433",
			kind: "pull",
			activity: ["approved", "merged"],
		},
		{
			key: "github.com/acme/unpic#412",
			ref: "acme/unpic#412",
			title: "Document the plugin API",
			url: "https://github.com/acme/unpic/issues/412",
			kind: "issue",
			activity: ["2 new comments", "closed"],
		},
		{
			key: "github.com/acme/unpic#440",
			ref: "acme/unpic#440",
			title: "Upgrade the test matrix to Node 24",
			url: "https://github.com/acme/unpic/pull/440",
			kind: "pull",
			activity: ["CI failing", "changes requested"],
		},
	],
	pushes: [
		{
			by: "Kai Andersen",
			at: NOW - 2 * DAY,
			applied: 3,
			failed: 0,
			summaries: ["Create issue “Ship the provider docs page”", "Add docs to #440", "Close #398"],
		},
	],
	people: [
		{
			name: "Priya Shah",
			login: "priya",
			summary: "added 4 stickies and a section, moved 2 cards",
			count: 7,
		},
		{
			name: "Kai Andersen",
			login: "kai",
			summary: "decided 1 decision, edited 3 stickies",
			count: 4,
		},
		{ name: "Jo Rivera", login: "jo", summary: "added 2 action items", count: 2 },
	],
	moreEdits: 6,
};

const QUIET: WeeklyDigest = {
	...BUSY,
	decisions: [],
	actions: { opened: [], done: [], overdue: [] },
	items: [],
	pushes: [],
	people: [],
	moreEdits: 0,
};

const SETTINGS = {
	discussion: { repo: "github.com/acme/unpic", category: "Announcements" },
	email: true,
	weekday: 1 as const,
	hour: 9,
	timeZone: ZONE,
};

const RUNS: DigestRun[] = [
	{
		week: "2026-W41",
		channel: "discussion",
		status: "sent",
		at: NOW - 7 * DAY + 60_000,
		url: "https://github.com/acme/unpic/discussions/52",
	},
	{
		week: "2026-W41",
		channel: "email",
		status: "sent",
		at: NOW - 7 * DAY + 90_000,
		sent: 6,
		failed: 1,
		error: "The recipient’s mail server refused it.",
	},
	{ week: "2026-W40", channel: "discussion", status: "quiet", at: NOW - 14 * DAY },
	{
		week: "2026-W39",
		channel: "discussion",
		status: "failed",
		at: NOW - 21 * DAY,
		error: "The Tack app isn’t installed on acme/unpic.",
	},
];

function view(over: Partial<DigestView> = {}): DigestView {
	return {
		settings: SETTINGS,
		by: { login: "priya", name: "Priya Shah" },
		nextAt: NEXT,
		runs: [],
		repoPublic: true,
		emailAvailable: true,
		canManage: false,
		subscribers: null,
		subscription: null,
		preview: { email: BUSY, discussion: null, markdown: null },
		...over,
	};
}

const MARKDOWN = digestMarkdown(BUSY, { schedule: describeSchedule(SETTINGS) });

/** Answers the gallery's dialogs without a server: changes stay put. */
function galleryApi(answer: () => Promise<DigestResult>): DigestApi {
	return { get: answer, set: answer, off: answer, subscribe: answer, unsubscribe: answer };
}

const never = galleryApi(() => new Promise(() => {}));
const offline = galleryApi(async () => ({ ok: false, error: "offline" }));
const noop = () => {};

const DIALOGS: {
	label: string;
	state: string;
	view?: DigestView;
	api?: DigestApi;
	board?: typeof BOARD | { id: string; title: string; visibility: "private" };
}[] = [
	{ label: "Gathering this week", state: "loading", api: never },
	{ label: "Couldn’t reach Tack", state: "load-error", api: offline },
	{
		label: "The owner, not set up yet",
		state: "owner-new",
		view: view({ settings: null, by: null, nextAt: null, canManage: true, subscribers: null }),
	},
	{
		label: "The owner, on a Tack that can’t send email",
		state: "owner-no-email",
		view: view({
			settings: null,
			by: null,
			nextAt: null,
			canManage: true,
			emailAvailable: false,
		}),
	},
	{
		label: "The owner, set up, with how the last ones went",
		state: "owner-set",
		view: view({
			canManage: true,
			subscribers: 6,
			runs: RUNS,
			subscription: { email: "priya@example.com", confirmed: true },
			preview: { email: BUSY, discussion: BUSY, markdown: MARKDOWN },
		}),
	},
	{
		label: "A private board posting in a public repository",
		state: "owner-exposed",
		board: { id: "plans", title: "Security plans", visibility: "private" },
		view: view({
			canManage: true,
			subscribers: 0,
			preview: { email: QUIET, discussion: QUIET, markdown: null },
		}),
	},
	{ label: "A member, who can ask for it by email", state: "member", view: view() },
	{
		label: "Waiting for them to confirm",
		state: "member-pending",
		view: view({ subscription: { email: "kai@example.com", confirmed: false } }),
	},
	{
		label: "They get it",
		state: "member-on",
		view: view({ subscription: { email: "kai@example.com", confirmed: true } }),
	},
	{
		label: "Nobody’s set it up",
		state: "member-off",
		view: view({
			settings: null,
			by: null,
			nextAt: null,
			preview: { email: QUIET, discussion: null, markdown: null },
		}),
	},
];

export default function DigestsGallery() {
	const [round, setRound] = useState(0);
	return (
		<div className="gallery digests-gallery" key={round}>
			<header className="gallery-head">
				<h1>Weekly digests</h1>
				<p>
					Once a week, what happened on a board: decisions, action items, GitHub and who did what,
					posted as a Discussion and emailed to the people who ask for it.
				</p>
				<div className="gallery-actions">
					<button type="button" onClick={() => setRound((r) => r + 1)}>
						Replay
					</button>
					<ThemeToggle labelled />
					<a className="play-link" href="/play?scenario=digest">
						A week on a board →
					</a>
				</div>
			</header>

			<section>
				<h2>The dialog</h2>
				{DIALOGS.map((d) => (
					<Figure key={d.state} label={d.label} state={d.state}>
						<div className="digest-dialog digests-gallery-dialog">
							<DigestPanel
								board={d.board ?? BOARD}
								onClose={noop}
								api={d.api ?? galleryApi(async () => ({ ok: true, value: d.view ?? view() }))}
								{...(d.view ? { initial: d.view } : {})}
								now={NOW}
								timeZone={ZONE}
							/>
						</div>
					</Figure>
				))}
			</section>

			<section>
				<h2>The digest</h2>
				<div className="gallery-grid digests-gallery-papers">
					<Figure label="A busy week, as an email" state="paper-busy">
						<DigestPreview digest={BUSY} />
					</Figure>
					<Figure label="As a Discussion" state="paper-discussion">
						<div className="digest-paper digest-markdown">
							<p className="digest-paper-brand">💬 Discussion · {BOARD.title}</p>
							<Markdown source={MARKDOWN} />
						</div>
					</Figure>
					<Figure label="A quiet week: nothing goes out" state="paper-quiet">
						<DigestPreview digest={QUIET} />
					</Figure>
				</div>
			</section>

			<section>
				<h2>From the emails</h2>
				<div className="gallery-grid digests-gallery-links">
					<Figure label="Confirming" state="link-busy">
						<DigestLink
							link={{ kind: "confirm", token: "t" }}
							follow={async () => new Promise(() => {})}
							initial={{ kind: "busy" }}
						/>
					</Figure>
					<Figure label="Confirmed" state="link-confirmed">
						<DigestLink
							link={{ kind: "confirm", token: "t" }}
							follow={async () => ({ ok: false, error: "offline" })}
							initial={{
								kind: "done",
								action: "confirm",
								result: {
									ok: true,
									title: BOARD.title,
									path: "/b/roadmap/unpic-roadmap",
									schedule: describeSchedule(SETTINGS),
								},
							}}
						/>
					</Figure>
					<Figure label="Stopping, on a click" state="link-ask">
						<DigestLink
							link={{ kind: "unsubscribe", token: "t" }}
							follow={async () => ({ ok: true, title: BOARD.title })}
						/>
					</Figure>
					<Figure label="Stopped" state="link-stopped">
						<DigestLink
							link={{ kind: "unsubscribe", token: "t" }}
							follow={async () => ({ ok: false, error: "offline" })}
							initial={{
								kind: "done",
								action: "unsubscribe",
								result: { ok: true, title: BOARD.title },
							}}
						/>
					</Figure>
					<Figure label="An old or used link" state="link-expired">
						<DigestLink link={null} follow={async () => ({ ok: false, error: "expired" })} />
					</Figure>
				</div>
			</section>
		</div>
	);
}

function Figure({ label, state, children }: { label: string; state: string; children: ReactNode }) {
	return (
		<figure data-state={state}>
			<div className="digests-gallery-stage">{children}</div>
			<figcaption>{label}</figcaption>
		</figure>
	);
}
