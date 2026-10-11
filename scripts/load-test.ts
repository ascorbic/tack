// Load test: many people on one board (#60). Opens simulated clients, all
// on one board (one Durable Object), each speaking the Yjs sync and
// awareness protocols as the app does: everyone moving their cursor, and a
// few of them moving shapes. Reports how long connecting and syncing took,
// how long an edit took to reach everyone, how many messages each client
// got, and the server's memory.
//
//   node scripts/load-test.ts [url] [--clients 50] [--editors 5] [--seconds 20]
//                            [--cursor-hz 5] [--edit-hz 2] [--shapes 200]
//                            [--processes N] [--board id] [--worker]
//
// The URL is a local dev server's (`pnpm dev`, default http://localhost:5173).
// `--worker` instead runs the built Worker (`pnpm build` first) in Miniflare
// and tests that, with no dev server's proxy in between: closer to what a
// board's object can do in production. Clients are spread over several
// processes (one per 25 clients, up to the cores there are), so the load
// generator isn't what runs out of breath; latency is measured with the
// shared wall clock. Boards are open to everyone before the GitHub App is
// set up; with dev sign-in on (`TACK_DEV_AUTH=1`) clients sign in with
// `/auth/dev` first (as load-0, load-1…). Memory is the resident size of the
// server's workerd processes (`ps`), sampled every second: everything the
// Worker and its Durable Objects hold. Results are in AGENTS.md ("Load").

import { execFileSync, fork } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
/** After the run, how long to wait for the last edits to land. */
const DRAIN_MS = 2000;

interface Options {
	url: string;
	clients: number;
	editors: number;
	seconds: number;
	cursorHz: number;
	editHz: number;
	shapes: number;
	processes: number;
	board: string | null;
	/** Run the built Worker in Miniflare and test that, with no dev server in between. */
	worker: boolean;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		url: "http://localhost:5173",
		clients: 50,
		editors: 5,
		seconds: 20,
		cursorHz: 5,
		editHz: 2,
		shapes: 200,
		processes: 0,
		board: null,
		worker: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const next = () => argv[++i] ?? "";
		if (arg === "--clients") options.clients = Number(next());
		else if (arg === "--editors") options.editors = Number(next());
		else if (arg === "--seconds") options.seconds = Number(next());
		else if (arg === "--cursor-hz") options.cursorHz = Number(next());
		else if (arg === "--edit-hz") options.editHz = Number(next());
		else if (arg === "--shapes") options.shapes = Number(next());
		else if (arg === "--processes") options.processes = Number(next());
		else if (arg === "--board") options.board = next();
		else if (arg === "--worker") options.worker = true;
		else if (!arg.startsWith("--")) options.url = arg.replace(/\/$/, "");
	}
	options.editors = Math.min(options.editors, options.clients);
	if (!(options.processes > 0)) {
		options.processes = Math.max(
			1,
			Math.min(availableParallelism() - 1, Math.ceil(options.clients / 25)),
		);
	}
	return options;
}

/** Now, by the wall clock every process shares (ms, with fractions). */
function wallNow(): number {
	return performance.timeOrigin + performance.now();
}

/** Sign in as a load-test user if dev sign-in is on; otherwise signed out. */
async function cookieFor(url: string, n: number): Promise<string | null> {
	const response = await fetch(`${url}/auth/dev?login=load-${n}&allow=1`, { redirect: "manual" });
	if (response.status !== 302) return null;
	return response.headers.getSetCookie()[0]?.split(";")[0] ?? null;
}

async function createBoard(url: string, cookie: string | null, shapes: number): Promise<string> {
	const response = await fetch(`${url}/api/boards`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: url,
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify({
			title: `Load test ${new Date().toISOString()}`,
			visibility: "instance",
		}),
	});
	if (!response.ok)
		throw new Error(`Couldn't make a board: ${response.status} ${await response.text()}`);
	const { id } = (await response.json()) as { id: string };
	// Fill it as a busy board would be, from one client.
	const seeder = await connect(url, id, cookie, -1);
	seeder.doc.transact(() => {
		const map = seeder.doc.getMap("shapes");
		for (let i = 0; i < shapes; i++) {
			const shape = new Y.Map<unknown>();
			shape.set("type", "sticky");
			shape.set("x", (i % 20) * 220);
			shape.set("y", Math.floor(i / 20) * 220);
			shape.set("z", `a${String(i).padStart(4, "0")}`);
			shape.set("text", `Sticky ${i}`);
			map.set(`load-${i}`, shape);
		}
	});
	await seeder.synced(true);
	seeder.close();
	return id;
}

