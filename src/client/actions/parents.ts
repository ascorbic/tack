import { useCallback, useEffect, useMemo, useState } from "react";
import type { KnownParent } from "../../shared/actions.ts";
import { isMissing } from "../../shared/cards.ts";
import { cardStore } from "../cardStore.ts";
import type { WriteServices } from "./services.ts";

// Which parent issue each card already has, for making a parent issue
// without asking GitHub for a second parent it won't give. Cards say, once
// they've been read in full (`Card.parent`); for the rest, the related
// route asks the forge, as Expand related does.

/** At most this many cards are looked up one by one; the rest count as unknown. */
const MAX_LOOKUPS = 24;
/** Stop waiting after this long: the push explains a refusal anyway. */
const GIVE_UP_MS = 6000;

/** What a card says about its parent, if it says. */
function fromCard(key: string): KnownParent | undefined {
	const card = cardStore.get(key);
	if (!card || isMissing(card) || card.parent === undefined) return undefined;
	return {
		key: card.parent?.key ?? null,
		...(card.parent?.title ? { title: card.parent.title } : {}),
		at: card.updatedAt,
	};
}

/**
 * The parents of these cards (item keys), and whether any are still being
 * looked up. Looked up once, when the keys change.
 */
export function useKnownParents(
	keys: readonly string[],
	services: Pick<WriteServices, "related">,
): { known: (key: string) => KnownParent | undefined; checking: boolean } {
	const id = keys.join("\n");
	// Cards that don't say, to ask about.
	const ask = useMemo(
		() => (id ? id.split("\n") : []).filter((key) => !fromCard(key)).slice(0, MAX_LOOKUPS),
		[id],
	);
	const [answers, setAnswers] = useState<{ id: string; found: Map<string, KnownParent> }>({
		id: "",
		found: new Map(),
	});
	const [gaveUp, setGaveUp] = useState("");

	useEffect(() => {
		if (ask.length === 0) return;
		let live = true;
		const found = new Map<string, KnownParent>();
		const timer = setTimeout(() => live && setGaveUp(id), GIVE_UP_MS);
		void Promise.all(
			ask.map(async (key) => {
				const result = await services.related(key);
				if (result.kind !== "related") return;
				const parent = result.parent ?? null;
				const card = parent ? result.cards.find((c) => c.key === parent) : undefined;
				found.set(key, {
					key: parent,
					...(card && !isMissing(card) ? { title: card.title } : {}),
				});
			}),
		).then(() => {
			clearTimeout(timer);
			if (live) setAnswers({ id, found });
		});
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [ask, id, services]);

	const checking = ask.length > 0 && answers.id !== id && gaveUp !== id;
	const known = useCallback(
		(key: string) => fromCard(key) ?? (answers.id === id ? answers.found.get(key) : undefined),
		[answers, id],
	);
	return { known, checking };
}
