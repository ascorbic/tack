import * as Y from "yjs";
import { LOCAL_ORIGIN, transactLocal } from "../shared/shapes.ts";

// Undo and redo for one person's changes to a shared board.
//
// Every document write this client makes goes through one origin, and the
// undo manager tracks only that origin, so changes that arrive from other
// people (or from the server, or the playground's simulated people) are
// never undone. Yjs already refuses to undo a property someone else has
// since changed; on top of that, undo never deletes a shape that someone
// else has worked on, even if this client created it.

// Every local write goes through `transactLocal` (origin `LOCAL_ORIGIN`),
// defined beside the shape schema so shared helpers like `updateShapes` use
// it too.
export { LOCAL_ORIGIN, transactLocal };

/**
 * Text edits that begin within this long of the previous change join its
 * undo step: the keystroke that starts editing a sticky, or the sticky that
 * was placed a moment ago, undo together with the text typed into it.
 */
const JOIN_MS = 300;

type Listener = () => void;

type ChangedTypes = Y.Transaction["changedParentTypes"];

/** Shapes affected by an undo or redo, by id. */
export type Affected = Set<string>;

interface SelectionBinding {
	get(): string[];
	restore(ids: string[], affected: Affected): void;
}

export class History {
	readonly manager: Y.UndoManager;
	private readonly listeners = new Set<Listener>();
	private selection: SelectionBinding | null = null;
	private sessions = 0;

	constructor(private readonly doc: Y.Doc) {
		this.manager = new Y.UndoManager(doc, {
			trackedOrigins: new Set([LOCAL_ORIGIN]),
			// Every transaction is its own step, unless an editing session
			// merges them (see beginSession).
			captureTimeout: 0,
			deleteFilter: (item) => !this.isOthersWork(item),
		});
		this.manager.on("stack-item-added", this.onAdded);
		this.manager.on("stack-item-popped", ({ stackItem, changedParentTypes }) =>
			this.onPopped(stackItem, changedParentTypes),
		);
		this.manager.on("stack-item-updated", this.notify);
		this.manager.on("stack-cleared", this.notify);
	}

	undo(): boolean {
		return this.manager.undo() !== null;
	}

	redo(): boolean {
		return this.manager.redo() !== null;
	}

	canUndo(): boolean {
		return this.manager.canUndo();
	}

	canRedo(): boolean {
		return this.manager.canRedo();
	}

	/** The most recent undo step, to check later whether it's still on top. */
	top(): Y.UndoManager["undoStack"][number] | undefined {
		return this.manager.undoStack.at(-1);
	}

	/**
	 * Merge every local change into one undo step until the returned function
	 * is called, e.g. while someone is typing in a sticky.
	 */
	beginSession(): () => void {
		if (this.sessions++ === 0) {
			if (Date.now() - this.manager.lastChange > JOIN_MS) this.manager.stopCapturing();
			this.manager.captureTimeout = Number.POSITIVE_INFINITY;
		}
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			if (--this.sessions === 0) {
				this.manager.captureTimeout = 0;
				this.manager.stopCapturing();
			}
		};
	}

	/**
	 * Run a local write as part of an earlier undo step, if it's still the
	 * latest: what follows from a change after it's made (a section growing
	 * for a card that just loaded taller) undoes with that change. False, and
	 * nothing written, if anything's happened since.
	 */
	amend(step: ReturnType<History["top"]>, fn: () => void): boolean {
		const manager = this.manager;
		if (!step || this.top() !== step || manager.undoing || manager.redoing) return false;
		const { captureTimeout, lastChange } = manager;
		manager.captureTimeout = Number.POSITIVE_INFINITY;
		// Any change since the step began, however long ago, joins it.
		manager.lastChange = Math.max(lastChange, 1);
		try {
			transactLocal(this.doc, fn);
		} finally {
			manager.captureTimeout = captureTimeout;
			// What comes next starts a step of its own, as it would have.
			manager.lastChange = lastChange;
		}
		return true;
	}

	/**
	 * Save the selection with each undo step, and restore it when the step is
	 * undone or redone, so the shapes that changed are the ones selected.
	 */
	bindSelection(binding: SelectionBinding): () => void {
		this.selection = binding;
		return () => {
			if (this.selection === binding) this.selection = null;
		};
	}

	/** Called whenever the undo or redo stacks change. */
	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	destroy(): void {
		this.manager.destroy();
		this.listeners.clear();
	}

	private notify = () => {
		for (const listener of this.listeners) listener();
	};

	private onAdded = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
		if (this.selection && !stackItem.meta.has("selection")) {
			stackItem.meta.set("selection", this.selection.get());
		}
		this.notify();
	};

	private onPopped(stackItem: { meta: Map<unknown, unknown> }, changed: ChangedTypes): void {
		const saved = stackItem.meta.get("selection");
		if (this.selection && Array.isArray(saved)) {
			this.selection.restore(saved as string[], affectedEntries(changed));
		}
		this.notify();
	}

	/**
	 * True for a deletion an undo or redo must not make, because it would
	 * destroy someone else's work: a shape (or any nested type) that contains
	 * changes from another client, or a property of one that would vanish
	 * outright rather than revert to an earlier value.
	 */
	private isOthersWork(item: Y.Item): boolean {
		const client = this.doc.clientID;
		if (item.content instanceof Y.ContentType && touchedByOthers(item.content.type, client)) {
			return true;
		}
		const parent = item.parent;
		return (
			item.parentSub !== null &&
			item.right === null &&
			parent instanceof Y.AbstractType &&
			parent._item !== null &&
			touchedByOthers(parent, client)
		);
	}
}

/** Whether anyone other than `client` has written anything inside `type`. */
function touchedByOthers(type: Y.AbstractType<unknown>, client: number): boolean {
	const foreign = (item: Y.Item): boolean =>
		item.id.client !== client ||
		(item.content instanceof Y.ContentType && touchedByOthers(item.content.type, client));
	for (const current of type._map.values()) {
		// Earlier values of the key count too: someone may have changed it
		// before this client changed it back.
		for (let item: Y.Item | null = current; item; item = item.left) {
			if (foreign(item)) return true;
		}
	}
	for (let item = type._start; item; item = item.right) {
		if (foreign(item)) return true;
	}
	return false;
}

/**
 * The ids of top-level entries (shapes, and whatever else lives in a
 * top-level map) that a transaction changed.
 */
export function affectedEntries(changed: ChangedTypes): Affected {
	const ids: Affected = new Set();
	for (const [type, events] of changed) {
		if (type._item === null) {
			// Only map events know their keys once the transaction is over.
			for (const event of events) {
				if (event.target === type && event instanceof Y.YMapEvent) {
					for (const key of event.keysChanged) ids.add(key);
				}
			}
			continue;
		}
		let item: Y.Item = type._item;
		while (item.parent instanceof Y.AbstractType && item.parent._item !== null) {
			item = item.parent._item;
		}
		if (item.parentSub !== null) ids.add(item.parentSub);
	}
	return ids;
}
