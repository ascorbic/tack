// A minimal y-partyserver client for integration tests: connects to a board
// over a real WebSocket through the Worker (so the per-board access check
// runs), and speaks the Yjs sync protocol with its own Y.Doc.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { Miniflare } from "miniflare";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const REMOTE = Symbol("remote");

export interface BoardClient {
	doc: Y.Doc;
	/** Custom messages received (`__YPS:` prefix removed), parsed. */
	messages: unknown[];
	/** Everything received, as it arrived: sync and awareness messages too. */
	raw: (string | Uint8Array)[];
	/** Set once the server closes the connection. */
	closed: { code: number; reason: string } | null;
	/** Resolves once the server has answered our sync request: everything we sent before has been applied. */
	roundTrip(): Promise<void>;
	/** Send a custom message (JSON), as the provider's `sendMessage` does. */
	send(message: unknown): void;
	/** Send bytes as they are: a sync or awareness message made by hand. */
	sendRaw(bytes: Uint8Array): void;
	/** Publish presence (awareness) states, as `{ clientId: [clock, state] }`. */
	sendAwareness(states: Record<number, [clock: number, state: unknown]>): void;
	/** Presence states received, by client id (the latest of each). */
	awareness: Map<number, unknown>;
	close(): void;
}

export type ConnectResult =
	| { ok: true; client: BoardClient }
	| { ok: false; status: number; error: string | null };

export async function connectBoard(
	mf: Miniflare,
	id: string,
	cookie?: string,
	origin = "http://localhost",
): Promise<ConnectResult> {
	const response = await mf.dispatchFetch(`${origin}/parties/board/${id}`, {
		headers: { upgrade: "websocket", ...(cookie ? { cookie } : {}) },
	});
	const ws = response.webSocket;
	if (response.status !== 101 || !ws) {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		return { ok: false, status: response.status, error: body?.error ?? null };
	}

	const doc = new Y.Doc();
	const messages: unknown[] = [];
	const raw: (string | Uint8Array)[] = [];
	let waiting: (() => void)[] = [];
	const client: BoardClient = {
		doc,
		messages,
		raw,
		closed: null,
		roundTrip: () =>
			new Promise<void>((resolve) => {
				waiting.push(resolve);
				send(syncStep1(doc));
			}),
		send: (message) => ws.send(`__YPS:${JSON.stringify(message)}`),
		sendRaw: (bytes) => send(bytes),
		sendAwareness: (states) => send(awarenessMessage(states)),
		awareness: new Map(),
		close: () => {
			if (client.closed) return;
			client.closed = { code: 1000, reason: "closed by test" };
			ws.close();
		},
	};
	const send = (message: Uint8Array) => ws.send(message as Uint8Array<ArrayBuffer>);

	ws.accept();
	ws.addEventListener("message", (event) => {
		const data = event.data;
		raw.push(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer).slice());
		if (typeof data === "string") {
			if (data.startsWith("__YPS:")) messages.push(JSON.parse(data.slice(6)));
			return;
		}
		const decoder = decoding.createDecoder(new Uint8Array(data as ArrayBuffer));
		const kind = decoding.readVarUint(decoder);
		if (kind === MESSAGE_AWARENESS) {
			const update = decoding.createDecoder(decoding.readVarUint8Array(decoder));
			const count = decoding.readVarUint(update);
			for (let i = 0; i < count; i++) {
				const clientId = decoding.readVarUint(update);
				decoding.readVarUint(update);
				client.awareness.set(clientId, JSON.parse(decoding.readVarString(update)));
			}
			return;
		}
		if (kind !== MESSAGE_SYNC) return;
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		const type = syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE);
		if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));
		if (type === syncProtocol.messageYjsSyncStep2) {
			const resolved = waiting;
			waiting = [];
			for (const resolve of resolved) resolve();
		}
	});
	ws.addEventListener("close", (event) => {
		client.closed = { code: event.code, reason: event.reason };
	});
	doc.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === REMOTE) return;
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		syncProtocol.writeUpdate(encoder, update);
		send(encoding.toUint8Array(encoder));
	});

	// Ask for the server's state, as the real provider does.
	await client.roundTrip();
	return { ok: true, client };
}

/** An awareness message, as y-protocols encodes one. */
export function awarenessMessage(
	states: Record<number, [clock: number, state: unknown]>,
): Uint8Array {
	const update = encoding.createEncoder();
	const entries = Object.entries(states);
	encoding.writeVarUint(update, entries.length);
	for (const [clientId, [clock, state]] of entries) {
		encoding.writeVarUint(update, Number(clientId));
		encoding.writeVarUint(update, clock);
		encoding.writeVarString(update, JSON.stringify(state));
	}
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
	encoding.writeVarUint8Array(encoder, encoding.toUint8Array(update));
	return encoding.toUint8Array(encoder);
}

function syncStep1(doc: Y.Doc): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_SYNC);
	syncProtocol.writeSyncStep1(encoder, doc);
	return encoding.toUint8Array(encoder);
}

/** Wait until `check` passes, or fail after `timeout` ms. */
export async function eventually(
	check: () => boolean | Promise<boolean>,
	timeout = 3000,
): Promise<void> {
	const start = Date.now();
	while (!(await check())) {
		if (Date.now() - start > timeout) throw new Error("Timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
