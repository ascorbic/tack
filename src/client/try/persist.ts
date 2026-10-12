import * as Y from "yjs";
import type { Card } from "../../shared/cards.ts";
import { type HistoryDump, MemoryHistoryStore } from "../../shared/history.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { cardStore } from "../cardStore.ts";

// The public demo keeps each scenario's board in this browser (#75), so a
// refresh doesn't lose it: the document, the cards on it (pushes make new
// ones) and its history, under one localStorage key per scenario. Storage
// can be missing, full or blocked (private windows, previews), so every
// read and write is guarded and the demo works without it.

const VERSION = 1;
const PREFIX = "tack:try:";

interface Saved {
	v: number;
	doc: string;
	cards: Card[];
	history?: HistoryDump;
	at: string;
}

export interface Restored {
	update: Uint8Array;
	cards: Card[];
	history: MemoryHistoryStore | null;
}

const keyOf = (scenario: string) => `${PREFIX}${scenario}`;

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** The scenario's board as this browser last left it, if it kept one. */
export function restore(scenario: string): Restored | null {
	try {
		const raw = localStorage.getItem(keyOf(scenario));
		if (!raw) return null;
		const saved = JSON.parse(raw) as Saved;
		if (saved.v !== VERSION || typeof saved.doc !== "string") return null;
		return {
			update: fromBase64(saved.doc),
			cards: Array.isArray(saved.cards) ? saved.cards : [],
			history: saved.history ? MemoryHistoryStore.from(saved.history) : null,
		};
	} catch {
		return null;
	}
}

/** Every card the board shows, as the card store has it now. */
function cardsOn(doc: Y.Doc): Card[] {
	const cards = new Map<string, Card>();
	for (const shape of shapesMap(doc).values()) {
		const ref = shape.get("ref");
		if (typeof ref !== "string" || cards.has(ref)) continue;
		const card = cardStore.get(ref);
		if (card && !("missing" in card)) cards.set(ref, card);
	}
	return [...cards.values()];
}

/**
 * Keep the board. With its history if there's room; without it if not
 * (history is the larger part); not at all if storage refuses.
 */
export function save(scenario: string, doc: Y.Doc, history?: MemoryHistoryStore): boolean {
	const saved: Saved = {
		v: VERSION,
		doc: toBase64(Y.encodeStateAsUpdate(doc)),
		cards: cardsOn(doc),
		history: history?.dump(),
		at: new Date().toISOString(),
	};
	try {
		localStorage.setItem(keyOf(scenario), JSON.stringify(saved));
		return true;
	} catch {
		try {
			localStorage.setItem(keyOf(scenario), JSON.stringify({ ...saved, history: undefined }));
			return true;
		} catch {
			return false;
		}
	}
}

/** Forget the scenario's board, for Reset. */
export function forget(scenario: string): void {
	try {
		localStorage.removeItem(keyOf(scenario));
	} catch {}
}

/** Whether this browser kept a board for the scenario. */
export function kept(scenario: string): boolean {
	try {
		return localStorage.getItem(keyOf(scenario)) !== null;
	} catch {
		return false;
	}
}

/** A small preference of the demo's own, e.g. the last scenario or the guide's progress. */
export function readPref<T>(name: string): T | null {
	try {
		const raw = localStorage.getItem(`${PREFIX}pref:${name}`);
		return raw === null ? null : (JSON.parse(raw) as T);
	} catch {
		return null;
	}
}

export function writePref(name: string, value: unknown): void {
	try {
		if (value === null) localStorage.removeItem(`${PREFIX}pref:${name}`);
		else localStorage.setItem(`${PREFIX}pref:${name}`, JSON.stringify(value));
	} catch {}
}