interface Client {
	n: number;
	doc: Y.Doc;
	awareness: awarenessProtocol.Awareness;
	connectedMs: number;
	/** Messages received (sync, presence and custom). */
	received: number;
	syncedMs: number | null;
	/** Resolves once the server has answered a fresh sync step 1 (so everything sent is applied). */
	synced(again?: boolean): Promise<void>;
	close(): void;
	closed: boolean;
}

async function connect(
	url: string,
	board: string,
	cookie: string | null,
	n: number,
): Promise<Client> {
	const socketUrl = `${url.replace(/^http/, "ws")}/parties/board/${board}`;
	const started = performance.now();
	// Node's WebSocket (undici) takes headers: the cookie, and the page's origin.
	const ws = new WebSocket(socketUrl, {
		headers: { origin: url, ...(cookie ? { cookie } : {}) },
	} as unknown as string[]);
	ws.binaryType = "arraybuffer";
	const doc = new Y.Doc();
	const awareness = new awarenessProtocol.Awareness(doc);
	const remote = Symbol("remote");
	let waiting: (() => void)[] = [];
	const client: Client = {
		n,
		doc,
		awareness,
		connectedMs: 0,
		received: 0,
		syncedMs: null,
		closed: false,
		synced: (again = false) =>
			new Promise<void>((resolve) => {
				if (!again && client.syncedMs !== null) return resolve();
				waiting.push(resolve);
				if (again) send(step1(doc));
			}),
		close: () => {
			client.closed = true;
			awareness.destroy();
			ws.close();
		},
	};
	const send = (bytes: Uint8Array) => {
		if (ws.readyState === WebSocket.OPEN) ws.send(bytes as Uint8Array<ArrayBuffer>);
	};
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error(`client ${n} couldn't connect`)), {
			once: true,
		});
	});
	client.connectedMs = performance.now() - started;
	ws.addEventListener("close", () => {
		client.closed = true;
	});
	ws.addEventListener("message", (event) => {
		client.received++;
		if (typeof event.data === "string") return; // card data and other custom messages
		const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
		const kind = decoding.readVarUint(decoder);
		if (kind === MESSAGE_AWARENESS) {
			awarenessProtocol.applyAwarenessUpdate(
				awareness,
				decoding.readVarUint8Array(decoder),
				remote,
			);
			return;
		}
		if (kind !== MESSAGE_SYNC) return;
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		const type = syncProtocol.readSyncMessage(decoder, encoder, doc, remote);
		if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));
		if (type === syncProtocol.messageYjsSyncStep2) {
			if (client.syncedMs === null) client.syncedMs = performance.now() - started;
			const done = waiting;
			waiting = [];
			for (const resolve of done) resolve();
		}
	});
	doc.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === remote) return;
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		syncProtocol.writeUpdate(encoder, update);
		send(encoding.toUint8Array(encoder));
	});
	awareness.on(
		"update",
		({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
			if (origin === remote) return;
			const changed = [...added!, ...updated!, ...removed!];
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
			encoding.writeVarUint8Array(
				encoder,
				awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
			);
			send(encoding.toUint8Array(encoder));
		},
	);
	send(step1(doc));
	return client;
}

function step1(doc: Y.Doc): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_SYNC);
	syncProtocol.writeSyncStep1(encoder, doc);
	return encoding.toUint8Array(encoder);
}

/** The dev server's own process: whatever listens on its port. */
function serverPid(url: string): number | null {
	try {
		const port = new URL(url).port || "80";
		const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
			encoding: "utf8",
		});
		const pid = Number(out.trim().split("\n")[0]);
		return pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/**
 * Resident memory of the server's workerd processes (descendants of `root`,
 * so other dev servers on the machine don't count), in MB; null if `ps`
 * can't say.
 */
