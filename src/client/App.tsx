import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { boardIdFromPath, isHomePath } from "../shared/boards.ts";
import { shapesMap, transactLocal } from "../shared/shapes.ts";
import { AccountMenu, SignInButton } from "./auth/AccountMenu.tsx";
import { personUser } from "./auth/me.ts";
import { addCard } from "./board.ts";
import { Board } from "./Board.tsx";
import { type Operation, stageChange } from "../shared/changes.ts";
import { pushApi } from "./changes/api.ts";
import { stagerFor } from "./changes/context.ts";
import {
	type BoardPageProps,
	BoardRoute,
	LegacyRedirect,
	NotFoundPage,
} from "./boards/BoardPage.tsx";
import { HomeRoute } from "./boards/HomePage.tsx";
import { NotificationsButton } from "./comments/Notifications.tsx";
import { commentStore } from "./comments/store.ts";
import { sinceStore } from "./since/store.ts";
import { useLiveBoard } from "./connection.ts";
import { Fps } from "./Fps.tsx";
import { liveHistory } from "./history/source.ts";
import { localUser } from "./presence.ts";

const params = new URLSearchParams(location.search);
const stressCount = Number(params.get("stress") ?? 0);

/**
 * `/b/{id}/{slug}` opens a board (checking access first); `/` is the home
 * page, or, with `?board=name` from before boards had ids, a redirect.
 */
export function App() {
	const id = boardIdFromPath(location.pathname);
	if (id) return <BoardRoute id={id}>{(page) => <LiveBoard {...page} />}</BoardRoute>;
	const legacy = params.get("board");
	if (legacy) return <LegacyRedirect name={legacy} />;
	if (!isHomePath(location.pathname)) return <NotFoundPage />;
	return <HomeRoute />;
}

function LiveBoard({
	me,
	id,
	title,
	readOnly,
	readOnlyReason,
	actions,
	overlay,
	events,
}: BoardPageProps) {
	const source = useLiveBoard(id, events);
	// Signed in: your GitHub identity. Otherwise a remembered guest name.
	const [guest] = useState(localUser);
	const user = useMemo(() => (me.viewer ? personUser(me.viewer) : guest), [me.viewer, guest]);
	const push = useMemo(() => pushApi(id), [id]);
	const history = useMemo(() => liveHistory(id), [id]);

	// Development only: stage changes from the console, e.g. to try a push
	// against the fake forge before there's UI for every kind.
	//   tackBoard.stage({ kind: "issue.create", repo: "fake.tack/demo/app", title: "Hi" })
	useEffect(() => {
		if (!import.meta.env.DEV) return;
		Object.assign(window, {
			tackBoard: {
				doc: source.doc,
				awareness: source.awareness,
				comments: commentStore,
				since: sinceStore,
				stage: (op: Operation, options?: Parameters<typeof stageChange>[3]) =>
					stageChange(source.doc, op, stagerFor(user), options),
			},
		});
	}, [source.doc, source.awareness, user]);

	// Stress mode: fill an empty board with synthetic cards once synced.
	useEffect(() => {
		const { doc, synced } = source;
		if (readOnly || !synced || stressCount <= 0 || shapesMap(doc).size > 0) return;
		const columns = Math.ceil(Math.sqrt(stressCount));
		transactLocal(doc, () => {
			for (let i = 0; i < stressCount; i++) {
				addCard(doc, `fake.tack/stress/cards#${i + 1}`, {
					x: (i % columns) * 280,
					y: Math.floor(i / columns) * 220,
				});
			}
		});
	}, [source, readOnly]);

	return (
		<ReactFlowProvider>
			<Board
				name={id}
				title={title}
				readOnly={readOnly}
				readOnlyReason={readOnlyReason}
				// Everyone opening a board sees all of it, or where they left it.
				fitOnLoad
				rememberView={id}
				user={user}
				push={push}
				historySource={history}
				account={(label, here) => <AccountMenu me={me} user={here} label={label} />}
				inbox={me.viewer && <NotificationsButton boardId={id} />}
				actions={
					<>
						<SignInButton me={me} />
						{actions}
					</>
				}
				{...source}
			>
				{stressCount > 0 && <Fps />}
				{overlay}
			</Board>
		</ReactFlowProvider>
	);
}
