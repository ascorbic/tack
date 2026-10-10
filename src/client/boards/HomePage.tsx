import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Me } from "../../shared/auth.ts";
import { type BoardInfo, type BoardList, boardPath } from "../../shared/boards.ts";
import { NotAllowedPage, SignInPage } from "../auth/AccessGate.tsx";
import { AccountMenu, SignInButton } from "../auth/AccountMenu.tsx";
import { personUser, useMe } from "../auth/me.ts";
import { BrandMark } from "../BrandMark.tsx";
import { NotificationsButton } from "../comments/Notifications.tsx";
import { takeFlash } from "../flash.ts";
import { scaledDuration } from "../motion.ts";
import { localUser, type User } from "../presence.ts";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { Toasts, ToastStore } from "../Toasts.tsx";
import { rememberAccess, rememberedAccess } from "./access.ts";
import { boardsApi } from "./api.ts";
import { BoardTile, type TileActions, type TileTime } from "./BoardTile.tsx";
import { type Tab, defaultTab, renameIn, tabLists, unseenShared } from "./homeTabs.ts";
import { PlusIcon, SearchIcon } from "./icons.tsx";
import { type NewBoardRequest, NewBoardDialog } from "./NewBoard.tsx";
import { searchBoards } from "./search.ts";
import { templateLibrary, templatesApi } from "./templates.ts";
import "./boards.css";

const TABS: { tab: Tab; label: string; time: TileTime }[] = [
	{ tab: "recent", label: "Recent", time: "visited" },
	{ tab: "mine", label: "My boards", time: "updated" },
	{ tab: "shared", label: "Shared with me", time: "updated" },
	{ tab: "open", label: "Team boards", time: "updated" },
	{ tab: "archived", label: "Archived", time: "archived" },
];

/** Show a search box once there are this many boards to look through. */
const SEARCH_FROM = 7;

/** How long an archived tile takes to fold away before the grid closes up. */
const LEAVE_MS = 260;

