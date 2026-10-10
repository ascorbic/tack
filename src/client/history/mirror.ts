import * as Y from "yjs";

// Replays render a document of their own, which is made to look like the
// board at the moment being shown by changing only what differs. One
// document for the whole replay means the canvas never remounts: scrubbing
// back and forth moves, adds and removes shapes in place, so they animate
// like live edits do.

/** The origin of every write to a replay's document. Nothing undoes it, and it's never sent anywhere. */
export const MIRROR_ORIGIN = "history-mirror";

/** Root types that are arrays (everything else at the root is a map). */
const ARRAYS = new Set(["ruleLog"]);

/** Make `target` hold what `source` holds, writing only the differences. */
export function mirrorDoc(source: Y.Doc, target: Y.Doc): void {
	const names = new Set([...source.share.keys(), ...target.share.keys()]);
	target.transact(() => {
		for (const name of names) {
			if (ARRAYS.has(name) || isArray(source.share.get(name)) || isArray(target.share.get(name))) {
				syncArray(source.getArray(name), target.getArray(name));
			} else {
				syncMap(source.getMap(name), target.getMap(name));
			}
		}
	}, MIRROR_ORIGIN);
}

/** A root type that's only been read from an update doesn't know its kind yet: look at what it holds. */
function isArray(type: Y.AbstractType<Y.YEvent<any>> | undefined): boolean {
	if (!type) return false;
	if (type instanceof Y.Array) return true;
	if (type instanceof Y.Map) return false;
	return type._start !== null && type._map.size === 0;
}

function syncMap(source: Y.Map<unknown>, target: Y.Map<unknown>): void {
	for (const key of Array.from(target.keys())) if (!source.has(key)) target.delete(key);
	for (const [key, value] of source.entries()) {
		const current = target.get(key);
		if (value instanceof Y.Map) {
			if (current instanceof Y.Map) {
				syncMap(value, current);
			} else {
				target.set(key, new Y.Map());
				syncMap(value, target.get(key) as Y.Map<unknown>);
			}
		} else if (value instanceof Y.Array) {
			if (current instanceof Y.Array) {
				syncArray(value, current);
			} else {
				target.set(key, new Y.Array());
				syncArray(value, target.get(key) as Y.Array<unknown>);
			}
		} else if (value instanceof Y.Text) {
			const text = (value as Y.Text).toJSON();
			if (!(current instanceof Y.Text) || current.toJSON() !== text) {
				target.set(key, new Y.Text(text));
			}
		} else if (!same(current, value)) {
			target.set(key, value);
		}
	}
}

function syncArray(source: Y.Array<unknown>, target: Y.Array<unknown>): void {
	const values = source.toJSON();
	if (same(target.toJSON(), values)) return;
	// Arrays are logs: append what's new where the start matches, else rewrite.
	const existing = target.toJSON();
	if (existing.length <= values.length && same(existing, values.slice(0, existing.length))) {
		target.push(values.slice(existing.length));
		return;
	}
	target.delete(0, target.length);
	target.push(values);
}

function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (a instanceof Y.AbstractType || b instanceof Y.AbstractType) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}
