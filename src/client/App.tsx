import {
	Background,
	BackgroundVariant,
	Controls,
	MiniMap,
	type OnNodesChange,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
} from "@xyflow/react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { itemKey, parseRef } from "../shared/refs.ts";
import { shapesMap } from "../shared/shapes.ts";
import {
	type ShapeNode,
	addCard,
	addSticky,
	applyNodeChanges,
	useDragOverrides,
	useBoardConnection,
	useShapeNodes,
} from "./board.ts";
import { Fps } from "./Fps.tsx";
import { DocContext, nodeTypes } from "./nodes.tsx";

const params = new URLSearchParams(location.search);
const boardName = params.get("board") ?? "demo";
const stressCount = Number(params.get("stress") ?? 0);

export function App() {
	return (
		<ReactFlowProvider>
			<Board />
		</ReactFlowProvider>
	);
}

function Board() {
	const { doc, provider } = useBoardConnection(boardName);
	const shapeNodes = useShapeNodes(doc);
	const flow = useReactFlow();
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(
		new Map(),
	);
	const [synced, setSynced] = useState(false);
	const drags = useDragOverrides(provider);

	useEffect(() => {
		const onSync = (isSynced: boolean) => setSynced(isSynced);
		provider.on("sync", onSync);
		return () => provider.off("sync", onSync);
	}, [provider]);

	// Stress mode: fill an empty board with synthetic cards once synced.
	useEffect(() => {
		if (!synced || stressCount <= 0 || shapesMap(doc).size > 0) return;
		const columns = Math.ceil(Math.sqrt(stressCount));
		doc.transact(() => {
			for (let i = 0; i < stressCount; i++) {
				addCard(doc, `fake.tack/stress/cards#${i + 1}`, {
					x: (i % columns) * 260,
					y: Math.floor(i / columns) * 200,
				});
			}
		});
	}, [synced, doc]);

	// Selection, measured sizes and in-progress drags are local UI state, so
	// they live outside the document. Unchanged nodes keep their identity for memoisation.
	const merged = useRef(new Map<string, { base: ShapeNode; out: ShapeNode }>());
	const nodes = useMemo(
		() =>
			shapeNodes.map((base) => {
				const isSelected = selected.has(base.id);
				const size = measured.get(base.id);
				const position = drags.overrides.get(base.id) ?? base.position;
				const cached = merged.current.get(base.id);
				if (
					cached &&
					cached.base === base &&
					cached.out.selected === isSelected &&
					cached.out.measured === size &&
					cached.out.position === position
				) {
					return cached.out;
				}
				const out = { ...base, selected: isSelected, measured: size, position };
				merged.current.set(base.id, { base, out });
				return out;
			}),
		[shapeNodes, selected, measured, drags.overrides],
	);

	const onNodesChange: OnNodesChange<ShapeNode> = useCallback(
		(changes) => {
			const selection = changes.filter((change) => change.type === "select");
			if (selection.length > 0) {
				setSelected((current) => {
					const next = new Set(current);
					for (const change of selection) {
						if (change.selected) next.add(change.id);
						else next.delete(change.id);
					}
					return next;
				});
			}
			const sizes = changes.filter((change) => change.type === "dimensions" && change.dimensions);
			if (sizes.length > 0) {
				setMeasured((current) => {
					const next = new Map(current);
					for (const change of sizes) {
						if (change.type === "dimensions" && change.dimensions)
							next.set(change.id, change.dimensions);
					}
					return next;
				});
			}
			drags.onPositionChanges(changes);
			applyNodeChanges(doc, changes, drags.lastDragPosition);
		},
		[doc, drags],
	);

	const centre = useCallback(() => {
		const { x, y, zoom } = flow.getViewport();
		return {
			x: Math.round((window.innerWidth / 2 - x) / zoom - 120),
			y: Math.round((window.innerHeight / 2 - y) / zoom - 60),
		};
	}, [flow]);

	// Paste a GitHub issue/PR URL anywhere to add a card.
	useEffect(() => {
		const onPaste = (event: ClipboardEvent) => {
			if ((event.target as HTMLElement | null)?.closest("textarea, input")) return;
			const ref = parseRef(event.clipboardData?.getData("text") ?? "");
			if (!ref) return;
			event.preventDefault();
			addCard(doc, itemKey(ref), centre());
		};
		window.addEventListener("paste", onPaste);
		return () => window.removeEventListener("paste", onPaste);
	}, [doc, centre]);

	const [refInput, setRefInput] = useState("");
	const [refError, setRefError] = useState(false);
	const onAddCard = (event: FormEvent) => {
		event.preventDefault();
		const ref = parseRef(refInput);
		if (!ref) {
			setRefError(true);
			return;
		}
		addCard(doc, itemKey(ref), centre());
		setRefInput("");
		setRefError(false);
	};

	return (
		<DocContext value={doc}>
			<div className="app">
				<header className="topbar">
					<strong className="brand">Tack</strong>
					<span className="muted">/ {boardName}</span>
					<form className="add-card" onSubmit={onAddCard}>
						<label htmlFor="ref" className="visually-hidden">
							GitHub issue or PR
						</label>
						<input
							id="ref"
							value={refInput}
							aria-invalid={refError}
							onChange={(event) => setRefInput(event.target.value)}
							placeholder="owner/repo#123 or paste an issue or PR URL"
						/>
						<button type="submit">Add card</button>
					</form>
					<button type="button" onClick={() => addSticky(doc, centre())}>
						Add sticky
					</button>
					<span className="status" data-synced={synced}>
						{synced ? `${nodes.length} shapes · synced` : "Connecting…"}
					</span>
				</header>
				<main className="canvas">
					<ReactFlow
						nodes={nodes}
						nodeTypes={nodeTypes}
						onNodesChange={onNodesChange}
						onlyRenderVisibleElements
						minZoom={0.1}
						deleteKeyCode={["Backspace", "Delete"]}
						proOptions={{ hideAttribution: false }}
					>
						<Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
						<Controls />
						<MiniMap pannable zoomable />
					</ReactFlow>
					{stressCount > 0 && <Fps />}
				</main>
			</div>
		</DocContext>
	);
}
