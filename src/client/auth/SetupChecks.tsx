import { useEffect, useId, useRef, useState } from "react";
import type { WebhookHealth } from "../../shared/auth.ts";
import {
	type Loaded,
	type SetupStep,
	type WebhookWords,
	describeWebhooks,
	focusStep,
	generateSecret,
} from "./setupChecks.ts";

/**
 * The setup checklist (#55): each step of getting an instance ready, with
 * how it stands, linking to its part of the page. Steps check off in turn
 * as the page arrives.
 */
export function Checklist({ steps }: { steps: SetupStep[] }) {
	const focus = focusStep(steps);
	const done = steps.filter((step) => step.tone === "done").length;
	// The track fills to the last of the steps done in a row from the start.
	const lead = steps.findIndex((step) => step.tone !== "done");
	const filled = lead === -1 ? steps.length - 1 : Math.max(0, lead - 1);
	return (
		<nav className="checklist" aria-label="Setup checklist">
			<p className="checklist-count" aria-live="polite">
				{done === steps.length ? "All set" : `${done} of ${steps.length} done`}
			</p>
			<ol style={{ "--done": filled / Math.max(1, steps.length - 1) } as React.CSSProperties}>
				{steps.map((step, i) => (
					<li
						key={step.id}
						className="checklist-step"
						data-tone={step.tone}
						data-focus={step.id === focus || undefined}
						aria-current={step.id === focus ? "step" : undefined}
						style={{ "--i": i } as React.CSSProperties}
					>
						<a href={`#setup-${step.id}`}>
							<span className="checklist-mark" aria-hidden="true">
								<StepGlyph tone={step.tone} n={i + 1} />
							</span>
							<span className="checklist-words">
								<strong>{step.label}</strong>
								<span>{step.detail}</span>
							</span>
							<span className="visually-hidden">{TONE_WORDS[step.tone]}</span>
						</a>
					</li>
				))}
			</ol>
		</nav>
	);
}

const TONE_WORDS: Record<SetupStep["tone"], string> = {
	done: "(done)",
	current: "(next)",
	warn: "(worth a look)",
	fail: "(needs fixing)",
	waiting: "(waiting)",
	todo: "(later)",
};

function StepGlyph({ tone, n }: { tone: SetupStep["tone"]; n: number }) {
	if (tone === "done") {
		return (
			<svg width="14" height="14" viewBox="0 0 16 16">
				<path className="checklist-tick" d="M3.5 8.5l3 3 6-7" />
			</svg>
		);
	}
	if (tone === "warn" || tone === "fail") {
		return (
			<svg width="14" height="14" viewBox="0 0 16 16">
				{tone === "warn" ? <path d="M8 4v5M8 12v.1" /> : <path d="M5 5l6 6M11 5l-6 6" />}
			</svg>
		);
	}
	if (tone === "waiting") {
		return (
			<span className="checklist-dots">
				<i />
				<i />
				<i />
			</span>
		);
	}
	return <>{n}</>;
}

