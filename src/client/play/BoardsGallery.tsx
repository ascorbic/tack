import { type ReactNode, useMemo, useState } from "react";
import type { Me } from "../../shared/auth.ts";
import type {
	BoardInfo,
	BoardList,
	BoardMember,
	MemberRole,
	PeopleSuggestions,
	PersonLookup,
	Role,
	Visibility,
} from "../../shared/boards.ts";
import type { ApiResult } from "../boards/api.ts";
import {
	AccessChip,
	ArchivedNotice,
	RoleToastView,
	ShareButton,
	ViewOnlyBadge,
} from "../boards/BoardPage.tsx";
import { RepoList } from "../boards/BoardRepos.tsx";
import { BoardTile } from "../boards/BoardTile.tsx";
import { BoardTitle } from "../boards/BoardTitle.tsx";
import { HomeView } from "../boards/HomePage.tsx";
import type { BoardRepo } from "../boards/repoStatus.ts";
import { type ShareActions, SharePanel } from "../boards/SharePanel.tsx";
import { BrandMark } from "../BrandMark.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import {
	EMPTY,
	EMPTY_WITH_TEAM,
	FEW,
	GUEST,
	JO,
	KAI,
	ME_GUEST,
	ME_SIGNED_IN,
	ME_SIGNED_OUT,
	MANY,
	MEMBERS,
	NOW,
	PUBLIC,
	PRIYA,
	TOM,
	board,
} from "./boardFixtures.ts";
import "../boards/boards.css";
import "./boardsGallery.css";

// Every board state: home pages from empty to busy, tiles, the share
// dialog and the board's top bar. `/play/boards`; `/play/boards?home=few`
// (empty, team, few, many, public, guest) shows one home page full size.

const HOMES: Record<string, { label: string; me: Me; list: BoardList }> = {
	empty: { label: "Empty", me: ME_SIGNED_IN, list: EMPTY },
	team: { label: "Empty, with the team’s boards", me: ME_SIGNED_IN, list: EMPTY_WITH_TEAM },
	few: { label: "A few boards", me: ME_SIGNED_IN, list: FEW },
	many: { label: "Many boards", me: ME_SIGNED_IN, list: MANY },
	public: { label: "Signed out, public boards", me: ME_SIGNED_OUT, list: PUBLIC },
	guest: { label: "Guest, before setup", me: ME_GUEST, list: GUEST },
};

const TILES: { label: string; board: BoardInfo }[] = [
	{
		label: "Planning, shared",
		board: board("unpic 5.0 release", { layout: "planning", members: [PRIYA, KAI, JO] }),
	},
	{
		label: "Brainstorm",
		board: board("Hackathon ideas", { layout: "brainstorm", visibility: "public" }),
	},
	{
		label: "Triage",
		board: board("Triage: open issues", { layout: "triage", visibility: "private" }),
	},
	{ label: "Retro", board: board("Sprint 42 retro", { layout: "retro" }) },
	{ label: "Empty", board: board("A fresh idea", { layout: null, ago: 30_000 }) },
	{
		label: "Long title, lots of people",
		board: board(
			"Incident review: the image CDN outage on the first of October, and what we learned",
			{
				layout: "sparse",
				members: [PRIYA, KAI, JO],
				memberCount: 12,
			},
		),
	},
	{
		label: "Archived",
		board: board("Old roadmap (2024)", { layout: "triage", archivedAt: NOW - 3 * 86_400_000 }),
	},
	{
		label: "View only",
		board: board("Design crit", { layout: "retro", role: "viewer", canManage: false, owner: KAI }),
	},
];

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** People on this pretend Tack, for suggestions and lookups. */
const ON_THIS_TACK = [PRIYA, KAI, TOM, JO];

/** Who a login is, simulated: "ghost" isn't anyone, "emdash-cms" is an organisation. */
async function fakeLookup(login: string): Promise<ApiResult<PersonLookup>> {
	await delay(350);
	const key = login.replace(/^@/, "").toLowerCase();
	const known = ON_THIS_TACK.find((person) => person.login === key);
	const value: PersonLookup = known
		? { login: key, status: "known", person: known, allowed: true }
		: key === "ghost"
			? { login: key, status: "unknown", person: null, allowed: null }
			: key === "emdash-cms"
				? { login: key, status: "organization", person: null, allowed: null }
				: {
						login: key,
						status: "github",
						person: { id: 9000 + key.length, login: key, name: null, avatarUrl: "" },
						allowed: null,
					};
	return { ok: true, value };
}

async function fakeSuggest(q: string): Promise<ApiResult<PeopleSuggestions>> {
	await delay(80);
	const query = q.toLowerCase();
	const people = ON_THIS_TACK.filter(
		(person) =>
			person.login.startsWith(query) ||
			(person.name ?? "")
				.toLowerCase()
				.split(/\s+/)
				.some((word) => word.startsWith(query)),
	).map((person): PersonLookup => ({
		login: person.login,
		status: "known",
		person,
		allowed: true,
	}));
	return { ok: true, value: { people } };
}

