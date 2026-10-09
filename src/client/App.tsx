import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import type { Me } from "../shared/auth.ts";
import { shapesMap } from "../shared/shapes.ts";
import { AccessGate } from "./auth/AccessGate.tsx";
import { AccountMenu, SignInButton } from "./auth/AccountMenu.tsx";
import { personUser } from "./auth/me.ts";
import { addCard } from "./board.ts";
import { Board } from "./Board.tsx";
import { useLiveBoard } from "./connection.ts";
import { Fps } from "./Fps.tsx";
import { localUser } from "./presence.ts";

const params = new URLSearchParams(location.search);
const boardName = params.get("board") ?? "demo";
const stressCount = Number(params.get("stress") ?? 0);

export function App() {
	// Boards only connect once we know the viewer may use this instance.
	return <AccessGate>{(me) => <LiveBoard me={me} />}</AccessGate>;
}

function LiveBoard({ me }: { me: Me }) {
	const source = useLiveBoard(boardName);
	// Signed in: your GitHub identity. Otherwise a remembered guest name.
	const [guest] = useState(localUser);
	const user = useMemo(() => (me.viewer ? personUser(me.viewer) : guest), [me.viewer, guest]);

	// Stress mode: fill an empty board with synthetic cards once synced.
	useEffect(() => {
		const { doc, synced } = source;
		if (!synced || stressCount <= 0 || shapesMap(doc).size > 0) return;
		const columns = Math.ceil(Math.sqrt(stressCount));
		doc.transact(() => {
			for (let i = 0; i < stressCount; i++) {
				addCard(doc, `fake.tack/stress/cards#${i + 1}`, {
					x: (i % columns) * 280,
					y: Math.floor(i / columns) * 220,
				});
			}
		});
	}, [source]);

	return (
		<ReactFlowProvider>
			<Board
				name={boardName}
				user={user}
				account={(label) => <AccountMenu me={me} user={user} label={label} />}
				actions={<SignInButton me={me} />}
				{...source}
			>
				{stressCount > 0 && <Fps />}
			</Board>
		</ReactFlowProvider>
	);
}