function workerdMemoryMb(root: number | null): number | null {
	try {
		const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" });
		const rows = out
			.split("\n")
			.map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
			.filter((match): match is RegExpExecArray => match !== null)
			.map((match) => ({
				pid: Number(match[1]),
				ppid: Number(match[2]),
				kb: Number(match[3]),
				name: match[4] ?? "",
			}));
		const ours = new Set(root === null ? [] : [root]);
		for (let grew = true; grew;) {
			grew = false;
			for (const row of rows) {
				if (ours.has(row.ppid) && !ours.has(row.pid)) {
					ours.add(row.pid);
					grew = true;
				}
			}
		}
		const kb = rows
			.filter((row) => /workerd/.test(row.name) && (root === null || ours.has(row.pid)))
			.reduce((sum, row) => sum + row.kb, 0);
		return kb > 0 ? Math.round(kb / 1024) : null;
	} catch {
		return null;
	}
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function ms(value: number): string {
	return Number.isFinite(value) ? `${value.toFixed(0)} ms` : "–";
}

// --- Each process's share of the clients ----------------------------------------

/** What a child process is asked to do. */
interface Plan {
	url: string;
	board: string;
	clients: { n: number; cookie: string | null; editor: boolean }[];
	cursorHz: number;
	editHz: number;
}

/** What it reports once its clients are in. */
interface Ready {
	type: "ready";
	connect: number[];
	sync: number[];
}

/** And after the run. */
interface Done {
	type: "done";
	latencies: number[];
	edits: number;
	received: number;
	dropped: number;
}

async function runShare(
	plan: Plan,
	go: Promise<{ until: number }>,
): Promise<{
	ready: Ready;
	done: Promise<Done>;
}> {
	// Connect in waves of ten, as a room fills up.
	const clients: (Client & { editor: boolean })[] = [];
	for (let wave = 0; wave < plan.clients.length; wave += 10) {
		const batch = await Promise.all(
			plan.clients.slice(wave, wave + 10).map(async (spec) =>
				Object.assign(await connect(plan.url, plan.board, spec.cookie, spec.n), {
					editor: spec.editor,
				}),
			),
		);
		clients.push(...batch);
	}
	await Promise.all(clients.map((client) => client.synced()));
	const ready: Ready = {
		type: "ready",
		connect: clients.map((client) => client.connectedMs),
		sync: clients.map((client) => client.syncedMs ?? Number.NaN),
	};

	const done = (async (): Promise<Done> => {
		const { until } = await go;
		const latencies: number[] = [];
		for (const client of clients) {
			client.doc.getMap("shapes").observeDeep((events) => {
				const now = wallNow();
				for (const event of events) {
					if (!event.keys.has("loadStamp")) continue;
					const stamp = (event.target as Y.Map<unknown>).get("loadStamp");
					if (typeof stamp !== "string") continue;
					const [from, , at] = stamp.split(":");
					if (Number(from) !== client.n) latencies.push(now - Number(at));
				}
			});
		}
		const receivedBefore = clients.reduce((sum, client) => sum + client.received, 0);
		const timers: ReturnType<typeof setInterval>[] = [];
		let edits = 0;
		for (const editor of clients.filter((client) => client.editor)) {
			timers.push(
				setInterval(() => {
					const shapes = editor.doc.getMap("shapes");
					const keys = [...shapes.keys()];
					const shape = shapes.get(keys[Math.floor(Math.random() * keys.length)]!) as
						| Y.Map<unknown>
						| undefined;
					if (!shape) return;
					edits++;
					editor.doc.transact(() => {
						shape.set("x", Math.round(Math.random() * 4000));
						shape.set("y", Math.round(Math.random() * 3000));
						shape.set("loadStamp", `${editor.n}:${edits}:${wallNow()}`);
					});
				}, 1000 / plan.editHz),
			);
		}
		for (const client of clients) {
			client.awareness.setLocalState({
				user: { name: `Load ${client.n}`, color: "#2f5fd0" },
				cursor: { x: 0, y: 0 },
				status: "active",
			});
			if (plan.cursorHz <= 0) continue;
			timers.push(
				setInterval(
					() => {
						client.awareness.setLocalStateField("cursor", {
							x: Math.round(Math.random() * 4000),
							y: Math.round(Math.random() * 3000),
						});
					},
					1000 / plan.cursorHz + Math.random() * 20,
				),
			);
		}
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())));
		for (const timer of timers) clearInterval(timer);
		const received = clients.reduce((sum, client) => sum + client.received, 0) - receivedBefore;
		await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
		const dropped = clients.filter((client) => client.closed).length;
		for (const client of clients) client.close();
		return { type: "done", latencies, edits, received, dropped };
	})();
	return { ready, done };
}

// --- A child process ---------------------------------------------------------------

if (process.argv.includes("--child")) {
	let start: (go: { until: number }) => void = () => {};
	const go = new Promise<{ until: number }>((resolve) => {
		start = resolve;
	});
	process.on("message", (message: { type: string; plan?: Plan; until?: number }) => {
		if (message.type === "plan" && message.plan) {
			void runShare(message.plan, go).then(async ({ ready, done }) => {
				process.send?.(ready);
				process.send?.(await done, () => process.exit(0));
			});
		}
		if (message.type === "go" && message.until) start({ until: message.until });
	});
} else {
	await main();
}

