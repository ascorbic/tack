import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Me } from "../../shared/auth.ts";
import {
	type BoardInfo,
	type MemberRole,
	type Role,
	type Visibility,
	boardPath,
	canEdit,
} from "../../shared/boards.ts";
import { AuthPage, NotAllowedPage, SignInPage } from "../auth/AccessGate.tsx";
import { useMe } from "../auth/me.ts";
import type { LiveBoardEvents } from "../connection.ts";
import { type Flash, setFlash, takeFlash } from "../flash.ts";
import { useLinger } from "../useLinger.ts";
import { accessDescription, accessLabel } from "./access.ts";
import { type ApiError, boardsApi, boardUrlFor, peopleApi } from "./api.ts";
import { BoardRepoList } from "./BoardRepos.tsx";
import { BoardTitle } from "./BoardTitle.tsx";
import { ArchiveIcon, EyeIcon, ShareIcon, VisibilityIcon } from "./icons.tsx";
import { BoardMenu } from "./SaveTemplate.tsx";
import { ShareDialog } from "./ShareDialog.tsx";
import type { ShareActions } from "./SharePanel.tsx";
import "./boards.css";

/** What the live board needs from the page around it. */
export interface BoardPageProps {
	me: Me;
	/** The board's id, which names its Durable Object. */
	id: string;
	/** The title in the top bar, renameable for editors. */
	title: ReactNode;
	readOnly: boolean;
	/** Why: archived, or you can only view it. */
	readOnlyReason: string;
	/** Top bar controls: Share, or a "View only" badge. */
	actions: ReactNode;
	/** Drawn over the canvas: the archived notice, and role-change toasts. */
	overlay: ReactNode;
	events: LiveBoardEvents;
	/** Just made (`?new=1`): a board from a template opens showing all of it. */
	justCreated: boolean;
}

type Load =
	| { status: "loading" }
	| { status: "ready"; board: BoardInfo }
	| { status: "error"; error: ApiError; lost?: boolean };

/**
 * `/b/{id}/{slug}`: checks the board exists and the viewer may open it,
 * then hands over to the live board. Signed-out visitors to a board that
 * isn't public are asked to sign in; others without access get a polite
 * dead end.
 */
export function BoardRoute({
	id,
	children,
}: {
	id: string;
	children: (props: BoardPageProps) => ReactNode;
}) {
	const me = useMe();
	const [load, setLoad] = useState<Load>({ status: "loading" });
	const [justCreated] = useState(() => new URLSearchParams(location.search).has("new"));

	const fetchBoard = useCallback(async () => {
		const result = await boardsApi.get(id);
		setLoad((current) =>
			result.ok
				? { status: "ready", board: result.value }
				: // Had it open, and now can't: say so, rather than that it was never yours.
					{ status: "error", error: result.error, lost: current.status === "ready" },
		);
	}, [id]);

	useEffect(() => {
		void fetchBoard();
	}, [fetchBoard]);

	const board = load.status === "ready" ? load.board : null;
	const setBoard = useCallback((next: BoardInfo | ((board: BoardInfo) => BoardInfo)) => {
		setLoad((current) =>
			current.status === "ready"
				? { status: "ready", board: typeof next === "function" ? next(current.board) : next }
				: current,
		);
	}, []);

	// Keep the address canonical (old slugs, `?new=1`), and the tab titled.
	useEffect(() => {
		if (!board) return;
		const params = new URLSearchParams(location.search);
		params.delete("new");
		const search = params.toString();
		const canonical = `${boardPath(board)}${search ? `?${search}` : ""}${location.hash}`;
		if (canonical !== location.pathname + location.search + location.hash) {
			history.replaceState(history.state, "", canonical);
		}
		document.title = `${board.title} · Tack`;
	}, [board]);

	if (me.status === "loading" || load.status === "loading") {
		return <div className="app" aria-busy="true" />;
	}
	if (load.status === "error") {
		return <BoardErrorPage me={me.me} error={load.error} lost={load.lost} />;
	}
	return (
		<LoadedBoard
			me={me.me}
			board={load.board}
			setBoard={setBoard}
			justCreated={justCreated}
			onRevoked={() => void fetchBoard()}
		>
			{children}
		</LoadedBoard>
	);
}

