import { useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { type ShapeProps, shapesMap } from "../../shared/shapes.ts";
import {
	type FaceDownCount,
	type SilentSession,
	faceDownCounts,
	parseSession,
	silentSections,
} from "../../shared/silent.ts";
import { DecisionContext } from "../decisions/context.ts";
import { DocContext, ReadOnlyContext } from "../DocContext.ts";
import { initials } from "../People.tsx";
import type { ToastStore } from "../Toasts.tsx";
import { FlipIcon, HushIcon } from "./icons.tsx";
import { facilitation, useRefusal } from "./store.ts";

// Silent mode in a section's header (#49): a way to start it, and while it's
// on, who's written how many (face down), and the reveal.

export function startSilent(section: string, by: { name: string; color: string }): void {
	facilitation.send({ type: "silent-start", section, by: { name: by.name, color: by.color } });
}

export function revealSilent(session: string): void {
	facilitation.send({ type: "silent-reveal", session });
}

/** "Silent" in the header of a section selected on its own. */
export function SilentButton({ id }: { id: string }) {
	const { user } = useContext(DecisionContext);
	return (
		<button
			type="button"
			className="section-silent-start nodrag nopan"
			title="Everyone writes on their own: stickies stay face down until you reveal them"
			onClick={(event) => {
				event.stopPropagation();
				if (user) startSilent(id, user);
			}}
		>
			<HushIcon size={14} />
			Silent mode
		</button>
	);
}

/** Face-down stickies in a session, kept current. */
function useFaceDown(doc: Y.Doc | null, session: string): FaceDownCount[] {
	const store = useMemo(() => {
		let value: FaceDownCount[] = doc ? faceDownCounts(doc, session) : [];
		let key = JSON.stringify(value);
		return {
			get: () => value,
			subscribe: (listener: () => void) => {
				if (!doc) return () => {};
				const shapes = shapesMap(doc);
				const read = () => {
					const next = faceDownCounts(doc, session);
					const nextKey = JSON.stringify(next);
					if (nextKey === key) return;
					key = nextKey;
					value = next;
					listener();
				};
				read();
				shapes.observeDeep(read);
				return () => shapes.unobserveDeep(read);
			},
		};
	}, [doc, session]);
	return useSyncExternalStore(store.subscribe, store.get);
}

/** A silent section's header: who's written how many, and Reveal. */
export function SilentBadge({ shape }: { shape: Pick<ShapeProps, "silent"> }) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	const session = parseSession(shape.silent);
	const counts = useFaceDown(doc, session?.id ?? "");
	if (!session) return null;
	return <SilentBadgeView session={session} counts={counts} canReveal={!readOnly} />;
}

export function SilentBadgeView({
	session,
	counts,
	canReveal,
	onReveal = () => revealSilent(session.id),
}: {
	session: SilentSession;
	counts: FaceDownCount[];
	canReveal: boolean;
	onReveal?: () => void;
}) {
	const total = counts.reduce((n, c) => n + c.count, 0);
	const label = `Silent mode, started by ${session.by.name}: ${
		total === 0 ? "nothing written yet" : counts.map((c) => `${c.name} ${c.count}`).join(", ")
	}`;
	return (
		<span className="section-silent nodrag nopan" role="group" aria-label={label}>
			<span className="section-silent-label" data-tooltip={`Started by ${session.by.name}`}>
				<HushIcon size={13} />
				Silent
			</span>
			{counts.length > 0 && (
				<span className="section-silent-people" aria-hidden="true">
					{counts.slice(0, 5).map((c) => (
						<span
							key={`${c.name}${c.color}`}
							className="section-silent-person"
							style={{ "--author": c.color || "var(--muted)" } as React.CSSProperties}
							data-tooltip={`${c.name}: ${c.count}`}
						>
							<span className="section-silent-initials">{initials(c.name)}</span>
							<span key={c.count} className="section-silent-count">
								{c.count}
							</span>
						</span>
					))}
					{counts.length > 5 && <span className="section-silent-more">+{counts.length - 5}</span>}
				</span>
			)}
			{canReveal && (
				<button
					type="button"
					className="section-silent-reveal"
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						onReveal();
					}}
				>
					<FlipIcon size={14} />
					Reveal{total > 0 ? ` ${total}` : ""}
				</button>
			)}
		</span>
	);
}

const REFUSALS: Record<string, string> = {
	not_facilitator:
		"Only whoever started silent mode, or the board’s owner, can reveal it while they’re here",
	not_editor: "You can only look on this board",
	already_silent: "That section is already in silent mode",
	not_section: "Silent mode works on a section",
	not_yours: "That sticky is someone else’s",
	not_silent: "Silent mode has ended there",
	invalid: "That didn’t work",
};

/**
 * Toasts for silent mode on the whole board: a section going silent, being
 * revealed, and requests the server turned down.
 */
export function useSilentToasts(doc: Y.Doc, toasts: ToastStore): void {
	const known = useRef<Map<string, string> | null>(null);
	useEffect(() => {
		const shapes = shapesMap(doc);
		known.current = silentSections(doc);
		const observer = () => {
			const before = known.current ?? new Map<string, string>();
			const now = silentSections(doc);
			known.current = now;
			for (const [session, section] of before) {
				if (now.has(session)) continue;
				const shape = shapes.get(section);
				if (!shape) continue;
				const title = (shape.get("title") as string | undefined) || "Untitled section";
				toasts.show({ message: `“${title}” revealed` });
			}
			for (const [session, section] of now) {
				if (before.has(session)) continue;
				const shape = shapes.get(section);
				const mark = parseSession(shape?.get("silent"));
				const title = (shape?.get("title") as string | undefined) || "Untitled section";
				toasts.show({
					message: `${mark?.by.name ?? "Someone"} put “${title}” in silent mode: your stickies there are yours alone until the reveal`,
				});
			}
		};
		shapes.observeDeep(observer);
		return () => shapes.unobserveDeep(observer);
	}, [doc, toasts]);

	const refusal = useRefusal();
	const shown = useRef<number | null>(null);
	useEffect(() => {
		if (!refusal || refusal.at === shown.current) return;
		shown.current = refusal.at;
		toasts.show({ message: REFUSALS[refusal.reason] ?? REFUSALS.invalid! });
	}, [refusal, toasts]);
}
