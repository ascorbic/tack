// A minimal y-partyserver client for integration tests: connects to a board
// over a real WebSocket through the Worker (so the per-board access check
// runs), and speaks the Yjs sync protocol with its own Y.Doc.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { Miniflare } from "miniflare";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const MESSAGE_SYNC = 0;
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
		if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return; // awareness
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