/** Something to say over the canvas for a moment: your role changed, or why. */
type Notice = { at: number } & (
	| { kind: "role"; role: Role }
	| { kind: "archived"; by: string | null }
	| { kind: "flash"; flash: Flash }
);

function LoadedBoard({
	me,
	board,
	setBoard,
	justCreated,
	onRevoked,
	children,
}: {
	me: Me;
	board: BoardInfo;
	setBoard: (next: BoardInfo | ((board: BoardInfo) => BoardInfo)) => void;
	justCreated: boolean;
	onRevoked: () => void;
	children: (props: BoardPageProps) => ReactNode;
}) {
	const [sharing, setSharing] = useState(false);
	// "Signed out", say, from the page before this one.
	const [notice, setNotice] = useState<Notice | null>(() => {
		const flash = takeFlash();
		return flash ? { kind: "flash", flash, at: Date.now() } : null;
	});
	const editable = canEdit(board.role);
	const archivedRef = useRef(board.archivedAt !== null);
	archivedRef.current = board.archivedAt !== null;

	const rename = useCallback(
		async (title: string) => {
			const previous = board;
			setBoard((current) => ({ ...current, title }));
			const result = await boardsApi.update(board.id, { title });
			if (!result.ok) {
				setBoard(previous);
				throw new Error(result.error);
			}
			setBoard((current) => ({ ...current, title: result.value.title, slug: result.value.slug }));
		},
		[board, setBoard],
	);

	const events = useMemo<LiveBoardEvents>(
		() => ({
			onRole: (role) => {
				setBoard((current) => ({ ...current, role }));
				const wasArchived = archivedRef.current;
				// Ownership and archiving can change too: catch up, then say
				// which it was, so an archive doesn't read as a demotion.
				void boardsApi.get(board.id).then((result) => {
					if (result.ok) setBoard(result.value);
					const archived = result.ok && result.value.archivedAt !== null && !wasArchived;
					setNotice(
						archived
							? {
									kind: "archived",
									by: result.value.owner?.name || result.value.owner?.login || null,
									at: Date.now(),
								}
							: { kind: "role", role, at: Date.now() },
					);
				});
			},
			onRenamed: (title, slug) => setBoard((current) => ({ ...current, title, slug })),
			onRevoked,
		}),
		[board.id, setBoard, onRevoked],
	);

	const link = boardUrlFor(board);
	const signedIn = me.viewer !== null;
	const shareActions = useMemo<ShareActions>(
		() => ({
			members: () => boardsApi.members(board.id),
			invite: (logins, role) => boardsApi.invite(board.id, { logins, role }),
			setRole: (login, role) => boardsApi.setRole(board.id, login, role),
			remove: (login) => boardsApi.remove(board.id, login),
			update: (request) => boardsApi.update(board.id, request),
			...(signedIn ? { lookup: peopleApi.lookup, suggest: peopleApi.suggest } : {}),
			link,
		}),
		[board.id, link, signedIn],
	);

	const archived = board.archivedAt !== null;
	const canShare = me.viewer !== null || board.canManage;
	const actions = (
		<>
			{!editable && !archived && <ViewOnlyBadge />}
			{canShare && <ShareButton visibility={board.visibility} onClick={() => setSharing(true)} />}
			<ShareDialog
				open={sharing}
				onClose={() => setSharing(false)}
				board={board}
				me={me.viewer}
				actions={shareActions}
				onBoard={setBoard}
				setupPending={me.signIn === "unconfigured"}
				repos={editable ? <BoardRepoList returnTo={boardPath(board)} /> : undefined}
				onLeft={() => {
					setFlash({ message: `You left “${board.title}”` });
					location.assign("/");
				}}
			/>
		</>
	);

	const overlay = (
		<>
			{archived && <ArchivedNotice board={board} onRestore={setBoard} />}
			<NoticeToast notice={notice} />
		</>
	);

	return children({
		me,
		id: board.id,
		title: (
			<>
				<BoardTitle
					title={board.title}
					editable={editable}
					onRename={rename}
					startEditing={justCreated}
				/>
				<AccessChip
					visibility={board.visibility}
					instanceRole={board.instanceRole}
					onClick={canShare ? () => setSharing(true) : undefined}
				/>
				<BoardMenu
					board={board}
					canSaveTemplate={editable && (me.viewer !== null || me.signIn !== "ready")}
					canBackup={board.role === "owner" && me.viewer !== null}
				/>
			</>
		),
		readOnly: !editable || archived,
		readOnlyReason: archived
			? "This board is archived, so it’s read-only"
			: "You can view this board, but not edit it. Ask its owner if you need to.",
		actions,
		overlay,
		events,
		justCreated,
	});
}

