import { useState } from "react";
import type { AiSettings } from "../../shared/auth.ts";

/**
 * /setup's AI suggestions (#73), for admins: naming piles and grouping
 * stickies with Workers AI. Off until an admin turns them on here.
 */
export function AiSuggestions({
	initial,
	save = saveAi,
}: {
	initial: AiSettings;
	/** Where the switch saves (the gallery fakes it). */
	save?: (enabled: boolean) => Promise<AiSettings>;
}) {
	const [settings, setSettings] = useState(initial);
	const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
	const toggle = (enabled: boolean) => {
		setStatus("saving");
		setSettings((current) => ({ ...current, enabled }));
		save(enabled).then(
			(saved) => {
				setSettings(saved);
				setStatus("idle");
			},
			() => {
				setSettings((current) => ({ ...current, enabled: !enabled }));
				setStatus("error");
			},
		);
	};
	return (
		<section className="setup-ai" aria-labelledby="setup-ai">
			<div className="setup-ai-head">
				<h2 id="setup-ai">
					<span className="setup-ai-spark" aria-hidden="true">
						✨
					</span>
					AI suggestions
				</h2>
				{settings.available && (
					<label className="setup-switch">
						<input
							type="checkbox"
							role="switch"
							checked={settings.enabled}
							disabled={status === "saving"}
							aria-label="AI suggestions"
							onChange={(event) => toggle(event.target.checked)}
						/>
						<span aria-hidden="true" />
					</label>
				)}
			</div>
			<p className="auth-note">
				Names piles of stickies from what they say, and sorts a selection of stickies into named
				piles, with Workers AI (<code>{settings.model}</code>). Stickies’ text goes to Workers AI on
				this Tack’s Cloudflare account, which bills each request (a fraction of a cent); face-down
				stickies in silent mode are never sent. Names are only ever suggestions: anyone can rename a
				pile, and a name someone gave it is never replaced.
			</p>
			{!settings.available ? (
				<p className="auth-note setup-ai-state" data-state="unavailable">
					There’s no Workers AI to ask here (local development has none), so suggestions are off.
				</p>
			) : status === "error" ? (
				<p className="auth-note setup-ai-state" data-state="error" role="alert">
					Couldn’t save that. Try again in a moment.
				</p>
			) : (
				<p className="auth-note setup-ai-state" data-state={settings.enabled ? "on" : "off"}>
					{settings.enabled ? "On" : "Off"}
					{settings.by
						? ` since @${settings.by} turned ${settings.enabled ? "them on" : "them off"}`
						: ""}
					{settings.at ? `, ${new Date(settings.at).toLocaleDateString()}` : ""}.
					{settings.enabled ? "" : " Piles are called “Untitled pile” until someone names them."}
				</p>
			)}
		</section>
	);
}

async function saveAi(enabled: boolean): Promise<AiSettings> {
	const response = await fetch("/api/setup/ai", {
		method: "PUT",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ enabled }),
	});
	if (!response.ok) throw new Error(`${response.status}`);
	return (await response.json()) as AiSettings;
}
