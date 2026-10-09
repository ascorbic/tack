import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { shortRef } from "../../shared/rules.ts";
import { LABELS } from "./fixtures.ts";
import { SimulatedAutomation } from "./automation.ts";

// The playground's controls for inbox frames and rules: webhooks from a
// pretend forge, which inboxes search and rules run on in the browser.

export function AutomationPlay({ doc }: { doc: Y.Doc }) {
	const automation = useMemo(() => new SimulatedAutomation(doc), [doc]);
	useEffect(() => {
		const uninstall = automation.install();
		Object.assign(window, { tackAutomation: automation });
		return uninstall;
	}, [automation]);
	const [note, setNote] = useState<string | null>(null);
	useEffect(() => setNote(null), [automation]);

	return (
		<div className="play-section">
			<h2 className="play-label">Inboxes and rules</h2>
			<div className="play-buttons">
				<button
					type="button"
					onClick={() => {
						const { card } = automation.openIssue();
						setNote(`Opened ${shortRef(card.key)}, unlabelled: inboxes searching for it get it.`);
					}}
				>
					New issue
				</button>
				<button
					type="button"
					onClick={() => {
						setNote("Four new issues, one after another.");
						void automation.burst(4);
					}}
				>
					Burst of issues
				</button>
				<button
					type="button"
					onClick={() => {
						const card = automation.labelSomething();
						setNote(
							card
								? `Labelled ${shortRef(card.key)} “bug”: it no longer matches an untriaged inbox.`
								: "Nothing unlabelled to label.",
						);
					}}
				>
					Label an issue
				</button>
				<button
					type="button"
					onClick={() => {
						const { card, placed } = automation.openIssue([LABELS.bug]);
						setNote(
							placed > 0
								? `Opened bug ${shortRef(card.key)}, and a rule placed it.`
								: `Opened bug ${shortRef(card.key)}. No rule placed it.`,
						);
					}}
				>
					New bug
				</button>
				<button
					type="button"
					onClick={() => {
						const opened = automation.openPull();
						setNote(
							opened
								? `Opened ${shortRef(opened.pull.key)}, which fixes ${shortRef(opened.closes)}.`
								: "No issue on the board for a pull request to fix.",
						);
					}}
				>
					PR fixes a card
				</button>
			</div>
			<p className="play-hint">
				{note ??
					"Webhooks from a pretend forge. Inboxes search it again; rules run exactly as on the server."}
			</p>
		</div>
	);
}