/** `/`: your boards, or the instance's public ones, or a sign-in page. */
export function HomeRoute() {
	const state = useMe();
	const [list, setList] = useState<BoardList | null>(null);
	const [failed, setFailed] = useState(false);
	const [creating, setCreating] = useState(false);
	const [leaving, setLeaving] = useState<Set<string>>(new Set());
	const [toasts] = useState(() => new ToastStore());

	const load = useCallback(async () => {
		const result = await boardsApi.list();
		if (result.ok) setList(result.value);
		else setFailed(true);
	}, []);

	useEffect(() => {
		document.title = "Tack";
		void load();
		// "You left “Roadmap”", "Signed out": from the page before this one.
		const flash = takeFlash();
		if (flash) toasts.show({ message: flash.message });
	}, [load, toasts]);

	const actions = useMemo<TileActions>(() => {
		const archive = async (board: BoardInfo, archived: boolean): Promise<boolean> => {
			const result = await boardsApi.update(board.id, { archived });
			if (!result.ok) {
				toasts.show({ message: `Couldn’t ${archived ? "archive" : "restore"} “${board.title}”` });
				return false;
			}
			// Fold the tile away, then close the grid up around it.
			setLeaving((current) => new Set(current).add(board.id));
			setTimeout(() => {
				void load().then(() =>
					setLeaving((current) => {
						const next = new Set(current);
						next.delete(board.id);
						return next;
					}),
				);
			}, scaledDuration(LEAVE_MS));
			toasts.show({
				message: archived ? `Archived “${board.title}”` : `Restored “${board.title}”`,
				action: {
					label: "Undo",
					run: () => void archive(result.value, !archived),
				},
			});
			return true;
		};
		return {
			rename: async (board, title) => {
				const result = await boardsApi.update(board.id, { title });
				if (!result.ok) return false;
				// Rename it where it is: re-sorting now would move the tile from under you.
				const { title: renamed, slug } = result.value;
				setList((current) => current && renameIn(current, board.id, renamed, slug));
				return true;
			},
			archive,
		};
	}, [load, toasts]);

	// New boards start in the template picker (#53), which the saved
	// templates are fetched for as soon as the page knows you can make one.
	// `/?template=id` (say, from "Make a board from it") opens the picker on it.
	const [initialTemplate] = useState(
		() => new URLSearchParams(location.search).get("template") ?? undefined,
	);
	const [picking, setPicking] = useState(initialTemplate !== undefined);
	const [createError, setCreateError] = useState<string | null>(null);
	useEffect(() => {
		if (list?.canCreate) void templateLibrary.load();
	}, [list?.canCreate]);
	const yours = useMemo(() => {
		if (!list) return [];
		const seen = new Set<string>();
		return [...list.recent, ...list.mine, ...list.shared].filter(
			(board) => !seen.has(board.id) && seen.add(board.id),
		);
	}, [list]);
	const login = state.status === "ready" ? state.me.viewer?.login : undefined;

	const create = async (request: NewBoardRequest) => {
		setCreating(true);
		setCreateError(null);
		if (request.visibility) rememberAccess(login, request.visibility);
		const result = await boardsApi.create({
			...(request.title ? { title: request.title } : {}),
			...(request.visibility ? { visibility: request.visibility } : {}),
			...(request.template ? { template: request.template, repos: request.repos } : {}),
			...(request.carryFrom ? { carryFrom: request.carryFrom } : {}),
		});
		if (result.ok) {
			location.assign(`${boardPath(result.value)}?new=1`);
		} else {
			setCreating(false);
			setCreateError(
				result.error === "not_found"
					? "That template’s gone: someone deleted it. Pick another?"
					: result.error === "offline"
						? "Couldn’t reach Tack just now. Try again?"
						: "Couldn’t make the board. Try again?",
			);
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
		<>
			<HomeView
				me={me}
				list={list}
				failed={failed}
				creating={creating}
				onCreate={() => setPicking(true)}
				actions={actions}
				leaving={leaving}
				toasts={toasts}
			/>
			<NewBoardDialog
				open={picking}
				onClose={() => {
					setPicking(false);
					setCreateError(null);
				}}
				boards={yours}
				initial={initialTemplate}
				creating={creating}
				error={createError}
				// Signed-out boards (before setup, Previews) have no owner, so stay open to everyone.
				access={me.viewer ? rememberedAccess(me.viewer.login) : undefined}
				onCreate={(request) => void create(request)}
				onDelete={async (template) => {
					const result = await templatesApi.remove(template.id);
					if (result.ok || result.error === "not_found") templateLibrary.removed(template.id);
					return result.ok || result.error === "not_found";
				}}
			/>
		</>
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
	leaving,
	toasts,
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
	/** Tiles folding away (just archived or restored). */
	leaving?: Set<string>;
	toasts?: ToastStore;
}) {
	const [guest] = useState(localUser);
	const user = givenUser ?? (me.viewer ? personUser(me.viewer) : guest);
	const publicOnly = !me.allowed;
	const guestMode = me.allowed && !me.viewer;
	const setupPending = me.signIn === "unconfigured";

	const lists = useMemo(() => (list ? tabLists(list) : null), [list]);
	const unseen = useMemo(() => new Set(list ? unseenShared(list).map((b) => b.id) : []), [list]);

	const tabs = useMemo(() => {
		if (!lists || publicOnly || guestMode) return [];
		return TABS.filter(({ tab }) => tab === "mine" || lists[tab].length > 0);
	}, [lists, publicOnly, guestMode]);

	const [chosen, setTab] = useState<Tab | null>(initialTab ?? null);
	const tab: Tab =
		chosen && tabs.some((t) => t.tab === chosen)
			? chosen
			: publicOnly || guestMode
				? "open"
				: lists
					? defaultTab(lists)
					: "mine";
	const time = TABS.find((t) => t.tab === tab)?.time ?? "updated";

	const [query, setQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const search = useRef<HTMLInputElement>(null);
	const searching = query.trim().length > 0;
	// Guests and the signed out see one list: the open boards.
	const boards = (publicOnly || guestMode ? list?.open : lists?.[tab]) ?? [];
	const results = useMemo(
		() =>
			searching && list
				? publicOnly || guestMode
					? searchBoards({ ...list, recent: [], mine: [], shared: [], archived: [] }, query)
					: searchBoards(list, query)
				: null,
		[searching, list, query, publicOnly, guestMode],
	);
	useEffect(() => setShowArchived(false), [query]);

	const total = list
		? new Set([...list.mine, ...list.shared, ...list.open].map((b) => b.id)).size
		: 0;
	const searchable = total >= SEARCH_FROM;

	// `/` finds a board, as on GitHub.
	useEffect(() => {
		if (!searchable) return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (
				target?.closest("input, textarea, select, [contenteditable=''], [contenteditable=true]")
			) {
				return;
			}
			if (document.querySelector("dialog[open]")) return;
			event.preventDefault();
			search.current?.focus();
			search.current?.select();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [searchable]);

	const yours = list ? list.mine.length + list.shared.length + list.recent.length : 0;
	const empty = !publicOnly && list !== null && yours === 0 && list.archived.length === 0;
	const guestEmpty = guestMode && list !== null && list.open.length === 0;
	const tabsId = useId();
	const panelId = `${tabsId}-panel`;
	const tabLabel = TABS.find((t) => t.tab === tab)?.label ?? "Boards";

	return (
		<div className="home">
			<header className="topbar home-bar">
				<a className="brand" href="/">
					<BrandMark />
					tack
				</a>
				<span className="home-bar-end">
					{me.viewer && <NotificationsButton />}
					{me.viewer || me.signIn !== "ready" ? (
						<span className="people home-account">
							<AccountMenu me={me} user={user} />
						</span>
					) : (
						<>
							<ThemeToggle />
							<SignInButton me={me} />
						</>
					)}
				</span>
			</header>

			<main className="home-main">
				{setupPending && <SetupBanner admin={me.admin || !me.viewer} />}
				{failed && (
					<p className="home-error" role="alert">
						Couldn’t reach Tack just now.{" "}
						<button type="button" onClick={() => location.reload()}>
							Try again
						</button>
					</p>
				)}

				{(empty && !guestMode) || guestEmpty ? (
					<>
						<EmptyHome
							onCreate={onCreate}
							creating={creating}
							canCreate={list?.canCreate ?? false}
						/>
						{list && list.open.length > 0 && !guestMode && (
							<section className="home-section">
								<h2 className="home-section-title">Team boards</h2>
								<Grid
									boards={list.open}
									time="updated"
									actions={actions}
									now={now}
									leaving={leaving}
								/>
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
								{searchable && (
									<label className="home-search">
										<SearchIcon />
										<span className="visually-hidden">Find a board</span>
										<input
											ref={search}
											type="search"
											placeholder="Find a board"
											aria-keyshortcuts="/"
											value={query}
											onChange={(event) => setQuery(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === "Escape" && query) {
													event.preventDefault();
													setQuery("");
												}
											}}
										/>
										{!query && (
											<kbd className="home-search-key" aria-hidden="true">
												/
											</kbd>
										)}
									</label>
								)}
								{list?.canCreate && <NewBoardButton onCreate={onCreate} creating={creating} />}
							</div>
						</div>

						{tabs.length > 1 && (
							<Tabs
								id={tabsId}
								panel={panelId}
								tabs={tabs}
								selected={tab}
								counts={lists}
								unseen={unseen.size}
								searching={searching}
								onSelect={setTab}
							/>
						)}

						<div
							id={panelId}
							role={tabs.length > 1 ? "tabpanel" : undefined}
							aria-labelledby={tabs.length > 1 ? `${tabsId}-${tab}` : undefined}
							className="home-panel"
						>
							<h2 className="visually-hidden">{searching ? "Search results" : tabLabel}</h2>
							{results ? (
								<SearchResults
									query={query.trim()}
									results={results}
									showArchived={showArchived}
									onShowArchived={() => setShowArchived(true)}
									actions={actions}
									now={now}
									unseen={unseen}
									leaving={leaving}
								/>
							) : boards.length > 0 ? (
								<Grid
									key={tab}
									boards={boards}
									time={time}
									actions={actions}
									now={now}
									unseen={unseen}
									leaving={leaving}
								/>
							) : (
								<p className="home-none">
									{guestMode
										? "No boards yet. Make the first one."
										: tab === "shared"
											? "Nothing shared with you yet."
											: "No boards here yet."}
								</p>
							)}
						</div>
					</>
				)}
			</main>
			{toasts && <Toasts store={toasts} />}
		</div>
	);
}

/** The home page's tabs: arrow keys move between them, as tabs should. */
function Tabs({
	id,
	panel,
	tabs,
	selected,
	counts,
	unseen,
	searching,
	onSelect,
}: {
	id: string;
	panel: string;
	tabs: { tab: Tab; label: string }[];
	selected: Tab;
	counts: Record<Tab, BoardInfo[]> | null;
	unseen: number;
	searching: boolean;
	onSelect: (tab: Tab) => void;
}) {
	const list = useRef<HTMLDivElement>(null);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = tabs.findIndex((t) => t.tab === selected);
		const next =
			event.key === "ArrowRight"
				? (index + 1) % tabs.length
				: event.key === "ArrowLeft"
					? (index - 1 + tabs.length) % tabs.length
					: event.key === "Home"
						? 0
						: event.key === "End"
							? tabs.length - 1
							: null;
		if (next === null) return;
		event.preventDefault();
		const tab = tabs[next];
		if (!tab) return;
		onSelect(tab.tab);
		list.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${tab.tab}`)}`)?.focus();
	};
	return (
		<div
			ref={list}
			className="home-tabs"
			role="tablist"
			aria-label="Boards"
			data-searching={searching || undefined}
			onKeyDown={onKeyDown}
		>
			{tabs.map((t) => (
				<button
					key={t.tab}
					id={`${id}-${t.tab}`}
					type="button"
					role="tab"
					aria-selected={t.tab === selected}
					aria-controls={panel}
					tabIndex={t.tab === selected ? 0 : -1}
					onClick={() => onSelect(t.tab)}
				>
					{t.label}
					<span className="home-tab-count">{counts?.[t.tab].length}</span>
					{t.tab === "shared" && unseen > 0 && (
						<span className="home-tab-new" aria-label={`${unseen} new`} role="img" />
					)}
				</button>
			))}
		</div>
	);
}

/** Every board that matches, whichever tab it's under; archived ones on request. */
function SearchResults({
	query,
	results,
	showArchived,
	onShowArchived,
	actions,
	now,
	unseen,
	leaving,
}: {
	query: string;
	results: ReturnType<typeof searchBoards>;
	showArchived: boolean;
	onShowArchived: () => void;
	actions?: TileActions;
	now?: number;
	unseen: Set<string>;
	leaving?: Set<string>;
}) {
	const archived = results.archived.length;
	const more =
		archived > 0 && !showArchived ? (
			<button type="button" className="home-more" onClick={onShowArchived}>
				Show {archived} archived {archived === 1 ? "match" : "matches"}
			</button>
		) : null;
	return (
		<>
			{results.boards.length > 0 ? (
				<>
					<p className="home-results" role="status">
						{results.boards.length === 1
							? "1 board matches"
							: `${results.boards.length} boards match`}{" "}
						“{query}”{more && <> · </>}
						{more}
					</p>
					<Grid
						boards={results.boards}
						time="updated"
						actions={actions}
						now={now}
						unseen={unseen}
						leaving={leaving}
					/>
				</>
			) : (
				<p className="home-none" role="status">
					No boards called “{query}”.
					{more && <> {more}</>}
				</p>
			)}
			{showArchived && archived > 0 && (
				<section className="home-section home-archived-results">
					<h3 className="home-section-title">Archived</h3>
					<Grid
						boards={results.archived}
						time="archived"
						actions={actions}
						now={now}
						leaving={leaving}
					/>
				</section>
			)}
		</>
	);
}

/** Before setup, access control is off: say so, and say how to finish. */
function SetupBanner({ admin }: { admin: boolean }) {
	return (
		<div className="home-setup" role="note">
			<span className="home-setup-pin" aria-hidden="true" />
			<p>
				<strong>This Tack isn’t set up yet.</strong> Until it is, anyone who can reach it can open
				and edit its boards, and whoever sets it up first becomes its admin.
			</p>
			{admin && (
				<a className="auth-button primary" href="/setup">
					Set up Tack
				</a>
			)}
		</div>
	);
}

function Grid({
	boards,
	time,
	actions,
	now,
	unseen,
	leaving,
}: {
	boards: BoardInfo[];
	time: TileTime;
	actions?: TileActions;
	now?: number;
	unseen?: Set<string>;
	leaving?: Set<string>;
}) {
	return (
		<div className="home-grid">
			{boards.map((board, i) => (
				<BoardTile
					key={board.id}
					board={board}
					time={time}
					actions={actions}
					index={i}
					now={now}
					unseen={unseen?.has(board.id)}
					leaving={leaving?.has(board.id)}
				/>
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