/** The repositories of a board that's mostly ready, for the Share dialog's pre-flight. */
const REPOS: BoardRepo[] = [
	{ key: "github.com/lovell/sharp", name: "lovell/sharp", cards: 3, state: "readonly" },
	{ key: "github.com/emdash-cms/docs", name: "emdash-cms/docs", cards: 4, state: "loading" },
	{ key: "github.com/emdash-cms/emdash", name: "emdash-cms/emdash", cards: 18, state: "ready" },
];

/** Sharing, simulated: invite "ghost" to see an error. */
function fakeShare(initial: BoardMember[], board: BoardInfo, slow = 500): ShareActions {
	let members = initial;
	const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
	return {
		lookup: fakeLookup,
		suggest: fakeSuggest,
		link: `https://tack.example.com/b/${board.id}/${board.slug}`,
		members: async () => {
			await delay(slow);
			return ok({ members });
		},
		invite: async (logins, role: MemberRole) => {
			await delay(450);
			const clean = logins.map((login) => login.replace(/^@/, "").toLowerCase());
			if (clean.includes("ghost")) return { ok: false, error: "invalid_login", logins: ["ghost"] };
			const known = new Set(members.map((m) => m.login));
			members = [
				...members.map((m) => (clean.includes(m.login) && m.role !== "owner" ? { ...m, role } : m)),
				...clean
					.filter((login) => !known.has(login))
					.map((login) => ({ login, person: null, role })),
			];
			return ok({ members });
		},
		setRole: async (login, role: Role) => {
			await delay(250);
			members = members.map((m) =>
				m.login === login
					? { ...m, role }
					: role === "owner" && m.role === "owner"
						? { ...m, role: "editor" as const }
						: m,
			);
			return ok({ members });
		},
		remove: async (login) => {
			await delay(250);
			members = members.filter((m) => m.login !== login);
			return ok({ members });
		},
		update: async (request) => {
			await delay(250);
			return ok({ ...board, ...request, archivedAt: null } as BoardInfo);
		},
	};
}

export default function BoardsGallery() {
	const only = new URLSearchParams(location.search).get("home");
	const single = only ? HOMES[only] : undefined;
	if (single) {
		return (
			<HomeView
				me={single.me}
				list={single.list}
				onCreate={() => undefined}
				now={NOW}
				actions={noActions}
			/>
		);
	}
	return <Gallery />;
}

const noActions = {
	rename: async () => {
		await delay(300);
		return true;
	},
	archive: async () => {
		await delay(300);
		return true;
	},
};

function Gallery() {
	const [round, setRound] = useState(0);
	const [motion, setMotion] = useState(false);
	const [both, setBoth] = useState(false);

	return (
		<div className="gallery" data-motion={motion ? "slow" : undefined}>
			<header className="gallery-head">
				<h1>Boards</h1>
				<p>
					Home pages from empty to busy, board tiles, sharing and view-only states. “Replay” re-runs
					the entrance animations.
				</p>
				<div className="gallery-actions">
					<button type="button" className="primary" onClick={() => setRound((r) => r + 1)}>
						Replay
					</button>
					<ThemeToggle labelled />
					<label className="play-toggle">
						<input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} />
						Both themes side by side
					</label>
					<label className="play-toggle">
						<input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} />
						Slow motion
					</label>
					<a className="play-link" href="/play/cards">
						Card gallery
					</a>
					<a className="play-link" href="/play">
						← Playground
					</a>
				</div>
			</header>

			{both ? (
				<div className="gallery-split">
					<div className="gallery-pane" data-theme="light">
						<Sections round={round} />
					</div>
					<div className="gallery-pane" data-theme="dark">
						<Sections round={round} />
					</div>
				</div>
			) : (
				<Sections round={round} />
			)}
		</div>
	);
}

