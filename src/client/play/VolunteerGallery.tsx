import type { Card } from "../../shared/cards.ts";
import { CardView } from "../CardView.tsx";
import { StickyView } from "../StickyNode.tsx";
import type { ShownVolunteer } from "../volunteers/assign.ts";
import { HandButton, VolunteersRow } from "../volunteers/Volunteers.tsx";

// Every state of volunteering on a card and a sticky (volunteers/), in
// `/play/cards`: the row at rest, yours among them, staged to be assigned,
// many, and the hand before anyone's volunteered.

const noop = () => {};

const hand = (login: string, name: string, color: string, staged = false): ShownVolunteer => ({
	shape: "gallery",
	login,
	name,
	color,
	at: "2026-10-14T10:00:00Z",
	...(staged ? { staged: true } : {}),
});

const KAI = hand("kai", "Kai Andersen", "#1f7a6b");
const PRIYA = hand("priya", "Priya Shah", "#b4467a");
const TOM = hand("tom", "Tom Okafor", "#a35a12");
const JO = hand("jo", "Jo Rivera", "#5b5fc7");
/** You, in the gallery. */
const YOU = hand("ana", "Ana Lima", "#7444c4");

const ASSIGN = { onAssign: noop, tooltip: "Stage assigning Kai Andersen, Priya Shah" };

export function VolunteerGallery({ card }: { card: Card | undefined }) {
	if (!card) return null;
	const row = (
		volunteers: ShownVolunteer[],
		options: { mine?: boolean; assign?: boolean } = {},
	) => (
		<VolunteersRow
			volunteers={volunteers}
			me="ana"
			place="card"
			toggle={{ pressed: !!options.mine, onToggle: noop }}
			assign={options.assign ? ASSIGN : undefined}
		/>
	);
	return (
		<section>
			<h2>Volunteers</h2>
			<p className="gallery-note">
				Hands up for the work, on the board only: hover or select a card or sticky and ✋ to
				volunteer, again to withdraw. Assign stages them as the item’s assignees; the dashed ring is
				staged, and once it’s pushed they’re among its assignees instead.
			</p>
			<div className="gallery-grid">
				<figure>
					<CardView card={card} cardKey={card.key} volunteers={row([KAI, PRIYA])} />
					<figcaption>Two volunteers, at rest</figcaption>
				</figure>
				<figure>
					<CardView
						card={card}
						cardKey={card.key}
						selected
						volunteers={row([YOU, KAI, PRIYA], { mine: true, assign: true })}
					/>
					<figcaption>Yours among them, selected: withdraw, or Assign</figcaption>
				</figure>
				<figure>
					<CardView
						card={card}
						cardKey={card.key}
						volunteers={row([hand("kai", "Kai Andersen", "#1f7a6b", true), PRIYA])}
					/>
					<figcaption>Kai staged to be assigned</figcaption>
				</figure>
				<figure>
					<CardView
						card={card}
						cardKey={card.key}
						volunteers={row([KAI, PRIYA, TOM, JO, YOU], { mine: true })}
					/>
					<figcaption>More than fit: +2</figcaption>
				</figure>
				<figure>
					<CardView
						card={card}
						cardKey={card.key}
						selected
						hand={<HandButton place="head" pressed={false} onToggle={noop} />}
					/>
					<figcaption>Nobody yet, selected: the hand beside ↗</figcaption>
				</figure>
			</div>
			<div className="gallery-grid stickies">
				<figure>
					<StickyView
						text="A provider playground"
						color="pink"
						author={KAI}
						volunteers={
							<VolunteersRow
								volunteers={[KAI, TOM]}
								me="ana"
								place="sticky"
								toggle={{ pressed: false, onToggle: noop }}
							/>
						}
					/>
					<figcaption>A sticky’s volunteers, after its author</figcaption>
				</figure>
				<figure>
					<StickyView
						text="Write the 5.0 migration guide first"
						color="green"
						author={PRIYA}
						selected
						volunteers={
							<VolunteersRow
								volunteers={[YOU, hand("jo", "Jo Rivera", "#5b5fc7", true)]}
								me="ana"
								place="sticky"
								toggle={{ pressed: true, onToggle: noop }}
							/>
						}
					/>
					<figcaption>Yours, selected; Jo staged with its new issue</figcaption>
				</figure>
				<figure>
					<StickyView
						text="No author on this one"
						color="blue"
						selected
						hand={<HandButton place="sticky" pressed={false} onToggle={noop} />}
					/>
					<figcaption>Nobody yet, no author: the hand in its corner</figcaption>
				</figure>
			</div>
		</section>
	);
}
