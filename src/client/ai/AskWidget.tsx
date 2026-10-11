import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { AiError, WidgetProposal } from "../../shared/ai.ts";
import { AI_PROMPT_MAX } from "../../shared/ai.ts";
import { widgetDefinition } from "../../shared/widgetRegistry.ts";
import { Notice } from "../actions/Popover.tsx";
import { UnknownIcon } from "../widgets/icons.tsx";
import { KIND_ICONS } from "../widgets/WidgetPicker.tsx";
import { describeConfig, widgetSuggestions } from "./describe.ts";
import { SparkIcon } from "./icons.tsx";
import type { AiService } from "./service.ts";
import { WidgetPreview } from "./WidgetPreview.tsx";
import "./ai.css";

// Ask for a widget (#64): describe it in words, and the AI picks a kind and
// configures it, checked against the kind's schema on the server. It's
// previewed live, with real results as you'd see them, before anything's on
// the board; placing it is an ordinary widget added by you (one undo step),
// whose settings stay editable as any widget's are.

export type AskState =
	| { status: "idle" }
	| { status: "asking"; prompt: string }
	| { status: "ready"; prompt: string; proposal: WidgetProposal; preview: string }
	| { status: "error"; prompt: string; error: AiError };

/** The panel, without a board: the gallery draws every state with it. */
export function AskWidgetView({
	state,
	prompt,
	suggestions,
	preview,
	onPrompt,
	onAsk,
	onPlace,
	onBack,
}: {
	state: AskState;
	prompt: string;
	suggestions: string[];
	/** The proposal, drawn live (or a stand-in in the gallery). */
	preview?: ReactNode;
	onPrompt: (prompt: string) => void;
	onAsk: (prompt: string) => void;
	onPlace: () => void;
	/** Back to the widget picker. */
	onBack?: () => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const place = useRef<HTMLButtonElement>(null);
	const ready = state.status === "ready";
	const asked = state.status === "idle" ? null : state.prompt;
	// A proposal's here: Enter places it, unless the request's changed.
	useEffect(() => {
		if (ready) place.current?.focus({ preventScroll: true });
	}, [ready]);
	useEffect(() => {
		if (state.status === "idle" || state.status === "error") {
			input.current?.focus({ preventScroll: true });
		}
	}, [state.status]);

	const definition = ready ? widgetDefinition(state.proposal.widget) : null;
	const lines = ready ? describeConfig(state.proposal.widget, state.proposal.config) : [];
	const title =
		ready && typeof state.proposal.config.title === "string" && state.proposal.config.title
			? state.proposal.config.title
			: definition?.title;

	return (
		<div
			className="toolbar-options ai-ask"
			role="group"
			aria-label="Ask for a widget"
			data-state={state.status}
		>
			<form
				className="ai-ask-form"
				onSubmit={(event) => {
					event.preventDefault();
					const text = prompt.trim();
					if (!text || state.status === "asking") return;
					if (ready && text === asked) onPlace();
					else onAsk(text);
				}}
			>
				<span className="ai-ask-spark" aria-hidden="true">
					<SparkIcon size={18} />
				</span>
				<input
					ref={input}
					className="ai-ask-input"
					type="text"
					value={prompt}
					maxLength={AI_PROMPT_MAX}
					aria-label="Describe a widget"
					placeholder="Describe a widget, like “bugs nobody’s triaged yet”"
					onChange={(event) => onPrompt(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape" && onBack) {
							event.preventDefault();
							event.stopPropagation();
							onBack();
						}
					}}
				/>
				<button
					type="submit"
					className="ai-ask-go"
					disabled={!prompt.trim() || state.status === "asking"}
					aria-label={ready && prompt.trim() === asked ? "Place on board" : "Ask"}
				>
					{ready && prompt.trim() !== asked ? "Ask again" : "Ask"}
					<kbd aria-hidden="true">↵</kbd>
				</button>
			</form>

			{state.status === "idle" && (
				<div className="ai-ask-suggestions" role="group" aria-label="Try asking for">
					{suggestions.map((suggestion) => (
						<button
							key={suggestion}
							type="button"
							className="ai-ask-suggestion"
							onClick={() => {
								onPrompt(suggestion);
								onAsk(suggestion);
							}}
						>
							{suggestion}
						</button>
					))}
					{onBack && (
						<button type="button" className="ai-ask-back" onClick={onBack}>
							Pick one yourself
						</button>
					)}
				</div>
			)}

			{state.status === "asking" && (
				<div className="ai-ask-result" aria-busy="true">
					<div className="ai-ask-words">
						<p className="ai-thinking" role="status">
							<SparkIcon size={14} />
							Choosing a widget…
						</p>
						<span className="action-skeleton" />
						<span className="action-skeleton" />
						<span className="action-skeleton short" />
					</div>
					<div className="ai-preview-frame" data-loading>
						<span className="ai-preview-shimmer" />
					</div>
				</div>
			)}

			{state.status === "error" && (
				<div className="ai-ask-error">
					<Notice tone={state.error.reason === "rate_limited" ? "warn" : "error"}>
						{state.error.message}
					</Notice>
					<div className="ai-ask-actions">
						{onBack && (
							<button type="button" className="action-secondary" onClick={onBack}>
								Pick one yourself
							</button>
						)}
						{state.error.reason !== "off" && state.error.reason !== "forbidden" && (
							<button type="button" className="action-primary" onClick={() => onAsk(state.prompt)}>
								Try again
							</button>
						)}
					</div>
				</div>
			)}

			{ready && (
				<div className="ai-ask-result" data-kind={state.proposal.widget}>
					<div className="ai-ask-words">
						<p className="ai-ask-kind">
							<span className="widget-kind" data-kind={state.proposal.widget} aria-hidden="true">
								{KIND_ICONS[state.proposal.widget]?.() ?? <UnknownIcon size={18} />}
							</span>
							<span>
								<strong>{title}</strong>
								<span className="ai-ask-kind-name">{definition?.title} widget</span>
							</span>
						</p>
						{state.proposal.explanation && (
							<p className="ai-ask-explanation">{state.proposal.explanation}</p>
						)}
						{lines.length > 0 && (
							<dl className="ai-ask-config">
								{lines.map((line) => (
									<div key={line.label}>
										<dt>{line.label}</dt>
										<dd className={line.mono ? "mono" : undefined}>{line.value}</dd>
									</div>
								))}
							</dl>
						)}
						<p className="ai-ask-note">You can change its settings once it’s on the board.</p>
						<div className="ai-ask-actions">
							<button
								type="button"
								className="action-secondary"
								onClick={() => onAsk(state.prompt)}
							>
								Try again
							</button>
							<button ref={place} type="button" className="action-primary" onClick={onPlace}>
								Place on board
							</button>
						</div>
					</div>
					<div className="ai-preview-frame" aria-label="Preview" role="img">
						{preview}
					</div>
				</div>
			)}
		</div>
	);
}

