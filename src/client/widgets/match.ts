import type * as Y from "yjs";
import { stageTriage } from "../../shared/actions.ts";
import { type Card, type MissingCard, isMissing } from "../../shared/cards.ts";
import type { Stager } from "../../shared/changes.ts";
import { type MatchPlan, type MatchStep, parseSearch, planMatch } from "../../shared/search.ts";
import { readShape, shapesMap, transactLocal } from "../../shared/shapes.ts";
import type { ListConfig } from "../../shared/widgetRegistry.ts";
import type { DropPreview } from "./ListView.tsx";

// Drop to match (#39): what dropping cards on a list would change to make
// them match its search, and staging it, as one undo step, through the same
// triage changes the selection actions stage.

export interface CardPlan {
	shape: string;
	key: string;
	card: Card | null;
	plan: MatchPlan;
}

/** The plan for each card shape dropped on a list with this config. */
export function planDrop(
	doc: Y.Doc,
	shapes: string[],
	config: Pick<ListConfig, "q" | "host">,
	viewer: string | null | undefined,
	cardOf: (key: string) => Card | MissingCard | undefined,
): CardPlan[] {
	const parsed = parseSearch(config.q);
	const map = shapesMap(doc);
	return shapes.flatMap((shape): CardPlan[] => {
		const raw = map.get(shape);
		const props = raw ? readShape(raw) : null;
		if (props?.type !== "card" || !props.ref) return [];
		const key = props.ref;
		const entry = cardOf(key);
		if (!entry || isMissing(entry)) {
			return [
				{
					shape,
					key,
					card: null,
					plan: {
						status: "impossible",
						reasons: [
							entry?.reason === "private"
								? "Tack can't see this card's repository for you."
								: "This card hasn't loaded, so Tack can't tell what it needs.",
						],
					},
				},
			];
		}
		if (entry.writable === false) {
			return [
				{
					shape,
					key,
					card: entry,
					plan: {
						status: "impossible",
						reasons: [`Tack can't change items in ${entry.repo}: the app isn't installed there.`],
					},
				},
			];
		}
		return [
			{ shape, key, card: entry, plan: planMatch(entry, parsed, { viewer, host: config.host }) },
		];
	});
}

/** What the plans add up to, for the list's overlay while cards are dragged over it. */
export function previewOf(plans: CardPlan[]): DropPreview | null {
	if (plans.length === 0) return null;
	const impossible = plans.find((p) => p.plan.status === "impossible");
	if (impossible && impossible.plan.status === "impossible") {
		const name = impossible.card ? `${impossible.card.item}: ` : "";
		return {
			status: "impossible",
			reason: `${plans.length > 1 ? name : ""}${impossible.plan.reasons[0] ?? ""}`,
		};
	}
	const changing = plans.filter((p) => p.plan.status === "changes");
	if (changing.length === 0) return { status: "matches", cards: plans.length };
	const steps = new Map<string, Pick<MatchStep, "kind" | "label">>();
	for (const { plan } of changing) {
		if (plan.status !== "changes") continue;
		for (const step of plan.steps)
			steps.set(`${step.kind}:${step.label}`, { kind: step.kind, label: step.label });
	}
	return { status: "changes", steps: [...steps.values()], cards: changing.length };
}

/** Stage every plan's changes, as one undo step. Returns the ids of the changes staged or updated. */
export function stageDrop(doc: Y.Doc, plans: CardPlan[], stager: Stager): string[] {
	return transactLocal(doc, () =>
		plans.flatMap(({ shape, key, card, plan }) => {
			if (plan.status !== "changes" || !card) return [];
			return plan.edits.flatMap((edit) => {
				const current =
					edit.kind === "item.labels"
						? card.labels.map((label) => label.name)
						: edit.kind === "item.assignees"
							? card.assignees.map((a) => a.login)
							: undefined;
				const discussion = card.kind === "discussion";
				return stageTriage(doc, [{ key, shape, current, discussion }], edit, stager);
			});
		}),
	);
}
