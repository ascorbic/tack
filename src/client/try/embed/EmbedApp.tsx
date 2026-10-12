import { ReactFlowProvider, useReactFlow, useStoreApi } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { Board } from "../../Board.tsx";
import { cardStore } from "../../cardStore.ts";
import { useChangesUI } from "../../changes/context.ts";
import type { User } from "../../presence.ts";
import { playAi } from "../../play/ai.ts";
import { SimulatedAutomation } from "../../play/automation.ts";
import { installFakeRepoApi } from "../../play/decisions.ts";
import { SimulatedFacilitator } from "../../play/facilitation.ts";
import { SimulatedPush } from "../../play/push.ts";
import { SimulatedBoard } from "../../play/simulator.ts";
import { SimulatedStacks } from "../../play/stacks.ts";
import { SimulatedWidgets } from "../../play/widgets.ts";
import { playServices } from "../../play/writes.ts";
import { stackStore } from "../../stacks/store.ts";
import { widgetStore } from "../../widgets/store.ts";
import { framed, hearPage, tellPage } from "./bridge.ts";
import { Director, Stopped } from "./director.ts";
import { CAST, type Feature, type Loop, type LoopContext, type Services } from "./loop.ts";
import { LOOPS } from "./loops/index.ts";
import { reseed } from "./sandbox.ts";
import { MarksStore, Stage, type StageBoard } from "./stage.ts";
import "./embed.css";

// A live embed of the demo, for tack.social's landing page: one feature's
// board, no chrome, played by the demo's people on a loop (loops/), only
// while it's on screen. The first time someone presses a key or the board,
// the loop stops where it is and the board's theirs. With reduced motion
// nothing plays: the board opens where its loop ends, to play with.

/** Where the change the director makes to start a loop again comes from: nobody's. */
const RESET = "embed-reset";
/** The fade between the end of a loop and the start of the next. */
const FADE_MS = { out: 380, in: 520 } as const;

/** The full demo, on the board that's closest to each feature. */
const FULL_DEMO: Record<Feature, string> = {
	stacks: "/try/?scenario=planning",
	push: "/try/?scenario=planning",
	facilitation: "/try/?scenario=retro",
	widgets: "/try/?scenario=triage",
};

const YOU: User = { name: "You", color: "#2f6fde", login: "you" };

type Mode = "loading" | "playing" | "paused" | "yours";

interface World {
	sim: SimulatedBoard;
	push: SimulatedPush;
	stacks: SimulatedStacks;
	services: Services;
}

function makeWorld(loop: Loop): World {
	const sim = new SimulatedBoard();
	for (const card of loop.cards) cardStore.set(card);
	return {
		sim,
		push: new SimulatedPush(sim.doc, () => ({ login: YOU.login ?? "you", name: YOU.name })),
		// The stand-in only: an embed never asks the demo's real AI.
		stacks: new SimulatedStacks(sim.doc, null),
		services: {
			facilitator: new SimulatedFacilitator(sim),
			widgets: new SimulatedWidgets(sim.doc),
			automation: new SimulatedAutomation(sim.doc),
		},
	};
}

export function EmbedApp({ feature, reduced }: { feature: Feature; reduced: boolean }) {
	return (
		<ReactFlowProvider>
			<EmbedBoard feature={feature} reduced={reduced} />
		</ReactFlowProvider>
	);
}

function EmbedBoard({ feature, reduced }: { feature: Feature; reduced: boolean }) {
	const loop = LOOPS[feature];
	const [world] = useState(() => makeWorld(loop));
	const [mode, setMode] = useState<Mode>("loading");
	const [services] = useState(() => ({
		...playServices(),
		boardId: `embed:${feature}`,
		boardUrl: () => new URL(FULL_DEMO[feature], location.origin).href,
		boardTitle: () => loop.title,
	}));
	const { sim, push, stacks } = world;
	const { facilitator, widgets, automation } = world.services;

	// The board's pretend server, as the demo runs it.
	useEffect(() => {
		const uninstalls = [
			facilitator.install(),
			stacks.install(),
			installFakeRepoApi(),
			automation.install(),
		];
		widgetStore.connect(widgets);
		playAi.mode = "live";
		playAi.remote = null;
		playAi.doc = sim.doc;
		playAi.widgets = widgets;
		playAi.login = YOU.login ?? null;
		return () => {
			for (const uninstall of uninstalls) uninstall();
			widgetStore.connect(null);
			widgets.destroy();
			sim.destroy();
		};
	}, [sim, facilitator, stacks, widgets, automation]);

	return (
		<div className="embed" data-mode={mode}>
			<Board
				name={`Tack demo · ${loop.title}`}
				user={YOU}
				doc={sim.doc}
				awareness={sim.awareness}
				synced
				services={services}
				push={push}
			>
				<Direction loop={loop} world={world} reduced={reduced} mode={mode} onMode={setMode} />
				<Corner mode={mode} href={FULL_DEMO[feature]} />
			</Board>
		</div>
	);
}

