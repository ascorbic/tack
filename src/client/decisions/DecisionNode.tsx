import { type NodeProps, useReactFlow, useStoreApi } from "@xyflow/react";
import { type MouseEvent, memo, useContext, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { recordNumber, padNumber } from "../../shared/adr.ts";
import { type PendingChange, unstageChanges } from "../../shared/changes.ts";
import { withFallbacks } from "../../shared/connectors.ts";
import {
	addDecision,
	castVote,
	linkWrittenDecisions,
	linkedItems,
	otherDecisions,
	setDecisionStatus,
	statusOf,
	tally,
	voterKey,
	writeBackOf,
} from "../../shared/decisions.ts";
import { boxOf } from "../../shared/sections.ts";
import {
	type DecisionStatus,
	type ShapeProps,
	type VoteChoice,
	readShape,
	shapesMap,
} from "../../shared/shapes.ts";
import { addConnector, placeInSections } from "../../shared/structure.ts";
import { focusWhenMounted, isFresh, type ShapeNode, takeFocus } from "../board.ts";
import { DocContext, ReadOnlyContext, SectionContext } from "../DocContext.ts";
import { scaledDuration } from "../motion.ts";
import { transactLocal } from "../undo.ts";
import { useEditing } from "../useEditing.ts";
import { DecisionContext } from "./context.ts";
import { type DecisionField, DecisionView, type WriteBackView } from "./DecisionView.tsx";
import { useDocValue } from "./useDocValue.ts";
import { WriteBackDialog } from "./WriteBackDialog.tsx";

/** Where a new decision goes relative to the one it supersedes. */
const SUCCESSOR_GAP = 96;

/** Cards linked to a decision, reading only connectors and cards. */
function readLinked(doc: Y.Doc, id: string): string[] {
	const shapes = new Map<string, ShapeProps>();
	for (const [other, shape] of shapesMap(doc)) {
		const type = shape.get("type");
		if (type === "connector") {
			shapes.set(other, { type, from: shape.get("from"), to: shape.get("to") } as ShapeProps);
		} else if (type === "card") {
			shapes.set(other, { type, ref: shape.get("ref") } as ShapeProps);
		}
	}
	return linkedItems(shapes, id);
}

/** Other decisions, for the menu, reading only decisions. */
function readOthers(doc: Y.Doc, id: string) {
	const shapes = new Map<string, ShapeProps>();
	for (const [other, shape] of shapesMap(doc)) {
		if (shape.get("type") !== "decision") continue;
		shapes.set(other, {
			type: "decision",
			title: shape.get("title"),
			status: shape.get("status"),
		} as ShapeProps);
	}
	return otherDecisions(shapes, id);
}

/** The decision's write-back as it shows it, from its staged change or, once that's gone, its ref. */
export function writeBackView(change: PendingChange | null, ref?: string): WriteBackView | null {
	if (!change) {
		return ref ? { kind: "pr", status: "applied", label: "Decision record", cardKey: ref } : null;
	}
	const { op } = change;
	if (op.kind === "pr.create") {
		const number = op.files.map((file) => recordNumber(file.path)).find((n) => n !== null);
		return {
			kind: "pr",
			status: change.status,
			label: number != null ? `ADR ${padNumber(number)}` : "Decision record",
			cardKey: ref ?? (change.status === "applied" ? change.result?.key : undefined),
			url: change.result?.url,
			error: change.error,
		};
	}
	if (op.kind === "discussion.create") {
		return {
			kind: "discussion",
			status: change.status,
			label: op.category,
			url: change.result?.url,
			error: change.error,
		};
	}
	return null;
}

export const DecisionNode = memo(function DecisionNode({ data, selected }: NodeProps<ShapeNode>) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const { sizeOf } = useContext(SectionContext);
	const { user } = useContext(DecisionContext);
	const flow = useReactFlow();
	const store = useStoreApi();
	const id = data.id;
	const shape = data.shape;
	const title = shape.title ?? "";
	const text = shape.text ?? "";
	const status = statusOf(shape);

	const [enter] = useState(() => isFresh(id));
	// A decision this client just placed starts with its title being typed.
	const [startEditing] = useState(() => takeFocus(id));
	const [focusField, setFocusField] = useState<DecisionField>("title");
	const [writingBack, setWritingBack] = useState(false);
	const latest = useRef({ title, text });
	latest.current = { title, text };

	const setTitle = (value: string) =>
		doc && transactLocal(doc, () => shapesMap(doc).get(id)?.set("title", value));
	const setText = (value: string) =>
		doc && transactLocal(doc, () => shapesMap(doc).get(id)?.set("text", value));

	const { editing, setEditing, field, handlers } = useEditing({
		selected: !!selected,
		startEditing,
		onType: (chars) => {
			// What's typed before a new decision's title can take focus goes in it.
			if (latest.current.title.trim() === "") {
				setFocusField("title");
				setTitle(latest.current.title + chars);
			} else {
				setFocusField("body");
				setText(latest.current.text + chars);
			}
		},
	});

	// Enter on a selected decision edits whichever field it's still missing.
	useEffect(() => {
		if (!editing) setFocusField(title.trim() === "" ? "title" : "body");
	}, [editing, title]);

	// A click or double-click edits the field it lands on.
	const fieldAt = (event: MouseEvent): DecisionField | null => {
		const target = (event.target as Element).closest("[data-field]");
		return (target?.getAttribute("data-field") as DecisionField | null) ?? null;
	};
	const onClick = (event: MouseEvent) => {
		const at = fieldAt(event);
		if (at) setFocusField(at);
		handlers.onClick(event);
	};
	const onDoubleClick = (event: MouseEvent) => {
		setFocusField(fieldAt(event) ?? (title.trim() === "" ? "title" : "body"));
		handlers.onDoubleClick();
	};

	const votes = tally(shape.votes);
	const myVote = user ? (shape.votes?.[voterKey(user)]?.choice ?? null) : null;
	const linked = useDocValue(doc, (d) => readLinked(d, id), id) ?? [];
	const change = useDocValue(doc, (d) => writeBackOf(d, shape), shape.writeback ?? "");
	const writeBack = writeBackView(change, shape.ref);
	const superseder = useDocValue(
		doc,
		(d) => {
			const by = shape.supersededBy ? shapesMap(d).get(shape.supersededBy) : undefined;
			const title = by?.get("title");
			return by?.get("type") === "decision"
				? { title: typeof title === "string" ? title : "" }
				: null;
		},
		shape.supersededBy ?? "",
	);
	const others = useDocValue(doc, (d) => readOthers(d, id), id) ?? [];

	// Once the record's pull request exists, the decision points at it, so
	// the board follows its live state (see linkWrittenDecisions).
	const applied = change?.status === "applied" && !shape.ref;
	useEffect(() => {
		if (applied && doc && !readOnly) linkWrittenDecisions(doc);
	}, [applied, doc, readOnly]);

	const by = user ? { name: user.name, color: user.color } : undefined;

	const onVote = (choice: VoteChoice | null) => {
		if (doc && user) castVote(doc, id, user, choice);
	};

	const onStatus = (next: DecisionStatus) => {
		if (!doc) return;
		transactLocal(doc, () => {
			// Back to proposed: a write-back that hasn't gone yet goes too.
			if (
				next === "proposed" &&
				change &&
				(change.status === "staged" || change.status === "failed")
			) {
				unstageChanges(doc, [change.id]);
				shapesMap(doc).get(id)?.delete("writeback");
			}
			setDecisionStatus(doc, id, next, { by });
		});
	};

	const box = (other: string) => {
		const s = shapesMap(doc as Y.Doc).get(other);
		return s ? boxOf(other, readShape(s), sizeOf) : undefined;
	};

	/** A dashed "supersedes" connector from the newer decision to this one, unless there is one. */
	const linkSuccessor = (successor: string) => {
		if (!doc) return;
		const connected = [...shapesMap(doc).values()].some((s) => {
			if (s.get("type") !== "connector") return false;
			const ends = [s.get("from"), s.get("to")] as { shape?: string }[];
			return ends.some((end) => end?.shape === id) && ends.some((end) => end?.shape === successor);
		});
		if (connected) return;
		addConnector(doc, {
			...withFallbacks({ x: 0, y: 0, shape: successor }, { x: 0, y: 0, shape: id }, box),
			label: "supersedes",
			dash: true,
		});
	};

	const select = (target: string) => {
		// Once the new node is in React Flow's store; selection is the board's.
		requestAnimationFrame(() => store.getState().addSelectedNodes([target]));
	};

	const onSupersedeWithNew = () => {
		if (!doc) return;
		const successor = crypto.randomUUID();
		const width = sizeOf(id)?.w ?? 320;
		transactLocal(doc, () => {
			addDecision(doc, successor, {
				x: shape.x + width + SUCCESSOR_GAP,
				y: shape.y,
				author: by,
			});
			placeInSections(doc, [successor], sizeOf);
			linkSuccessor(successor);
			setDecisionStatus(doc, id, "superseded", { by, supersededBy: successor });
		});
		focusWhenMounted(successor);
		select(successor);
	};

	const onSupersededBy = (successor: string) => {
		if (!doc) return;
		transactLocal(doc, () => {
			linkSuccessor(successor);
			setDecisionStatus(doc, id, "superseded", { by, supersededBy: successor });
		});
	};

	const onShowSuperseder = () => {
		const successor = shape.supersededBy;
		if (!successor) return;
		void flow.fitView({
			nodes: [{ id: successor }],
			duration: scaledDuration(520),
			maxZoom: Math.max(1, flow.getZoom()),
			padding: 0.6,
		});
		select(successor);
	};

	return (
		<>
			<DecisionView
				title={title}
				text={text}
				status={status}
				votes={votes}
				myVote={myVote}
				author={shape.author}
				decidedBy={shape.decidedBy}
				decidedAt={shape.decidedAt}
				linked={linked}
				writeBack={writeBack}
				supersededBy={superseder}
				others={others}
				selected={selected}
				editing={editing}
				focusField={focusField}
				enter={enter}
				readOnly={readOnly}
				field={field}
				onTitle={setTitle}
				onText={setText}
				onStopEditing={() => setEditing(false)}
				onVote={user ? onVote : undefined}
				onStatus={onStatus}
				onWriteBack={() => setWritingBack(true)}
				onSupersedeWithNew={onSupersedeWithNew}
				onSupersededBy={onSupersededBy}
				onShowSuperseder={superseder ? onShowSuperseder : undefined}
				onPointerDown={handlers.onPointerDown}
				onClick={onClick}
				onDoubleClick={onDoubleClick}
			/>
			{writingBack && doc && (
				<WriteBackDialog
					doc={doc}
					decisionId={id}
					linked={linked}
					retrying={change?.status === "failed" ? change.id : undefined}
					onClose={() => setWritingBack(false)}
				/>
			)}
		</>
	);
});
