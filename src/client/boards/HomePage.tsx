import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { Me } from "../../shared/auth.ts";
import { type BoardInfo, type BoardList, boardPath } from "../../shared/boards.ts";
import { NotAllowedPage, SignInPage } from "../auth/AccessGate.tsx";
import { AccountMenu, SignInButton } from "../auth/AccountMenu.tsx";
import { personUser, useMe } from "../auth/me.ts";
import { BrandMark } from "../BrandMark.tsx";
import { localUser, type User } from "../presence.ts";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { boardsApi } from "./api.ts";
import { BoardTile, type TileActions, type TileTime } from "./BoardTile.tsx";
import { PlusIcon, SearchIcon } from "./icons.tsx";
import "./boards.css";

type Tab = "recent" | "mine" | "shared" | "open" | "archived";

const TABS: { tab: Tab; label: string; time: TileTime }[] = [
	{ tab: "recent", label: "Recent", time: "visited" },
	{ tab: "mine", label: "My boards", time: "updated" },
	{ tab: "shared", label: "Shared with me", time: "updated" },
	{ tab: "open", label: "On this Tack", time: "updated" },
	{ tab: "archived", label: "Archived", time: "archived" },
];

/** Show a search box once there are this many boards to look through. */
const SEARCH_FROM = 7;

/** `/`: your boards, or the instance's public ones, or a sign-in page. */
export function HomeRoute() {
	const state = useMe();
	const [list, setList] = useState<BoardList | null>(null);
	const [failed, setFailed] = useState(false);
	const [creating, setCreating] = useState(false);

	const load = useCallback(async () => {
		const result = await boardsApi.list();
		if (result.ok) setList(result.value);
		else setFailed(true);
	}, []);

	useEffect(() => {
		document.title = "Tack";
		void load();
	}, [load]);

	const actions = useMemo<TileActions>(
		() => ({
			rename: async (board, title) => {
				const result = await boardsApi.update(board.id, { title });
				if (result.ok) void load();
				return result.ok;
			},
			archive: async (board, archived) => {
				const result = await boardsApi.update(board.id, { archived });
				if (result.ok) void load();
				return result.ok;
			},
		}),
		[load],
	);

	const create = async () => {
		setCreating(true);
		const result = await boardsApi.create();
		if (result.ok) {
			location.assign(`${boardPath(result.value)}?new=1`);
		} else {
			setCreating(false);
			setFailed(true);
		}
	};

	if (state.status === "loading" || (!list && !failed)) {
		return <div className="home" aria-busy="true" />;
	}
	const { me } = state;
	// Nothing to show someone who can't use the instance, unless something's public.
	if (!me.allowed && (list?.open.length ?? 0) === 0) {
		return me.viewer ? <NotAllowedPage me={me} /> : <SignInPage me={me} />;
	}
	return (
		<HomeView
			me={me}
			list={list}
			failed={failed}
			creating={creating}
			onCreate={() => void create()}
			actions={actions}
		/>
	);
}

