import { useState } from "react";
import { tally } from "../../shared/decisions.ts";
import type { DecisionStatus, Vote, VoteChoice } from "../../shared/shapes.ts";
import { cardStore } from "../cardStore.ts";
import { DecisionView, type DecisionViewProps } from "../decisions/DecisionView.tsx";
import { makeChecks, pullDetails } from "./ci.ts";
import { fixture, PLANNING_CARDS } from "./fixtures.ts";

// Every decision state, for the gallery: proposed and being voted on,
// decided (with the stamp landing), each step of writing it back, and
// superseded.

const PRIYA = { name: "Priya Shah", color: "#b4467a", login: "priya" };
const KAI = { name: "Kai Andersen", color: "#1f7a6b", login: "kai" };
const TOM = { name: "Tom Okafor", color: "#a35a12", login: "tom" };
const JO = { name: "Jo Rivera", color: "#5b5fc7", login: "jo" };
const SAM = { name: "Sam Lee", color: "#2a7ab0", login: "sam" };

function votes(...cast: [typeof PRIYA, VoteChoice][]): ReturnType<typeof tally> {
	const record: Record<string, Vote> = {};
	cast.forEach(([person, choice], i) => {
		record[`@${person.login}`] = {
			choice,
			name: person.name,
			color: person.color,
			login: person.login,
			at: `2026-10-0${i + 1}T10:00:00Z`,
		};
	});
	return tally(record);
}

const RECORD_OPEN = fixture({
	item: "#432",
	kind: "pull",
	title: "ADR 0004: Serve AVIF by default",
	pull: pullDetails({ checks: makeChecks({ passed: 5, pending: 2 }) }),
});
const RECORD_MERGED = fixture({
	item: "#431",
	kind: "pull",
	state: "merged",
	title: "ADR 0003: Adopt Conventional Commits",
	pull: pullDetails({ checks: makeChecks({ passed: 7 }) }),
});

const LINKED = PLANNING_CARDS.slice(0, 2).map((card) => card.key);
const MANY_LINKED = PLANNING_CARDS.slice(0, 5).map((card) => card.key);
const DECIDED_AT = "2026-10-09T14:30:00Z";

const AVIF = {
	title: "Serve AVIF by default",
	text: "Every CDN we support can now transcode AVIF, and it's 20–30% smaller than WebP at the same quality.",
	votes: votes([JO, "agree"], [PRIYA, "agree"], [KAI, "agree"], [TOM, "disagree"]),
	author: JO,
	decidedBy: JO,
	decidedAt: DECIDED_AT,
	linked: LINKED,
};

interface Sample {
	label: string;
	status: DecisionStatus;
	props: Omit<DecisionViewProps, "status" | "votes" | "title" | "text"> &
		Partial<Pick<DecisionViewProps, "votes" | "title" | "text">>;
}

const SAMPLES: Sample[] = [
	{
		label: "New, being written",
		status: "proposed",
		props: { title: "", text: "", author: PRIYA, selected: true, editing: true },
	},
	{
		label: "Proposed, no votes yet",
		status: "proposed",
		props: {
			title: "Move the docs to Starlight",
			text: "Our hand-rolled docs site has no search and no versioning.",
			author: KAI,
		},
	},
	{
		label: "Votes coming in, you agree",
		status: "proposed",
		props: {
			title: "Require Node 20 in unpic 5.0",
			text: "Node 18 is end-of-life in April. Keeping it costs a CI runner per job and blocks the native fetch cleanup.",
			votes: votes(
				[PRIYA, "agree"],
				[KAI, "agree"],
				[TOM, "disagree"],
				[JO, "agree"],
				[SAM, "agree"],
			),
			myVote: "agree",
			author: PRIYA,
			linked: LINKED,
			selected: true,
		},
	},
	{
		label: "Just decided",
		status: "decided",
		props: { ...AVIF, stamp: true },
	},
	{
		label: "Write-back staged",
		status: "decided",
		props: { ...AVIF, writeBack: { kind: "pr", status: "staged", label: "ADR 0004" } },
	},
	{
		label: "Pushing",
		status: "decided",
		props: { ...AVIF, writeBack: { kind: "pr", status: "sending", label: "ADR 0004" } },
	},
	{
		label: "ADR open, checks running",
		status: "decided",
		props: {
			...AVIF,
			writeBack: { kind: "pr", status: "applied", label: "ADR 0004", cardKey: RECORD_OPEN.key },
		},
	},
	{
		label: "ADR merged",
		status: "decided",
		props: {
			title: "Adopt Conventional Commits",
			text: "So release notes and version bumps can be generated from history.",
			consequences: "Commit messages need a type. A lint check in CI enforces it.",
			votes: votes([TOM, "agree"], [JO, "agree"]),
			decidedBy: TOM,
			decidedAt: DECIDED_AT,
			writeBack: { kind: "pr", status: "applied", label: "ADR 0003", cardKey: RECORD_MERGED.key },
		},
	},
	{
		label: "Posted as a Discussion",
		status: "decided",
		props: {
			...AVIF,
			linked: [],
			writeBack: {
				kind: "discussion",
				status: "applied",
				label: "Decisions",
				url: "https://fake.tack/acme/unpic/discussions/18",
			},
		},
	},
	{
		label: "Write-back failed",
		status: "decided",
		props: {
			...AVIF,
			linked: [],
			writeBack: {
				kind: "pr",
				status: "failed",
				label: "ADR 0004",
				error: "Reference already exists: tack/adr-0004-serve-avif-by-default",
			},
		},
	},
	{
		label: "Superseded",
		status: "superseded",
		props: {
			title: "Keep Node 16 until 5.0",
			text: "Enterprise users asked for one more major on 16.",
			votes: votes([KAI, "agree"], [PRIYA, "disagree"]),
			decidedBy: KAI,
			decidedAt: "2026-03-02T10:00:00Z",
			supersededBy: { title: "Require Node 20 in unpic 5.0" },
		},
	},
	{
		label: "Many linked items",
		status: "proposed",
		props: {
			title: "Cut 5.0 scope to providers and docs",
			text: "",
			author: TOM,
			votes: votes([TOM, "agree"]),
			linked: MANY_LINKED,
		},
	},
	{
		label: "View only",
		status: "proposed",
		props: {
			title: "Require Node 20 in unpic 5.0",
			text: "Node 18 is end-of-life in April.",
			votes: votes([PRIYA, "agree"], [TOM, "disagree"]),
			author: PRIYA,
			readOnly: true,
		},
	},
];

export function DecisionGallery() {
	// The cards decisions link to and were written back as, as live data.
	useState(() => {
		for (const card of [...PLANNING_CARDS, RECORD_OPEN, RECORD_MERGED]) cardStore.set(card);
		return null;
	});
	return (
		<section>
			<h2>Decisions</h2>
			<div className="gallery-grid decisions">
				{SAMPLES.map(({ label, status, props }) => (
					<figure key={label}>
						<DecisionView
							title=""
							text=""
							votes={votes()}
							{...props}
							status={status}
							onVote={() => {}}
						/>
						<figcaption>{label}</figcaption>
					</figure>
				))}
			</div>
		</section>
	);
}