// --- The run -----------------------------------------------------------------------

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	let stopWorker: (() => Promise<void>) | null = null;
	if (options.worker) {
		const { startWorker } = await import("../test/harness.ts");
		const mf = startWorker({ devAuth: true });
		options.url = (await mf.ready).toString().replace(/\/$/, "");
		stopWorker = () => mf.dispose();
	}
	console.log(
		`Load test: ${options.clients} clients over ${options.processes} process(es) (${options.editors} editing at ${options.editHz}/s), cursors at ${options.cursorHz}/s, ${options.seconds}s, against ${options.worker ? "the built Worker in Miniflare" : options.url}`,
	);

	const memory: number[] = [];
	// Miniflare's workerd is this process's own child.
	const root = options.worker ? process.pid : serverPid(options.url);
	const sample = () => {
		const mb = workerdMemoryMb(root);
		if (mb !== null) memory.push(mb);
	};
	sample();
	const baseline = memory.at(-1) ?? null;

	const cookies = await Promise.all(
		Array.from({ length: options.clients }, (_, n) => cookieFor(options.url, n)),
	);
	const board =
		options.board ?? (await createBoard(options.url, cookies[0] ?? null, options.shapes));
	console.log(`Board ${board}${cookies[0] ? " (signed in with /auth/dev)" : " (signed out)"}`);

	// Share the clients out, editors spread across the processes too.
	const plans: Plan[] = Array.from({ length: options.processes }, () => ({
		url: options.url,
		board,
		clients: [],
		cursorHz: options.cursorHz,
		editHz: options.editHz,
	}));
	for (let n = 0; n < options.clients; n++) {
		plans[n % options.processes]!.clients.push({
			n,
			cookie: cookies[n] ?? null,
			editor: n < options.editors,
		});
	}
	const script = fileURLToPath(import.meta.url);
	const started = performance.now();
	const children = plans
		.filter((plan) => plan.clients.length > 0)
		.map((plan) => {
			const child = fork(script, ["--child"], { execArgv: process.execArgv });
			const ready = new Promise<Ready>((resolve) =>
				child.on("message", (message: Ready | Done) => {
					if (message.type === "ready") resolve(message);
				}),
			);
			const done = new Promise<Done>((resolve) =>
				child.on("message", (message: Ready | Done) => {
					if (message.type === "done") resolve(message);
				}),
			);
			child.send({ type: "plan", plan });
			return { child, ready, done };
		});
	const readies = await Promise.all(children.map((child) => child.ready));
	const everyoneIn = performance.now() - started;
	sample();

	const until = Date.now() + options.seconds * 1000;
	for (const { child } of children) child.send({ type: "go", until });
	const sampler = setInterval(sample, 1000);
	const dones = await Promise.all(children.map((child) => child.done));
	clearInterval(sampler);
	sample();

	const connects = readies.flatMap((ready) => ready.connect);
	const syncs = readies.flatMap((ready) => ready.sync).filter(Number.isFinite);
	const latencies = dones.flatMap((done) => done.latencies);
	const edits = dones.reduce((sum, done) => sum + done.edits, 0);
	const received = dones.reduce((sum, done) => sum + done.received, 0);
	const dropped = dones.reduce((sum, done) => sum + done.dropped, 0);
	const expected = edits * (options.clients - 1);
	const perClient = received / options.clients / options.seconds;
	const peak = memory.length > 0 ? Math.max(...memory) : null;
	const results = {
		clients: options.clients,
		processes: children.length,
		editors: options.editors,
		cursorHz: options.cursorHz,
		seconds: options.seconds,
		connect: { p50: percentile(connects, 50), p95: percentile(connects, 95) },
		sync: { p50: percentile(syncs, 50), p95: percentile(syncs, 95), all: everyoneIn },
		edits,
		delivered: latencies.length,
		expected,
		latency: {
			p50: percentile(latencies, 50),
			p95: percentile(latencies, 95),
			p99: percentile(latencies, 99),
			max: latencies.length > 0 ? Math.max(...latencies) : Number.NaN,
		},
		messagesPerClientPerSecond: Math.round(perClient),
		memoryMb: { before: baseline, peak, after: memory.at(-1) ?? null },
		dropped,
	};
	console.log(`
Connect      p50 ${ms(results.connect.p50)}, p95 ${ms(results.connect.p95)}
First sync   p50 ${ms(results.sync.p50)}, p95 ${ms(results.sync.p95)}, everyone in ${ms(results.sync.all)}
Edits        ${edits} made, ${latencies.length} of ${expected} deliveries seen (${((latencies.length / Math.max(1, expected)) * 100).toFixed(1)}%)
Edit → seen  p50 ${ms(results.latency.p50)}, p95 ${ms(results.latency.p95)}, p99 ${ms(results.latency.p99)}, max ${ms(results.latency.max)}
Received     ${Math.round(perClient)} messages a second per client
Memory       workerd ${baseline ?? "?"} MB before, ${peak ?? "?"} MB at peak, ${memory.at(-1) ?? "?"} MB after
Dropped      ${dropped} connection(s)
`);
	console.log(JSON.stringify(results));
	await stopWorker?.();
	process.exit(0);
}