/** The top bar's Share button: its icon says who can open the board. */
export function ShareButton({
	visibility,
	onClick,
}: {
	visibility: Visibility;
	onClick?: () => void;
}) {
	return (
		<button
			type="button"
			className="share-button"
			data-visibility={visibility}
			data-tooltip="Invite people, and choose who can open it"
			data-tooltip-align="end"
			onClick={onClick}
		>
			{visibility === "private" ? <ShareIcon /> : <VisibilityIcon visibility={visibility} />}
			<span className="share-label">Share</span>
		</button>
	);
}

/**
 * Who can open the board, in a few words beside its title, so nobody's
 * surprised who can edit it. Opens Share, for those who can.
 */
export function AccessChip({
	visibility,
	instanceRole,
	onClick,
}: {
	visibility: Visibility;
	instanceRole: MemberRole;
	onClick?: () => void;
}) {
	const label = accessLabel(visibility, instanceRole);
	const description = accessDescription(visibility, instanceRole);
	const content = (
		<>
			<VisibilityIcon visibility={visibility} size={14} />
			<span className="access-chip-label">{label}</span>
		</>
	);
	return onClick ? (
		<button
			type="button"
			className="access-chip"
			data-visibility={visibility}
			data-tooltip={description}
			aria-label={`${description}. Change who can open it`}
			onClick={onClick}
		>
			{content}
		</button>
	) : (
		<span
			className="access-chip"
			data-visibility={visibility}
			data-tooltip={description}
			role="img"
			aria-label={description}
		>
			{content}
		</span>
	);
}

export function ViewOnlyBadge() {
	return (
		<span className="view-only" data-tooltip="You can look around and comment, but not change it">
			<EyeIcon />
			View only
		</span>
	);
}

/** An archived board is read-only; its owner can bring it back. */
export function ArchivedNotice({
	board,
	onRestore,
}: {
	board: BoardInfo;
	onRestore: (board: BoardInfo) => void;
}) {
	const [busy, setBusy] = useState(false);
	return (
		<div className="board-notice" role="status">
			<ArchiveIcon />
			<span>This board is archived, so it’s read-only.</span>
			{board.canManage && (
				<button
					type="button"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						const result = await boardsApi.update(board.id, { archived: false });
						setBusy(false);
						if (result.ok) {
							onRestore(result.value);
							// Reconnect with edit access.
							location.reload();
						}
					}}
				>
					{busy ? "Restoring…" : "Restore"}
				</button>
			)}
		</div>
	);
}

/** "You can edit now", "Matt archived this board": a toast over the canvas for a moment. */
function NoticeToast({ notice }: { notice: Notice | null }) {
	const [current, setCurrent] = useState(notice);
	useEffect(() => {
		setCurrent(notice);
		if (!notice) return;
		const timer = setTimeout(() => setCurrent(null), notice.kind === "role" ? 3200 : 4800);
		return () => clearTimeout(timer);
	}, [notice]);
	const shown = useLinger(current, 240);
	if (!shown.value) return null;
	const value = shown.value;
	if (value.kind === "role") {
		return <RoleToastView key={value.at} role={value.role} leaving={shown.leaving} />;
	}
	return (
		<div key={value.at} className="role-toast" role="status" data-leaving={shown.leaving}>
			{value.kind === "archived" ? (
				<>
					<ArchiveIcon />
					{value.by ? `${value.by} archived this board.` : "This board was archived."} It’s
					read-only now.
				</>
			) : (
				value.flash.message
			)}
		</div>
	);
}