/** The director, inside the board, where it can reach React Flow and the changes UI. */
function Direction({
	loop,
	world,
	reduced,
	mode,
	onMode,
}: {
	loop: Loop;
	world: World;
	reduced: boolean;
	mode: Mode;
	onMode: (mode: Mode) => void;
}) {
	const flow = useReactFlow();
	const store = useStoreApi();
	const changes = useChangesUI();
	const changesRef = useRef(changes);
	changesRef.current = changes;
	const [marks] = useState(() => new MarksStore());
	const cover = useRef<HTMLDivElement>(null);
	const onModeRef = useRef(onMode);
	onModeRef.current = onMode;

	useEffect(() => {
		const d = new Director(reduced);
		const board: StageBoard = {
			flow,
			store,
			get changes() {
				return changesRef.current;
			},
		};
		const stage = new Stage(d, world.sim, board, marks);
		const people = Object.fromEntries(
			loop.cast.map((name) => [name, stage.actor(world.sim.join(CAST[name]))]),
		) as LoopContext["people"];
		const context: LoopContext = { stage, people, services: world.services };
		const setCover = (opacity: number) => {
			if (cover.current) cover.current.style.opacity = String(opacity);
		};

		// Plays only while it's on screen, the tab's showing, and the page agrees.
		let onScreen = !("IntersectionObserver" in window);
		let pageSays = true;
		let ready = false;
		const update = () => {
			if (d.isStopped || !ready) return;
			if (onScreen && pageSays && document.visibilityState === "visible") d.play();
			else d.pause();
			onModeRef.current(d.isPlaying ? "playing" : "paused");
		};
		const observer =
			"IntersectionObserver" in window
				? new IntersectionObserver(
						(entries) => {
							onScreen = entries.some((entry) => entry.isIntersecting);
							update();
						},
						{ threshold: 0.15 },
					)
				: null;
		observer?.observe(document.body);
		document.addEventListener("visibilitychange", update);
		const unhear = hearPage((message) => {
			if (message.type === "visible") {
				pageSays = message.visible;
				update();
			} else if (message.type === "takeover") takeOver();
		});

		// The first press or key that's a person's (never the director's own
		// clicks) stops the loop where it is: the board's theirs.
		const takeOver = () => {
			if (d.isStopped) return;
			d.stop();
			marks.clear();
			setCover(0);
			onModeRef.current("yours");
			tellPage({ tack: "embed", type: "yours" });
		};
		const onPress = (event: Event) => {
			if (event.isTrusted) takeOver();
		};
		const onKey = (event: KeyboardEvent) => {
			// Tabbing through the page into and out of the board isn't taking it over.
			if (!event.isTrusted || event.key === "Tab" || event.key === "Shift") return;
			takeOver();
		};
		window.addEventListener("pointerdown", onPress, true);
		window.addEventListener("keydown", onKey, true);

		// Scrolling over the board scrolls the page (a pinch, or ⌘/Ctrl and the
		// wheel, still zooms the board): it never traps the page's scroll.
		const onWheel = (event: WheelEvent) => {
			if (!framed() || event.ctrlKey || event.metaKey) return;
			const target = event.target instanceof Element ? event.target : null;
			if (!target?.closest(".react-flow") || target.closest(".nowheel")) return;
			event.preventDefault();
			event.stopPropagation();
			const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
			tellPage({ tack: "embed", type: "scroll", dx: event.deltaX * unit, dy: event.deltaY * unit });
		};
		window.addEventListener("wheel", onWheel, { capture: true, passive: false });

		const restart = () => {
			reseed(1);
			stage.deselect();
			stackStore.setOpen(null);
			changesRef.current?.closeSheet();
			changesRef.current?.setPanelOpen(false);
			marks.clear();
			for (const actor of Object.values(people)) {
				actor.place(null);
				actor.person.awareness.setLocalStateField("chat", null);
				actor.person.awareness.setLocalStateField("drags", {});
			}
			loop.reset?.(world.services);
			for (const card of loop.cards) cardStore.set(card);
			const doc = world.sim.doc;
			doc.transact(() => {
				for (const type of doc.share.values()) if (type instanceof Y.Map) type.clear();
				loop.seed(doc);
			}, RESET);
		};
		const frame = () => {
			void flow.setViewport(stage.viewportFor(loop.frame));
		};
		const settle = async () => {
			// Drawn and measured before it's shown.
			await d.until(() => store.getState().nodeLookup.size > 0, 4000);
			await new Promise((resolve) => setTimeout(resolve, 120));
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		};

		let loops = 0;
		const run = async () => {
			for (let first = true; ; first = false) {
				restart();
				await settle();
				frame();
				await loop.prepare?.(context);
				if (first) {
					ready = true;
					setCover(0);
					tellPage({ tack: "embed", type: "ready" });
					if (reduced) onModeRef.current("paused");
					else update();
				} else {
					await d.tween(FADE_MS.in, (t) => setCover(1 - t));
				}
				await loop.play(context);
				// How many loops have played to the end, for the tests.
				loops++;
				document.documentElement.dataset.embedLoops = String(loops);
				if (reduced) return;
				await d.wait(loop.hold ?? 2000);
				await d.tween(FADE_MS.out, (t) => setCover(t));
			}
		};
		run().catch((error: unknown) => {
			if (!(error instanceof Stopped)) console.error(error);
		});

		return () => {
			d.stop();
			observer?.disconnect();
			document.removeEventListener("visibilitychange", update);
			unhear();
			window.removeEventListener("pointerdown", onPress, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("wheel", onWheel, { capture: true });
			for (const actor of Object.values(people)) world.sim.leave(actor.person);
		};
	}, [flow, store, loop, world, reduced, marks]);

	return (
		<>
			<Marks store={marks} />
			<div ref={cover} className="embed-cover" aria-hidden="true" data-mode={mode} />
		</>
	);
}

/** What the people do that the board doesn't draw for them: a marquee, a click. */
function Marks({ store }: { store: MarksStore }) {
	const marks = useSyncExternalStore(store.subscribe, store.get);
	const flow = useReactFlow();
	const marquee = useMemo(() => {
		if (!marks.marquee) return null;
		const { rect, color } = marks.marquee;
		const a = flow.flowToScreenPosition({ x: rect.x, y: rect.y });
		const b = flow.flowToScreenPosition({ x: rect.x + rect.w, y: rect.y + rect.h });
		return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y, color };
	}, [marks.marquee, flow]);
	return (
		<div className="embed-marks" aria-hidden="true">
			{marquee && (
				<div
					className="embed-marquee"
					style={{
						left: marquee.left,
						top: marquee.top,
						width: Math.max(0, marquee.width),
						height: Math.max(0, marquee.height),
						["--who" as string]: marquee.color,
					}}
				/>
			)}
			{marks.clicks.map((click) => (
				<span
					key={click.n}
					className="embed-click"
					style={{ left: click.x, top: click.y, ["--who" as string]: click.color }}
				/>
			))}
		</div>
	);
}

/**
 * The corner: while it plays, that it's live and yours to try; once it's
 * yours, a word saying so and the way to the full demo.
 */
function Corner({ mode, href }: { mode: Mode; href: string }) {
	const yours = mode === "yours";
	return (
		<div className="embed-corner" data-mode={mode}>
			{yours ? (
				<>
					<span className="embed-yours" role="status">
						Your turn
					</span>
					<a className="embed-full" href={href} target="_top">
						Open the full demo <span aria-hidden="true">→</span>
					</a>
				</>
			) : (
				<span className="embed-live">
					<span className="embed-live-dot" aria-hidden="true" />
					Live demo · click to try it
				</span>
			)}
		</div>
	);
}
