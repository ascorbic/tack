import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { Me } from "../../shared/auth.ts";
import { type BoardInfo, type Role, boardPath, canEdit } from "../../shared/boards.ts";
import { AuthPage, NotAllowedPage, SignInPage } from "../auth/AccessGate.tsx";
import { useMe } from "../auth/me.ts";
import type { LiveBoardEvents } from "../connection.ts";
import { useLinger } from "../useLinger.ts";
import { type ApiError, boardsApi, boardUrlFor } from "./api.ts";
import { BoardTitle } from "./BoardTitle.tsx";
import { ArchiveIcon, EyeIcon, ShareIcon, VisibilityIcon } from "./icons.tsx";
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
	/** Top bar controls: Share, or a "View only" badge. */
	actions: ReactNode;
	/** Drawn over the canvas: the archived notice, and role-change toasts. */
	overlay: ReactNode;
	events: LiveBoardEvents;
}

type Load =
	| { status: "loading" }
	| { status: "ready"; board: BoardInfo }
	| { status: "error"; error: ApiError };

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
		setLoad(
			result.ok
				? { status: "ready", board: result.value }
				: { status: "error", error: result.error },
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
	if (load.status === "error") return <BoardErrorPage me={me.me} error={load.error} />;
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
	const [toast, setToast] = useState<{ role: Role; at: number } | null>(null);
	const editable = canEdit(board.role);

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
				setToast({ role, at: Date.now() });
				// Ownership and archiving can change too; catch up quietly.
				void boardsApi.get(board.id).then((result) => {
					if (result.ok) setBoard(result.value);
				});
			},
			onRenamed: (title, slug) => setBoard((current) => ({ ...current, title, slug })),
			onRevoked,
		}),
		[board.id, setBoard, onRevoked],
	);

	const link = boardUrlFor(board);
	const shareActions = useMemo<ShareActions>(
		() => ({
			members: () => boardsApi.members(board.id),
			invite: (logins, role) => boardsApi.invite(board.id, { logins, role }),
			setRole: (login, role) => boardsApi.setRole(board.id, login, role),
			remove: (login) => boardsApi.remove(board.id, login),
			update: (request) => boardsApi.update(board.id, request),
			link,
		}),
		[board.id, link],
	);

	const archived = board.archivedAt !== null;
	const actions = (
		<>
			{!editable && !archived && <ViewOnlyBadge />}
			{(me.viewer || board.canManage) && (
				<button
					type="button"
					className="share-button"
					data-visibility={board.visibility}
					onClick={() => setSharing(true)}
				>
					{board.visibility === "private" ? (
						<ShareIcon />
					) : (
						<VisibilityIcon visibility={board.visibility} />
					)}
					Share
				</button>
			)}
			<ShareDialog
				open={sharing}
				onClose={() => setSharing(false)}
				board={board}
				me={me.viewer}
				actions={shareActions}
				onBoard={setBoard}
				onLeft={() => location.assign("/")}
			/>
		</>
	);

	const overlay = (
		<>
			{archived && <ArchivedNotice board={board} onRestore={setBoard} />}
			<RoleToast toast={toast} />
		</>
	);

	return children({
		me,
		id: board.id,
		title: (
			<BoardTitle
				title={board.title}
				editable={editable}
				onRename={rename}
				startEditing={justCreated}
			/>
		),
		readOnly: !editable,
		actions,
		overlay,
		events,
	});
}

export function ViewOnlyBadge() {
	return (
		<span className="view-only" title="You can look around and chat, but not change this board">
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

/** "You can edit now": a toast when someone changes your role while you're here. */
function RoleToast({ toast }: { toast: { role: Role; at: number } | null }) {
	const [current, setCurrent] = useState(toast);
	useEffect(() => {
		setCurrent(toast);
		if (!toast) return;
		const timer = setTimeout(() => setCurrent(null), 3200);
		return () => clearTimeout(timer);
	}, [toast]);
	const shown = useLinger(current, 240);
	if (!shown.value) return null;
	return <RoleToastView key={shown.value.at} role={shown.value.role} leaving={shown.leaving} />;
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

export function BoardErrorPage({ me, error }: { me: Me; error: ApiError }) {
	if (error === "sign_in_required") {
		return <SignInPage me={me} />;
	}
	// Signed in but not on the instance's allowlist: say so, rather than blame the board.
	if (error === "forbidden" && me.viewer && !me.allowed) return <NotAllowedPage me={me} />;
	const copy = ERRORS[error] ?? OFFLINE;
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