export function RoleToastView({ role, leaving = false }: { role: Role; leaving?: boolean }) {
	return (
		<div className="role-toast" role="status" data-leaving={leaving}>
			{canEdit(role) ? (
				<>
					<span aria-hidden="true">✦</span>
					You can edit this board now
				</>
			) : (
				<>
					<EyeIcon />
					You can view this board, but not edit it
				</>
			)}
		</div>
	);
}

const OFFLINE = {
	title: "Couldn’t reach Tack",
	lede: "Check your connection, then try again.",
};

const ERRORS: Partial<Record<ApiError, { title: string; lede: string }>> = {
	not_found: {
		title: "This board isn’t here",
		lede: "It may have been moved, or the link is missing a bit. Your other boards are on the home page.",
	},
	forbidden: {
		title: "You don’t have access to this board",
		lede: "It’s only open to the people it’s shared with. Ask its owner to invite you.",
	},
};

/** Access went while the board was open. */
const LOST = {
	title: "You no longer have access to this board",
	lede: "Its owner changed who can open it while you were here. Ask them to invite you if you need it again.",
};

export function BoardErrorPage({
	me,
	error,
	lost = false,
}: {
	me: Me;
	error: ApiError;
	/** They had it open, and lost access. */
	lost?: boolean;
}) {
	if (error === "sign_in_required" && !lost) {
		return <SignInPage me={me} />;
	}
	// Signed in but not on the instance's allowlist: say so, rather than blame the board.
	if (error === "forbidden" && me.viewer && !me.allowed) return <NotAllowedPage me={me} />;
	const copy =
		lost && (error === "forbidden" || error === "sign_in_required" || error === "not_found")
			? LOST
			: (ERRORS[error] ?? OFFLINE);
	return (
		<AuthPage>
			<div className="board-missing-art" aria-hidden="true">
				<span className="home-empty-note" data-color="pink" />
				<span className="home-empty-pin" />
			</div>
			<h1>{copy.title}</h1>
			<p className="auth-lead">
				{copy.lede}
				{error === "forbidden" && me.viewer && (
					<>
						{" "}
						You’re signed in as <strong>@{me.viewer.login}</strong>.
					</>
				)}
			</p>
			<div className="auth-actions">
				<a className="auth-button primary" href="/">
					All boards
				</a>
				{error === "offline" && (
					<button type="button" className="auth-button" onClick={() => location.reload()}>
						Try again
					</button>
				)}
			</div>
		</AuthPage>
	);
}

/** Any other address: say so, with the way home, rather than show home at the wrong URL. */
export function NotFoundPage() {
	const me = useMe();
	useEffect(() => {
		document.title = "Not found · Tack";
	}, []);
	if (me.status === "loading") return <div className="app" aria-busy="true" />;
	return (
		<AuthPage>
			<div className="board-missing-art" aria-hidden="true">
				<span className="home-empty-note" data-color="blue" />
				<span className="home-empty-pin" />
			</div>
			<h1>This page isn’t here</h1>
			<p className="auth-lead">
				There’s nothing at <code>{location.pathname}</code>. Boards live at links like{" "}
				<code>/b/…</code>, and all of yours are on the home page.
			</p>
			<div className="auth-actions">
				<a className="auth-button primary" href="/">
					All boards
				</a>
			</div>
		</AuthPage>
	);
}

/**
 * `/?board=name`, from before boards had ids: find or adopt the board, then
 * go to its real address. Extra parameters (like `stress`) come along.
 */
export function LegacyRedirect({ name }: { name: string }) {
	const me = useMe();
	const [error, setError] = useState<ApiError | null>(null);
	useEffect(() => {
		void boardsApi.claimLegacy(name).then((result) => {
			if (!result.ok) {
				setError(result.error);
				return;
			}
			const params = new URLSearchParams(location.search);
			params.delete("board");
			const search = params.toString();
			location.replace(`${boardPath(result.value)}${search ? `?${search}` : ""}`);
		});
	}, [name]);
	if (error && me.status === "ready") return <BoardErrorPage me={me.me} error={error} />;
	return <div className="app" aria-busy="true" />;
}