/** Ask for a widget on a board: asking, previewing live, and placing. */
export function AskWidget({
	ai,
	initial,
	repo,
	onPlace,
	onBack,
}: {
	ai: AiService;
	/** What was asked from the picker, to ask straight away. */
	initial?: string;
	/** The board's busiest repository, `owner/name`, for suggestions. */
	repo: string | null;
	onPlace: (kind: string, config: Record<string, unknown>) => void;
	onBack: () => void;
}) {
	const [prompt, setPrompt] = useState(initial ?? "");
	const [state, setState] = useState<AskState>({ status: "idle" });
	const running = useRef<AbortController | null>(null);

	const ask = useCallback(
		(text: string) => {
			running.current?.abort();
			const controller = new AbortController();
			running.current = controller;
			setState({ status: "asking", prompt: text });
			ai.ask({ task: "widget", prompt: text }, controller.signal).then(
				(answer) => {
					if (controller.signal.aborted) return;
					if (answer.kind === "error") setState({ status: "error", prompt: text, error: answer });
					else if (answer.kind === "widget") {
						setState({
							status: "ready",
							prompt: text,
							proposal: answer,
							preview: crypto.randomUUID(),
						});
					}
				},
				() => {},
			);
		},
		[ai],
	);
	useEffect(() => {
		if (initial?.trim()) ask(initial.trim());
		return () => running.current?.abort();
	}, [ask, initial]);

	const proposal = state.status === "ready" ? state : null;
	const preview = useCallback(
		(id: string) => {
			if (proposal) ai.preview(id, proposal.proposal.widget, proposal.proposal.config);
		},
		[ai, proposal],
	);

	return (
		<AskWidgetView
			state={state}
			prompt={prompt}
			suggestions={widgetSuggestions(repo)}
			onPrompt={setPrompt}
			onAsk={ask}
			onBack={onBack}
			onPlace={() => {
				if (proposal) onPlace(proposal.proposal.widget, proposal.proposal.config);
			}}
			preview={
				proposal && (
					<WidgetPreview
						id={proposal.preview}
						widget={proposal.proposal.widget}
						config={proposal.proposal.config}
						onPreview={preview}
					/>
				)
			}
		/>
	);
}
