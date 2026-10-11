import type { AiStatus } from "../../shared/auth.ts";

/** What each state means, in a line. */
function explain(status: AiStatus): string {
	switch (status.state) {
		case "on":
			return status.provider === "fake"
				? "Local development’s stand-in answers, from the stickies’ own words: nothing leaves this machine."
				: "Workers AI names piles from what their stickies say and groups a selection, on this Cloudflare account’s Workers AI allocation. Face-down stickies are never sent.";
		case "off":
			return "Turned off (TACK_AI is “off”): piles are called “Untitled pile” until someone names them.";
		case "unavailable":
			return "There’s no Workers AI binding to ask, so piles are called “Untitled pile” until someone names them.";
	}
}

/** /setup's AI suggestions (#73): whether they're on, and what that means. */
export function AiSuggestions({ status }: { status: AiStatus }) {
	return (
		<section className="setup-ai" aria-labelledby="setup-ai">
			<div className="setup-ai-head">
				<h2 id="setup-ai">
					<span className="setup-ai-spark" aria-hidden="true">
						✨
					</span>
					AI suggestions
				</h2>
				<span className="setup-ai-state" data-state={status.state}>
					{status.state === "on" ? "On" : status.state === "off" ? "Off" : "Unavailable"}
				</span>
			</div>
			<p className="auth-note">
				{explain(status)}
				{status.provider === "workers-ai" && (
					<>
						{" "}
						Model: <code>{status.model}</code>.
					</>
				)}
			</p>
		</section>
	);
}
