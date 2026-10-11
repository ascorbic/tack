import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { addShape, readShape, shapesMap } from "../src/shared/shapes.ts";
import { startWorker } from "./harness.ts";

let mf: Miniflare;
beforeAll(() => {
	mf = startWorker();
});
afterAll(() => mf.dispose());

// Just enough of the y-protocols sync wire format to talk to the board
// without a provider: [messageSync, type, varUint8Array].
const MESSAGE_SYNC = 0;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;

function writeVarUint(out: number[], value: number): void {
	while (value > 0x7f) {
		out.push((value & 0x7f) | 0x80);
		value >>>= 7;
	}
	out.push(value);
}

function readVarUint(bytes: Uint8Array, at: { i: number }): number {
	let value = 0;
	let shift = 0;
	for (;;) {
		const byte = bytes[at.i++] ?? 0;
		value |= (byte & 0x7f) << shift;
		if (byte < 0x80) return value >>> 0;
		shift += 7;
	}
}

function updateMessage(update: Uint8Array): Uint8Array<ArrayBuffer> {
	const out: number[] = [];
	writeVarUint(out, MESSAGE_SYNC);
	writeVarUint(out, SYNC_UPDATE);
	writeVarUint(out, update.length);
	return new Uint8Array([...out, ...update]);
}

async function connect(board: string, doc: Y.Doc) {
	// Boards must be in the index; adopt this one as a guest would from `/?board=name`.
	await mf.dispatchFetch("http://localhost/api/boards/legacy", {
		method: "POST",
		headers: { origin: "http://localhost", "content-type": "application/json" },
		body: JSON.stringify({ name: board }),
	});
	const response = await mf.dispatchFetch(`http://localhost/parties/board/${board}`, {
		headers: { Upgrade: "websocket" },
	});
	const socket = response.webSocket;
	if (!socket) throw new Error(`no websocket: ${response.status}`);
	socket.accept();
	socket.addEventListener("message", (event) => {
		if (typeof event.data === "string") return;
		const bytes = new Uint8Array(event.data as ArrayBuffer);
		const at = { i: 0 };
		if (readVarUint(bytes, at) !== MESSAGE_SYNC) return;
		const type = readVarUint(bytes, at);
		if (type !== SYNC_STEP_2 && type !== SYNC_UPDATE) return;
		const length = readVarUint(bytes, at);
		Y.applyUpdate(doc, bytes.slice(at.i, at.i + length), "server");
	});
	// Ask for what the board already has (a new board's format stamp, at
	// least), as a provider does: the server's later updates build on it.
	const step1: number[] = [];
	const vector = Y.encodeStateVector(doc);
	writeVarUint(step1, MESSAGE_SYNC);
	writeVarUint(step1, SYNC_STEP_1);
	writeVarUint(step1, vector.length);
	socket.send(new Uint8Array([...step1, ...vector]));
	return socket;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("board repair pass", () => {
	it("detaches connector ends and clears parents that point at missing shapes", async () => {
		const doc = new Y.Doc();
		const socket = await connect("repair-test", doc);

		// What a client might send after merging concurrent edits: a sticky in a
		// section that's gone, and a connector bound to a card that's gone.
		const before = Y.encodeStateVector(doc);
		addShape(doc, "note", { type: "sticky", x: 0, y: 0, z: "a0", parent: "gone-section" });
		addShape(doc, "line", {
			type: "connector",
			x: 0,
			y: 0,
			z: "a1",
			from: { x: 300, y: 300 },
			to: { x: 40, y: 60, shape: "gone-card", anchor: { x: 1, y: 0.5 } },
		});
		socket.send(updateMessage(Y.encodeStateAsUpdate(doc, before)));

		const read = (id: string) => readShape(shapesMap(doc).get(id) as Y.Map<unknown>);
		await until(() => read("note").parent === null && read("line").to?.shape === undefined);
		expect(read("line").to).toEqual({ x: 40, y: 60 });
		expect(read("line").from).toEqual({ x: 300, y: 300 });
		socket.close();
	});
});
