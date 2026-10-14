import {
	type ReactionGroup,
	namePeople,
	namedPerLine,
	namedReactors,
	reactionCount,
} from "../../shared/reactions.ts";
import { knownName, selfLogin } from "./names.ts";
import { ReactionTip, TipLine, useTip } from "./ReactionTip.tsx";
import { type ReactorsState, useReactors } from "./reactors.ts";

// A card's reaction count (❤ 9), and who reacted on hover, focus or a tap:
// one line per kind of reaction, as "👍 Kai Andersen, Priya Shah and 3
// others". Names are asked for only then (reactors.ts); until they come it
// says how many with three dots breathing, and if they can't be had (no
// token, a forge that can't say) just how many.

export function ReactionCount({
	cardKey,
	count,
	force,
	state: forced,
}: {
	cardKey: string;
	count: number;
	/** Show the tip without hovering (the gallery). */
	force?: boolean;
	/** What to show, for the gallery's loading state. */
	state?: ReactorsState;
}) {
	const tip = useTip({ tapOpens: true });
	const fetched = useReactors(cardKey, count, tip.open || Boolean(force));
	const state = forced ?? fetched;
	const lines = state.status === "ready" ? reactionLines(state.groups) : [];
	const label =
		lines.length > 0
			? `${reactionCount(count)}: ${lines.map((line) => `${line.emoji} ${line.said}`).join("; ")}`
			: reactionCount(count);
	return (
		<>
			<button
				type="button"
				ref={(el) => {
					tip.ref.current = el;
				}}
				className="count reactions nodrag nopan"
				aria-label={label}
				data-open={tip.open || undefined}
				{...tip.handlers}
				onClick={(event) => {
					tip.tookClick(event);
				}}
			>
				<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
					<path d="M8 13.5s-5.5-3.2-5.5-7A3 3 0 0 1 8 4.8a3 3 0 0 1 5.5 1.7c0 3.8-5.5 7-5.5 7z" />
				</svg>
				{count}
			</button>
			<ReactionTip tip={tip} force={force}>
				{lines.length > 0 ? (
					lines.map((line) => (
						<TipLine key={line.emoji} emoji={line.emoji}>
							{line.names}
						</TipLine>
					))
				) : (
					<span className="reaction-tip-quiet">
						{reactionCount(count)}
						{state.status === "loading" && (
							<span className="reaction-tip-loading" role="status" aria-label="Loading names">
								<span />
								<span />
								<span />
							</span>
						)}
					</span>
				)}
			</ReactionTip>
		</>
	);
}

/**
 * Each kind of reaction, with who left it as a phrase: to show (`names`,
 * whole names) and to say (`said`). With several kinds, each names fewer,
 * so the tooltip stays a glance.
 */
function reactionLines(
	groups: readonly ReactionGroup[],
): { emoji: string; names: string; said: string }[] {
	const self = selfLogin();
	const shown = groups.filter((group) => group.count > 0);
	const max = namedPerLine(shown.length);
	return shown.map((group) => {
		const people = namedReactors(group.reactors, self, knownName);
		return {
			emoji: group.emoji,
			names: namePeople(people, group.count, { max, whole: true }),
			said: namePeople(people, group.count, { max }),
		};
	});
}
