import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { boardIdFromPath } from "../shared/boards.ts";
import { shapesMap, transactLocal } from "../shared/shapes.ts";
import { AccountMenu, SignInButton } from "./auth/AccountMenu.tsx";
import { personUser } from "./auth/me.ts";
import { addCard } from "./board.ts";
import { Board } from "./Board.tsx";
import { type BoardPageProps, BoardRoute, LegacyRedirect } from "./boards/BoardPage.tsx";
import { HomeRoute } from "./boards/HomePage.tsx";
import { useLiveBoard } from "./connection.ts";
import { Fps } from "./Fps.tsx";
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
	return <HomeRoute />;
}

function LiveBoard({ me, id, title, readOnly, actions, overlay, events }: BoardPageProps) {
	const source = useLiveBoard(id, events);
	// Signed in: your GitHub identity. Otherwise a remembered guest name.
	const [guest] = useState(localUser);
	const user = useMemo(() => (me.viewer ? personUser(me.viewer) : guest), [me.viewer, guest]);

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
				user={user}
				account={(label) => <AccountMenu me={me} user={user} label={label} />}
				actions={
					<>
						{actions}
						<SignInButton me={me} />
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
