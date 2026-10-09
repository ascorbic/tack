import { useState } from "react";
import type { Card, MissingCard } from "../../shared/cards.ts";
import { CardView } from "../CardView.tsx";
import { GALLERY_CARDS, LABELS } from "./fixtures.ts";

const MISSING: { label: string; card: MissingCard }[] = [
	{
		label: "No access",
		card: { key: "fake.tack/acme/private#12", missing: true, reason: "forbidden" },
	},
	{
		label: "Not found",
		card: { key: "fake.tack/acme/imagekit#9999", missing: true, reason: "not_found" },
	},
	{
		label: "Unsupported forge",
		card: { key: "fake.tack/acme/other!3", missing: true, reason: "unsupported" },
	},
	{
		label: "Forge unreachable",
		card: { key: "fake.tack/acme/imagekit#77", missing: true, reason: "error" },
	},
];

const STICKY_COLORS = ["yellow", "pink", "blue", "green", "purple"];

/** Apply a plausible webhook-style change, to replay update animations. */
function mutate(card: Card, round: number): Card {
	const changes: Partial<Card>[] = [
		{ comments: card.comments + 2 },
		{ title: `${card.title} (edited)` },
		{ labels: [...card.labels, LABELS.needsReview] },
		card.kind === "pull" ? { state: "merged" } : { state: "closed", stateReason: "completed" },
	];
	return { ...card, ...changes[round % changes.length] };
}

export default function Gallery() {
	const [cards, setCards] = useState(() => GALLERY_CARDS.map((entry) => entry.card));
	const [round, setRound] = useState(0);
	const [motion, setMotion] = useState(false);

	const replay = () => {
		setCards((current) => current.map((card) => mutate(card, round)));
		setRound((r) => r + 1);
	};
	const reset = () => {
		setCards(GALLERY_CARDS.map((entry) => entry.card));
		setRound(0);
	};

	return (
		<div className="gallery" data-motion={motion ? "slow" : undefined}>
			<header className="gallery-head">
				<h1>Card gallery</h1>
				<p>
					Every card in every state. Use “Simulate an update” to replay the live-update animations.
				</p>
				<div className="gallery-actions">
					<button type="button" className="primary" onClick={replay}>
						Simulate an update
					</button>
					<button type="button" onClick={reset}>
						Reset
					</button>
					<label className="play-toggle">
						<input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} />
						Slow motion
					</label>
					<a className="play-link" href="/play">
						← Playground
					</a>
				</div>
			</header>

			<section>
				<h2>Cards</h2>
				<div className="gallery-grid">
					{cards.map((card, i) => (
						<figure key={card.key}>
							<CardView card={card} cardKey={card.key} />
							<figcaption>{GALLERY_CARDS[i]?.label}</figcaption>
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Compact (zoomed out)</h2>
				<div className="gallery-grid">
					{cards.slice(0, 4).map((card) => (
						<figure key={card.key}>
							<CardView card={card} cardKey={card.key} compact />
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Selected, loading and unavailable</h2>
				<div className="gallery-grid">
					<figure>
						<CardView card={cards[0]} cardKey="selected" selected />
						<figcaption>Selected</figcaption>
					</figure>
					<figure>
						<CardView card={undefined} cardKey="fake.tack/acme/imagekit#999" />
						<figcaption>Loading</figcaption>
					</figure>
					{MISSING.map(({ label, card }) => (
						<figure key={card.reason}>
							<CardView card={card} cardKey={card.key} />
							<figcaption>{label}</figcaption>
						</figure>
					))}
				</div>
			</section>

			<section>
				<h2>Stickies</h2>
				<div className="gallery-grid stickies">
					{STICKY_COLORS.map((color, i) => (
						<figure key={color}>
							<div
								className="sticky"
								data-color={color}
								style={{ "--tilt": `${(i - 2) * 0.7}deg` } as React.CSSProperties}
							>
								<textarea
									aria-label={`${color} sticky`}
									defaultValue="Provider docs are hard to find"
								/>
							</div>
							<figcaption>{color[0]?.toUpperCase() + color.slice(1)}</figcaption>
						</figure>
					))}
				</div>
			</section>
		</div>
	);
}
