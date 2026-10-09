import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useState } from "react";
import { shapesMap } from "../shared/shapes.ts";
import { addCard } from "./board.ts";
import { Board } from "./Board.tsx";
import { useLiveBoard } from "./connection.ts";
import { Fps } from "./Fps.tsx";
import { localUser } from "./presence.ts";

const params = new URLSearchParams(location.search);
const boardName = params.get("board") ?? "demo";
const stressCount = Number(params.get("stress") ?? 0);

export function App() {
	const source = useLiveBoard(boardName);
	const [user] = useState(localUser);

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
			<Board name={boardName} user={user} {...source}>
				{stressCount > 0 && <Fps />}
			</Board>
		</ReactFlowProvider>
	);
}