function Sections({ round }: { round: number }) {
	const owner = TILES[0]?.board ?? board("Board");
	const shareOwner = useMemo(() => fakeShare(MEMBERS, owner), [owner, round]);
	const viewerBoard = useMemo(
		() => ({ ...owner, visibility: "public" as const, role: "viewer" as const, canManage: false }),
		[owner],
	);
	const shareViewer = useMemo(() => fakeShare(MEMBERS, viewerBoard), [viewerBoard, round]);
	const shareLoading = useMemo(() => fakeShare(MEMBERS, owner, 60_000), [owner, round]);
	const publicBoard = useMemo(() => ({ ...owner, visibility: "public" as const }), [owner]);
	const sharePublic = useMemo(() => fakeShare(MEMBERS, publicBoard), [publicBoard, round]);
	const shareSetup = useMemo(() => fakeShare(MEMBERS, owner), [owner, round]);
	const [shared, setShared] = useState(owner);
	const privateBoard = { ...owner, visibility: "private" as const };

	return (
		<>
			<section>
				<h2>Home</h2>
				<div className="gallery-grid gallery-homes">
					{Object.entries(HOMES).map(([key, { label, me, list }]) => (
						<Frame key={`${key}-${round}`} label={label} href={`/play/boards?home=${key}`}>
							<HomeView
								me={me}
								list={list}
								onCreate={() => undefined}
								now={NOW}
								actions={noActions}
							/>
						</Frame>
					))}
				</div>
			</section>

			<section>
				<h2>Tiles</h2>
				<div className="gallery-grid gallery-tiles">
					{TILES.map(({ label, board: tile }, i) => (
						<figure key={`${label}-${round}`}>
							<BoardTile board={tile} index={i} now={NOW} actions={noActions} />
							<figcaption>{label}</figcaption>
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Share</h2>
				<p className="gallery-note">Invites are simulated. Invite “ghost” to see an error.</p>
				<div className="gallery-grid gallery-shares">
					<ShareFrame label="Owner" key={`owner-${round}`}>
						<SharePanel
							board={shared}
							me={ME_SIGNED_IN.viewer}
							actions={shareOwner}
							onBoard={setShared}
						/>
					</ShareFrame>
					<ShareFrame label="Viewer, public board" key={`viewer-${round}`}>
						<SharePanel
							board={viewerBoard}
							me={KAI}
							actions={shareViewer}
							onBoard={() => undefined}
						/>
					</ShareFrame>
					<ShareFrame label="Loading" key={`loading-${round}`}>
						<SharePanel
							board={privateBoard}
							me={ME_SIGNED_IN.viewer}
							actions={shareLoading}
							onBoard={() => undefined}
						/>
					</ShareFrame>
					<ShareFrame label="Public, with the board’s repositories" key={`repos-${round}`}>
						<SharePanel
							board={publicBoard}
							me={ME_SIGNED_IN.viewer}
							actions={sharePublic}
							onBoard={() => undefined}
							repos={<RepoList repos={REPOS} returnTo="/b/demo/demo" />}
						/>
					</ShareFrame>
					<ShareFrame label="Before setup" key={`setup-${round}`}>
						<SharePanel
							board={owner}
							me={ME_SIGNED_IN.viewer}
							actions={shareSetup}
							onBoard={() => undefined}
							setupPending
						/>
					</ShareFrame>
				</div>
			</section>

			<section>
				<h2>Board top bar</h2>
				<div className="gallery-bars" key={round}>
					<figure>
						<TopBar>
							<BoardTitle title="unpic 5.0 release" editable onRename={() => delay(400)} />
							<AccessChip visibility="instance" instanceRole="editor" onClick={() => undefined} />
							<span className="gallery-bar-end">
								<ShareButton visibility="instance" />
							</span>
						</TopBar>
						<figcaption>Owner: click the title to rename</figcaption>
					</figure>
					<figure>
						<TopBar>
							<BoardTitle
								title="Untitled board"
								editable
								startEditing
								onRename={() => delay(400)}
							/>
							<AccessChip visibility="private" instanceRole="editor" onClick={() => undefined} />
							<span className="gallery-bar-end">
								<ShareButton visibility="private" />
							</span>
						</TopBar>
						<figcaption>Just created</figcaption>
					</figure>
					<figure>
						<TopBar>
							<BoardTitle title="Good first issues" editable={false} onRename={() => delay(0)} />
							<AccessChip visibility={"public" satisfies Visibility} instanceRole="viewer" />
							<span className="gallery-bar-end">
								<ViewOnlyBadge />
							</span>
						</TopBar>
						<figcaption>View only</figcaption>
					</figure>
					<figure>
						<TopBar>
							<BoardTitle
								title="Incident review: the image CDN outage on the first of October, and what we learned"
								editable
								onRename={() => delay(400)}
							/>
							<AccessChip visibility="instance" instanceRole="viewer" onClick={() => undefined} />
							<span className="gallery-bar-end">
								<ShareButton visibility="public" />
							</span>
						</TopBar>
						<figcaption>A long title gives way, and never wraps the bar</figcaption>
					</figure>
					<figure>
						<div className="gallery-frame gallery-canvas">
							<ArchivedNotice board={{ ...owner, archivedAt: NOW }} onRestore={() => undefined} />
						</div>
						<figcaption>Archived</figcaption>
					</figure>
					<figure>
						<div className="gallery-frame gallery-canvas">
							<RoleToastView role="editor" />
						</div>
						<figcaption>Your role changed: now an editor</figcaption>
					</figure>
					<figure>
						<div className="gallery-frame gallery-canvas">
							<RoleToastView role="viewer" />
						</div>
						<figcaption>Your role changed: now a viewer</figcaption>
					</figure>
				</div>
			</section>
		</>
	);
}

function Frame({ label, href, children }: { label: string; href: string; children: ReactNode }) {
	return (
		<figure>
			<div className="gallery-home-frame">{children}</div>
			<figcaption>
				{label} · <a href={href}>full size</a>
			</figcaption>
		</figure>
	);
}

function ShareFrame({ label, children }: { label: string; children: ReactNode }) {
	return (
		<figure>
			<div className="gallery-share">{children}</div>
			<figcaption>{label}</figcaption>
		</figure>
	);
}

function TopBar({ children }: { children: ReactNode }) {
	return (
		<header className="topbar gallery-topbar">
			<span className="brand">
				<BrandMark />
				tack
			</span>
			{children}
		</header>
	);
}