export async function fetchWebhooks(): Promise<WebhookHealth> {
	const response = await fetch("/api/setup/webhooks", { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`${response.status}`);
	return (await response.json()) as WebhookHealth;
}

/**
 * Whether GitHub's webhooks reach this instance, for admins on `/setup`:
 * how the latest delivery went, and what to do when it didn't.
 */
export function WebhookCheck({
	appSettingsUrl,
	load = fetchWebhooks,
	onChange,
}: {
	appSettingsUrl: string;
	load?: () => Promise<WebhookHealth>;
	onChange?: (state: Loaded<WebhookHealth>) => void;
}) {
	const [state, setState] = useState<Loaded<WebhookHealth>>({ status: "loading" });
	const [round, setRound] = useState(0);
	const title = useId();
	const changed = useRef(onChange);
	changed.current = onChange;

	useEffect(() => {
		let cancelled = false;
		const set = (next: Loaded<WebhookHealth>) => {
			if (cancelled) return;
			setState(next);
			changed.current?.(next);
		};
		set({ status: "loading" });
		load()
			.then((value) => set({ status: "ready", value }))
			.catch(() => set({ status: "failed" }));
		return () => {
			cancelled = true;
		};
	}, [load, round]);

	const words: WebhookWords | null =
		state.status === "ready"
			? describeWebhooks(state.value)
			: state.status === "failed"
				? {
						tone: "off",
						label: "Couldn’t check",
						detail: "Tack couldn’t ask GitHub about its deliveries. Try again in a moment.",
					}
				: null;

	return (
		<section
			id="setup-webhooks"
			className="installs webhook-check"
			aria-labelledby={title}
			aria-busy={state.status === "loading"}
		>
			<div className="installs-head">
				<h2 id={title}>Webhooks</h2>
				{state.status !== "loading" && (
					<button type="button" className="installs-refresh" onClick={() => setRound((n) => n + 1)}>
						Check again
					</button>
				)}
			</div>
			<p className="auth-note">
				GitHub tells Tack when issues and pull requests change, so cards update live.
			</p>
			{!words ? (
				<div className="install install-skeleton" />
			) : (
				<div className="install webhook" data-tone={words.tone} key={round}>
					<div className="install-head">
						<span className="install-status" data-tone={words.tone}>
							<WebhookGlyph tone={words.tone} />
							{words.label}
						</span>
					</div>
					<p className="install-detail">{words.detail}</p>
					{words.fix && (
						<p className="install-detail webhook-fix">
							{words.fix}
							{words.settings && (
								<>
									{" "}
									<a className="install-settings" href={appSettingsUrl}>
										App settings
									</a>
								</>
							)}
						</p>
					)}
				</div>
			)}
		</section>
	);
}

function WebhookGlyph({ tone }: { tone: "ok" | "warn" | "fail" | "wait" | "off" }) {
	return (
		<svg className="icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
			{tone === "ok" ? (
				<path d="M3.5 8.5l3 3 6-7" />
			) : tone === "fail" ? (
				<path d="M5 5l6 6M11 5l-6 6" />
			) : tone === "warn" ? (
				<>
					<path d="M8 2.5l6 11H2z" />
					<path d="M8 7v3M8 12v.1" />
				</>
			) : tone === "wait" ? (
				<>
					<circle cx="8" cy="8" r="5.75" />
					<path d="M8 5v3.2l2 1.3" />
				</>
			) : (
				<>
					<circle cx="8" cy="8" r="5.75" />
					<path d="M5.5 8h5" />
				</>
			)}
		</svg>
	);
}

/**
 * How to give the Worker its secret: a fresh one made in this browser (it
 * never leaves it), the commands, and where it goes in the dashboard.
 */
export function SecretHelp({ onCheck }: { onCheck?: () => void }) {
	const [secret, setSecret] = useState(() => generateSecret());
	const [copied, setCopied] = useState<"secret" | "command" | null>(null);
	const command = "pnpm exec cf workers secrets update TACK_SECRET";

	const copy = (what: "secret" | "command", text: string) => {
		void navigator.clipboard?.writeText(text).then(
			() => {
				setCopied(what);
				setTimeout(() => setCopied((current) => (current === what ? null : current)), 1600);
			},
			() => {},
		);
	};

	return (
		<div className="secret-help" id="setup-secret">
			<ol className="setup-steps">
				<li>
					Take this one, made in your browser just now (it never leaves it), or make your own with{" "}
					<code>openssl rand -base64 32</code>.
					<div className="secret-value">
						<code aria-label="A new secret">{secret}</code>
						<button
							type="button"
							className="secret-copy"
							data-copied={copied === "secret" || undefined}
							onClick={() => copy("secret", secret)}
						>
							{copied === "secret" ? "Copied" : "Copy"}
						</button>
						<button
							type="button"
							className="secret-copy"
							aria-label="Make another"
							onClick={() => {
								setSecret(generateSecret());
								setCopied(null);
							}}
						>
							<svg className="icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
								<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />
							</svg>
						</button>
					</div>
				</li>
				<li>
					Add it to the Worker as a secret named <code>TACK_SECRET</code>, from your copy of Tack:
					<div className="secret-value">
						<code>{command}</code>
						<button
							type="button"
							className="secret-copy"
							data-copied={copied === "command" || undefined}
							onClick={() => copy("command", command)}
						>
							{copied === "command" ? "Copied" : "Copy"}
						</button>
					</div>
					or in the Cloudflare dashboard: Workers &amp; Pages → your Worker → Settings → Variables
					and secrets.
				</li>
				<li>
					Keep a copy somewhere safe, and <strong>never change it</strong>: it encrypts the GitHub
					App’s credentials and everyone’s tokens.
				</li>
			</ol>
			{onCheck && (
				<button type="button" className="auth-button primary" onClick={onCheck}>
					I’ve set it: check again
				</button>
			)}
		</div>
	);
}
