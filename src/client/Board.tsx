import {
	Background,
	BackgroundVariant,
	Controls,
	MiniMap,
	type OnNodesChange,
	ReactFlow,
	useReactFlow,
} from "@xyflow/react";
import {
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { itemKey, parseRef } from "../shared/refs.ts";
import { type ShapeNode, addCard, addSticky, applyNodeChanges, useShapeNodes } from "./board.ts";
import type { BoardSource } from "./connection.ts";
import { Cursors } from "./Cursors.tsx";
import { DocContext, nodeTypes } from "./nodes.tsx";
import { type User, usePresence } from "./presence.ts";

interface BoardProps extends BoardSource {
	name: string;
	user: User;
	/** Extra UI drawn over the canvas, e.g. the playground's controls. */
	children?: ReactNode;
}

export function Board({ name, doc, awareness, synced, user, children }: BoardProps) {
	const shapeNodes = useShapeNodes(doc);
	const flow = useReactFlow();
	const presence = usePresence(awareness, user);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [measured, setMeasured] = useState<Map<string, { width: number; height: number }>>(
		() => new Map(),
	);

	// Selection, measured sizes and in-progress drags are local UI state, so
	// they live outside the document. Unchanged nodes keep their identity so
	// React Flow's memoised nodes skip re-rendering.
	const merged = useRef(new Map<string, { base: ShapeNode; out: ShapeNode }>());
	const nodes = useMemo(
		() =>
			shapeNodes.map((base) => {
				const isSelected = selected.has(base.id);
				const size = measured.get(base.id);
				const drag = presence.overrides.get(base.id);
				const position = drag ? { x: drag.x, y: drag.y } : base.position;
				const remoteColor = drag?.user?.color;
				const cached = merged.current.get(base.id)?.out;
				if (
					cached &&
					merged.current.get(base.id)?.base === base &&
					cached.selected === isSelected &&
					cached.measured === size &&
					cached.position.x === position.x &&
					cached.position.y === position.y &&
					cached.className === (remoteColor ? "remote-drag" : undefined)
				) {
					return cached;
				}
				const out: ShapeNode = {
					...base,
					selected: isSelected,
					measured: size,
					position,
					className: remoteColor ? "remote-drag" : undefined,
					// Shapes being dragged float above everything else.
					zIndex: drag ? 1000 : base.zIndex,
					style: remoteColor ? ({ "--drag-color": remoteColor } as React.CSSProperties) : undefined,
				};
				merged.current.set(base.id, { base, out });
				return out;
			}),
		[shapeNodes, selected, measured, presence.overrides],
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
						if (change.type === "dimensions" && change.dimensions) {
							next.set(change.id, change.dimensions);
						}
					}
					return next;
				});
			}
			presence.onPositionChanges(changes);
			applyNodeChanges(doc, changes, presence.lastDragPosition);
		},
		[doc, presence],
	);

	const centre = useCallback(
		() =>
			flow.screenToFlowPosition({ x: window.innerWidth / 2 - 120, y: window.innerHeight / 2 - 60 }),
		[flow],
	);

	// Paste an issue or PR URL anywhere to add a card.
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
					<span className="brand">
						<span className="brand-mark" aria-hidden="true" />
						tack
					</span>
					<span className="board-name">{name}</span>
					<form className="add-card" onSubmit={onAddCard}>
						<label htmlFor="ref" className="visually-hidden">
							Issue or pull request
						</label>
						<input
							id="ref"
							value={refInput}
							aria-invalid={refError}
							onChange={(event) => {
								setRefInput(event.target.value);
								setRefError(false);
							}}
							placeholder="owner/repo#123 or paste a URL"
						/>
						<button type="submit" className="primary">
							Add card
						</button>
					</form>
					<button type="button" onClick={() => addSticky(doc, centre())}>
						Add sticky
					</button>
					<span className="people" aria-label="People here">
						<span
							className="avatar"
							style={{ "--avatar": user.color } as React.CSSProperties}
							title={`${user.name} (you)`}
						>
							{initials(user.name)}
						</span>
						{presence.people.map((person) => (
							<span
								key={person.clientId}
								className="avatar"
								style={{ "--avatar": person.user.color } as React.CSSProperties}
								title={person.user.name}
							>
								{initials(person.user.name)}
							</span>
						))}
					</span>
					<span className="status" data-synced={synced}>
						{synced ? "Synced" : "Connecting…"}
					</span>
				</header>
				<main
					className="canvas"
					onPointerMove={(event) =>
						presence.setCursor(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
					}
					onPointerLeave={() => presence.setCursor(null)}
				>
					<ReactFlow
						nodes={nodes}
						nodeTypes={nodeTypes}
						onNodesChange={onNodesChange}
						onlyRenderVisibleElements
						minZoom={0.1}
						deleteKeyCode={["Backspace", "Delete"]}
					>
						<Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
						<Controls showInteractive={false} />
						<MiniMap pannable zoomable />
						<Cursors people={presence.people} />
					</ReactFlow>
					{children}
				</main>
			</div>
		</DocContext>
	);
}

function initials(name: string): string {
	return name
		.split(/\s+/)
		.map((word) => word[0] ?? "")
		.join("")
		.slice(0, 2)
		.toUpperCase();
}