/** The home page itself, from data: also rendered by the gallery (`/play/boards`). */
export function HomeView({
	me,
	list,
	failed = false,
	creating = false,
	onCreate,
	actions,
	user: givenUser,
	now,
	initialTab,
}: {
	me: Me;
	list: BoardList | null;
	failed?: boolean;
	creating?: boolean;
	onCreate: () => void;
	actions?: TileActions;
	user?: User;
	now?: number;
	initialTab?: Tab;
}) {
	const [guest] = useState(localUser);
	const user = givenUser ?? (me.viewer ? personUser(me.viewer) : guest);
	const publicOnly = !me.allowed;
	const guestMode = me.allowed && !me.viewer;

	const tabs = useMemo(() => {
		if (!list || publicOnly || guestMode) return [];
		return TABS.filter(({ tab }) => tab === "mine" || list[tab].length > 0);
	}, [list, publicOnly, guestMode]);

	const [chosen, setTab] = useState<Tab | null>(initialTab ?? null);
	const tab: Tab =
		chosen && tabs.some((t) => t.tab === chosen)
			? chosen
			: publicOnly || guestMode
				? "open"
				: (tabs.find((t) => t.tab === "recent")?.tab ?? "mine");
	const time = TABS.find((t) => t.tab === tab)?.time ?? "updated";

	const [query, setQuery] = useState("");
	const boards = list?.[tab] ?? [];
	const total = list
		? new Set([...list.mine, ...list.shared, ...list.open].map((b) => b.id)).size
		: 0;
	const filtered = query.trim()
		? boards.filter((board) => board.title.toLowerCase().includes(query.trim().toLowerCase()))
		: boards;

	const yours = list ? list.mine.length + list.shared.length + list.recent.length : 0;
	const empty = !publicOnly && list !== null && yours === 0 && list.archived.length === 0;

	return (
		<div className="home">
			<header className="topbar home-bar">
				<a className="brand" href="/">
					<BrandMark />
					tack
				</a>
				<span className="home-bar-end">
					<ThemeToggle />
					{me.viewer || me.signIn !== "ready" ? (
						<span className="people home-account">
							<AccountMenu me={me} user={user} />
						</span>
					) : (
						<SignInButton me={me} />
					)}
				</span>
			</header>

			<main className="home-main">
				{failed && (
					<p className="home-error" role="alert">
						Couldn’t reach Tack just now.{" "}
						<button type="button" onClick={() => location.reload()}>
							Try again
						</button>
					</p>
				)}

				{empty && !guestMode ? (
					<>
						<EmptyHome
							onCreate={onCreate}
							creating={creating}
							canCreate={list?.canCreate ?? false}
						/>
						{list && list.open.length > 0 && (
							<section className="home-section">
								<h2 className="home-section-title">Boards on this Tack</h2>
								<Grid boards={list.open} time="updated" actions={actions} now={now} />
							</section>
						)}
					</>
				) : (
					<>
						<div className="home-head">
							<div>
								<h1>{publicOnly ? "Public boards" : "Boards"}</h1>
								{publicOnly && (
									<p className="home-lede">
										Boards shared publicly on this Tack. Sign in to see the rest.
									</p>
								)}
							</div>
							<div className="home-head-actions">
								{total >= SEARCH_FROM && (
									<label className="home-search">
										<SearchIcon />
										<span className="visually-hidden">Find a board</span>
										<input
											type="search"
											placeholder="Find a board"
											value={query}
											onChange={(event) => setQuery(event.target.value)}
										/>
									</label>
								)}
								{list?.canCreate && <NewBoardButton onCreate={onCreate} creating={creating} />}
							</div>
						</div>

						{tabs.length > 1 && (
							<div className="home-tabs" role="tablist" aria-label="Boards">
								{tabs.map((t) => (
									<button
										key={t.tab}
										type="button"
										role="tab"
										aria-selected={t.tab === tab}
										onClick={() => setTab(t.tab)}
									>
										{t.label}
										<span className="home-tab-count">{list?.[t.tab].length}</span>
									</button>
								))}
							</div>
						)}

						{filtered.length > 0 ? (
							<Grid key={tab} boards={filtered} time={time} actions={actions} now={now} />
						) : (
							<p className="home-none">
								{query.trim()
									? `No boards called “${query.trim()}”.`
									: guestMode
										? "No boards yet. Make the first one."
										: tab === "shared"
											? "Nothing shared with you yet."
											: "No boards here yet."}
							</p>
						)}
					</>
				)}
			</main>
		</div>
	);
}

function Grid({
	boards,
	time,
	actions,
	now,
}: {
	boards: BoardInfo[];
	time: TileTime;
	actions?: TileActions;
	now?: number;
}) {
	return (
		<div className="home-grid">
			{boards.map((board, i) => (
				<BoardTile key={board.id} board={board} time={time} actions={actions} index={i} now={now} />
			))}
		</div>
	);
}

function NewBoardButton({
	onCreate,
	creating,
	children = "New board",
}: {
	onCreate: () => void;
	creating: boolean;
	children?: ReactNode;
}) {
	return (
		<button
			type="button"
			className="primary home-new"
			onClick={onCreate}
			disabled={creating}
			aria-busy={creating}
		>
			<PlusIcon />
			{creating ? "Creating…" : children}
		</button>
	);
}

/** No boards yet: a cork board with a few notes, waiting for the first. */
function EmptyHome({
	onCreate,
	creating,
	canCreate,
}: {
	onCreate: () => void;
	creating: boolean;
	canCreate: boolean;
}) {
	return (
		<section className="home-empty">
			<div className="home-empty-art" aria-hidden="true">
				<span className="home-empty-board" />
				<span className="home-empty-note" data-color="yellow" />
				<span className="home-empty-note" data-color="blue" />
				<span className="home-empty-note" data-color="pink" />
				<span className="home-empty-pin" />
			</div>
			<h1>Your boards will live here</h1>
			<p className="home-lede">
				Plan a release, triage a backlog, or think out loud with your team, with live issues and
				pull requests from any repo.
			</p>
			{canCreate && (
				<NewBoardButton onCreate={onCreate} creating={creating}>
					Create your first board
				</NewBoardButton>
			)}
		</section>
	);
}
