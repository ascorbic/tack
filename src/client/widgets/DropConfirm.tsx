import { useEffect, useMemo, useRef } from "react";
import type * as Y from "yjs";
import type { Stager } from "../../shared/changes.ts";
import { StateIcon } from "../CardView.tsx";
import { scaledDuration } from "../motion.ts";
import { undoToast } from "../actions/toast.ts";
import type { ToastStore } from "../Toasts.tsx";
import type { History } from "../undo.ts";
import { ConfigSheet } from "./ConfigPanel.tsx";
import { StepIcon, WarnIcon } from "./icons.tsx";
import { stepText } from "./ListView.tsx";
import { type CardPlan, stageDrop } from "./match.ts";

// Drop to match (#39): after cards are dropped on a list, the changes that
// would make them match it, to stage with one click (or Enter). Nothing is
// written to the forge: they're pending changes, pushed from the changes
// panel like any other. When it can't be done, it says why.

/** How long "already matches" stays up before getting out of the way. */
const MATCHES_LINGER_MS = 1800;

export function DropConfirm({
	doc,
	title,
	plans,
	stager,
	toasts,
	history,
	onClose,
}: {
	doc: Y.Doc;
	/** The list's title. */
	title: string;
	plans: CardPlan[];
	stager: Stager;
	toasts: ToastStore | null;
	history: History | null;
	onClose: () => void;
}) {
	const changing = plans.filter((p) => p.plan.status === "changes");
	const impossible = plans.filter((p) => p.plan.status === "impossible");
	const matching = plans.filter((p) => p.plan.status === "matches");
	const count = useMemo(
		() => changing.reduce((n, p) => n + (p.plan.status === "changes" ? p.plan.steps.length : 0), 0),
		[changing],
	);
	const close = useRef(onClose);
	close.current = onClose;

	// Nothing to do: say so, briefly.
	const nothing = changing.length === 0 && impossible.length === 0;
	useEffect(() => {
		if (!nothing) return;
		const timer = setTimeout(() => close.current(), scaledDuration(MATCHES_LINGER_MS) || 1);
		return () => clearTimeout(timer);
	}, [nothing]);

	const stage = () => {
		const ids = stageDrop(doc, changing, stager);
		const cards = changing.length;
		const who = cards === 1 ? (changing[0]?.card?.item ?? "it") : `${cards} cards`;
		const message = `Staged ${ids.length} ${ids.length === 1 ? "change" : "changes"} so ${who} match${cards === 1 ? "es" : ""} “${title}”`;
		if (toasts && history) undoToast(toasts, history, message);
		else toasts?.show({ message });
		onClose();
	};

	const heading =
		changing.length > 0
			? `Make ${changing.length === 1 ? (changing[0]?.card?.item ?? "it") : `${changing.length} cards`} match`
			: impossible.length > 0
				? "Can't make it match"
				: matching.length > 1
					? "They already match"
					: "Already matches";

	return (
		<ConfigSheet label={heading} onClose={onClose}>
			<div
				className="widget-match"
				data-status={
					changing.length > 0 ? "changes" : impossible.length > 0 ? "impossible" : "matches"
				}
			>
				<header className="widget-config-head">
					<h3>{heading}</h3>
					<p>
						{changing.length > 0
							? `So ${changing.length === 1 ? "it shows" : "they show"} in “${title}”. Staged, not pushed.`
							: `“${title}”`}
					</p>
				</header>
				{changing.map(({ shape, card, plan }) =>
					plan.status === "changes" && card ? (
						<section key={shape} className="widget-match-card" data-state={card.state}>
							<p className="widget-match-item">
								<span className="state-icon">
									<StateIcon card={card} size={13} />
								</span>
								<span className="mono">{card.item}</span>
								<span className="widget-match-title">{card.title}</span>
							</p>
							<ul className="widget-steps" aria-label={`Changes for ${card.item}`}>
								{plan.steps.map((step, i) => (
									<li
										key={`${step.kind}:${step.label}`}
										className="widget-step"
										data-kind={step.kind}
										style={{ "--i": i } as React.CSSProperties}
									>
										<StepIcon kind={step.kind} />
										{stepText(step)}
									</li>
								))}
							</ul>
						</section>
					) : null,
				)}
				{impossible.map(({ shape, card, plan }) =>
					plan.status === "impossible" ? (
						<section key={shape} className="widget-match-card" data-impossible>
							{card && (
								<p className="widget-match-item">
									<span className="mono">{card.item}</span>
									<span className="widget-match-title">{card.title}</span>
								</p>
							)}
							<ul className="widget-match-reasons">
								{plan.reasons.map((reason) => (
									<li key={reason}>
										<WarnIcon size={13} />
										{reason}
									</li>
								))}
							</ul>
						</section>
					) : null,
				)}
				<footer className="widget-config-foot">
					{changing.length > 0 ? (
						<>
							<button type="button" onClick={onClose}>
								Cancel
							</button>
							<button type="button" className="primary" data-autofocus onClick={stage}>
								Stage {count} {count === 1 ? "change" : "changes"}
							</button>
						</>
					) : (
						<button type="button" className="primary" data-autofocus onClick={onClose}>
							OK
						</button>
					)}
				</footer>
			</div>
		</ConfigSheet>
	);
}
