import { useContext, useEffect, useState } from "react";
import type * as Y from "yjs";
import { isMissing } from "../../shared/cards.ts";
import { stillMatches } from "../../shared/inbox.ts";
import { matchesQuery } from "../../shared/query.ts";
import { describeRule, readRule, rulesMap } from "../../shared/rules.ts";
import { type ShapeProps, shapesMap } from "../../shared/shapes.ts";
import type { Provenance, SearchQuery } from "../../shared/widgets.ts";
import { useCard } from "../cardStore.ts";
import { useDocValue } from "../decisions/useDocValue.ts";
import { DocContext } from "../DocContext.ts";
import { BoltIcon, TrayIcon } from "./icons.tsx";
import { useInbox } from "./store.ts";

// How a card arrived, on its top edge: a quiet glyph for cards an inbox or a
// rule brought (with what brought them on hover), a brief "Placed by rule"
// as a rule's card lands, and "No longer matches" when it stops matching
// what brought it. Automation never moves or removes such a card: it says.

/** How long a rule's card announces itself. */
const FRESH_MS = 3200;

interface Source {
	kind: "inbox" | "rule";
	/** The section's title, or the rule in words. */
	label: string;
	query: SearchQuery | null;
}

function readSource(doc: Y.Doc, provenance: Provenance): Source | null {
	if (provenance.via === "inbox") {
		const section = shapesMap(doc).get(provenance.source);
		if (!section) return { kind: "inbox", label: "a deleted inbox", query: null };
		const inbox = section.get("inbox") as { query?: SearchQuery } | undefined;
		const title = (section.get("title") as string | undefined) || "an untitled section";
		return { kind: "inbox", label: title, query: inbox?.query ?? null };
	}
	if (provenance.via === "rule") {
		const map = rulesMap(doc).get(provenance.source);
		const rule = map ? readRule(map) : null;
		if (!rule) return { kind: "rule", label: "a rule that was deleted", query: null };
		const title = (id: string) =>
			(shapesMap(doc).get(id)?.get("title") as string | undefined) ?? null;
		const { when, does } = describeRule(rule, title);
		return {
			kind: "rule",
			label: `${when}, ${does}`,
			query: rule.trigger.kind === "matches" ? rule.trigger.query : null,
		};
	}
	return null;
}

export function ProvenanceMark({
	shape,
	fresh,
}: {
	shape: Pick<ShapeProps, "provenance" | "ref">;
	fresh: boolean;
}) {
	const provenance = shape.provenance;
	const doc = useContext(DocContext);
	const key = shape.ref ?? "";
	const source = useDocValue(
		doc,
		(d) => (provenance ? readSource(d, provenance) : null),
		`${provenance?.via}:${provenance && "source" in provenance ? provenance.source : ""}`,
	);
	const entry = useInbox(provenance?.via === "inbox" ? provenance.source : "");
	const card = useCard(key);
	const [announcing, setAnnouncing] = useState(fresh && provenance?.via === "rule");
	useEffect(() => {
		if (!announcing) return;
		const timer = setTimeout(() => setAnnouncing(false), FRESH_MS);
		return () => clearTimeout(timer);
	}, [announcing]);

	if (!provenance || !source || (provenance.via !== "inbox" && provenance.via !== "rule")) {
		return null;
	}
	const live = card && !isMissing(card) ? card : undefined;
	let stale = false;
	if (source.query) {
		if (source.kind === "inbox") {
			const result = entry?.result.kind === "search" ? entry.result : undefined;
			stale = stillMatches(key, live, source.query, result) === false;
		} else if (live) {
			stale = matchesQuery(live, source.query) === false;
		}
	}
	const label = stale
		? "No longer matches"
		: source.kind === "rule"
			? "Placed by a rule"
			: `From ${source.label}`;
	const tip = stale
		? source.kind === "inbox"
			? `Sorted from ${source.label}, but it doesn’t match its search any more. Nothing moves it: it’s yours to keep or remove.`
			: `Placed by a rule (${source.label}), but it doesn’t match any more.`
		: source.kind === "rule"
			? `Placed by a rule: ${source.label}.`
			: `Sorted from the ${source.label} inbox.`;

	return (
		<>
			{announcing && <span className="card-arrival" aria-hidden="true" />}
			<span
				className="card-provenance nodrag"
				data-via={source.kind}
				data-stale={stale}
				data-fresh={announcing}
				title={tip}
				role="note"
				aria-label={tip}
			>
				{source.kind === "rule" ? <BoltIcon size={11} /> : <TrayIcon size={11} />}
				<span className="card-provenance-label">{label}</span>
			</span>
		</>
	);
}
