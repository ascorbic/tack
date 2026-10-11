import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { CUSTOM_EXAMPLES, exampleConfig } from "../../../shared/customWidgetExamples.ts";
import { CUSTOM_LIMITS, type CustomConfig, parseSettings } from "../../../shared/customWidgets.ts";
import { ConfigSheet } from "../ConfigPanel.tsx";
import { CheckIcon, CodeIcon, LockIcon, PlayIcon, WarnIcon } from "../icons.tsx";
import type { CustomDataSource } from "./data.ts";
import { SandboxFrame } from "./Frame.tsx";
import type { LogEntry, SandboxStatus } from "./sandbox.ts";

// Writing a custom widget (#66): its code and settings, a live preview that
// runs the draft in its own sandbox as you type, what the draft logged and
// threw, and a gallery of examples to start from. Nothing reaches the board
// until Apply (⌘↵), which is one undoable change. People who can only view
// the board can read the code, and run nothing new.

type Tab = "code" | "settings" | "examples";

/** The preview waits this long after the last keystroke before running the draft. */
const PREVIEW_DELAY_MS = 600;
/** Lines kept in the console. */
const CONSOLE_LINES = 60;

export function CustomEditor({
	id,
	config,
	readOnly,
	enabled,
	data,
	suggestedRepo,
	onApply,
	onEnable,
	onClose,
	initialTab = "code",
	initialLogs,
}: {
	id: string;
	config: CustomConfig;
	readOnly: boolean;
	/** Whether custom widgets run on this board, so the preview can. */
	enabled: boolean;
	data: CustomDataSource;
	/** The board's busiest repository (`owner/name`), for examples' settings. */
	suggestedRepo: string | null;
	onApply: (config: CustomConfig) => void;
	/** For the board's owner, while custom widgets are off. */
	onEnable?: () => void;
	onClose: () => void;
	initialTab?: Tab;
	/** For the gallery. */
	initialLogs?: LogEntry[];
}) {
	const [tab, setTab] = useState<Tab>(initialTab);
	const [draft, setDraft] = useState(config);
	const [base, setBase] = useState(config);
	const [applied, setApplied] = useState(0);
	// Someone else changed it while this was open, and there's nothing here to lose: follow along.
	if (config !== base && sameConfig(draft, base)) {
		setBase(config);
		setDraft(config);
	}
	const settings = useMemo(() => parseSettings(draft.data), [draft.data]);
	const tooLong = draft.code.length > CUSTOM_LIMITS.code || draft.data.length > CUSTOM_LIMITS.data;
	const changed = !sameConfig(draft, config);
	const canApply = !readOnly && changed && settings.ok && !tooLong;
	const apply = () => {
		if (!canApply) return;
		onApply(draft);
		setBase(draft);
		setApplied((n) => n + 1);
	};

	// The preview runs the draft a moment after typing stops.
	const [preview, setPreview] = useState({ run: 0, config: draft });
	useEffect(() => {
		if (sameConfig(preview.config, draft)) return;
		const timer = setTimeout(
			() => setPreview((current) => ({ run: current.run + 1, config: draft })),
			PREVIEW_DELAY_MS,
		);
		return () => clearTimeout(timer);
	}, [draft, preview.config]);
	const [logs, setLogs] = useState<LogEntry[]>(initialLogs ?? []);
	const [status, setStatus] = useState<SandboxStatus>({ kind: "starting" });
	useEffect(() => {
		if (initialLogs) return;
		setLogs([]);
		setStatus({ kind: "starting" });
	}, [preview.run, initialLogs]);
	const previewSettings = parseSettings(preview.config.data);

	const titleId = useId();
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			apply();
		}
	};

	return (
		<ConfigSheet label={readOnly ? "This widget’s code" : "Edit custom widget"} onClose={onClose}>
			<div className="custom-editor" onKeyDown={onKeyDown}>
				<header className="widget-config-head custom-editor-head">
					<span className="custom-editor-icon" aria-hidden="true">
						<CodeIcon />
					</span>
					<div>
						<h3>{readOnly ? "This widget’s code" : "Custom widget"}</h3>
						<p>
							{readOnly
								? "You can read it. People who can edit the board can change it."
								: "JavaScript, run in a sandbox with no network. It reads the board’s data as whoever’s looking."}
						</p>
					</div>
				</header>

				{!readOnly && (
					<label className="widget-field" htmlFor={titleId}>
						<span className="widget-field-label">Title</span>
						<input
							id={titleId}
							value={draft.title}
							maxLength={CUSTOM_LIMITS.title}
							placeholder="Custom widget"
							onChange={(event) => setDraft({ ...draft, title: event.target.value })}
						/>
					</label>
				)}

				<div className="custom-tabs" role="tablist" aria-label="Widget">
					{(["code", "settings", ...(readOnly ? [] : ["examples"])] as Tab[]).map((name) => (
						<button
							key={name}
							type="button"
							role="tab"
							id={`${id}-tab-${name}`}
							aria-selected={tab === name}
							aria-controls={`${id}-panel-${name}`}
							className="custom-tab"
							onClick={() => setTab(name)}
						>
							{TAB_LABELS[name]}
							{name === "settings" && !settings.ok && (
								<span className="custom-tab-warn" aria-label="(not valid)">
									<WarnIcon size={12} />
								</span>
							)}
						</button>
					))}
				</div>

				<div
					role="tabpanel"
					id={`${id}-panel-${tab}`}
					aria-labelledby={`${id}-tab-${tab}`}
					className="custom-tabpanel"
				>
					{tab === "code" && (
						<>
							<CodeArea
								label="Code"
								value={draft.code}
								readOnly={readOnly}
								placeholder={PLACEHOLDER}
								onChange={(code) => setDraft({ ...draft, code })}
							/>
							<Meter
								used={draft.code.length}
								limit={CUSTOM_LIMITS.code}
								hint={readOnly ? null : HINT}
							/>
						</>
					)}
					{tab === "settings" && (
						<>
							<CodeArea
								label="Settings (JSON)"
								value={draft.data}
								readOnly={readOnly}
								rows={8}
								placeholder={'{ "repo": "owner/name" }'}
								onChange={(data) => setDraft({ ...draft, data })}
							/>
							<p className="custom-settings-note" data-ok={settings.ok || undefined} role="status">
								{settings.ok ? (
									<>
										<CheckIcon size={12} /> Its code reads these as <code>tack.config</code>.
									</>
								) : (
									<>
										<WarnIcon size={12} /> {settings.error}
									</>
								)}
							</p>
						</>
					)}
					{tab === "examples" && (
						<ul className="custom-gallery">
							{CUSTOM_EXAMPLES.map((example, i) => (
								<li key={example.id} style={{ "--i": i } as React.CSSProperties}>
									<button
										type="button"
										className="custom-gallery-item"
										onClick={() => {
											setDraft(exampleConfig(example, suggestedRepo));
											setTab("code");
										}}
									>
										<span
											className="custom-gallery-art"
											data-example={example.id}
											aria-hidden="true"
										>
											<ExampleArt id={example.id} />
										</span>
										<strong>{example.title}</strong>
										<span>{example.description}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>

				<section className="custom-preview" aria-label="Preview">
					<header>
						<span className="custom-preview-label">
							<span className="custom-preview-dot" data-status={enabled ? status.kind : "off"} />
							Preview
						</span>
						{enabled && (
							<button
								type="button"
								className="custom-preview-run"
								onClick={() => setPreview((current) => ({ run: current.run + 1, config: draft }))}
							>
								<PlayIcon />
								Run
							</button>
						)}
					</header>
					<div className="custom-preview-stage">
						{!enabled ? (
							<p className="custom-preview-note">
								<LockIcon size={14} />
								<span>
									Custom widgets are off on this board, so nothing runs yet.
									{onEnable && (
										<>
											{" "}
											<button type="button" className="custom-link" onClick={onEnable}>
												Turn them on…
											</button>
										</>
									)}
								</span>
							</p>
						) : !previewSettings.ok ? (
							<p className="custom-preview-note">
								<WarnIcon size={14} />
								<span>{previewSettings.error}</span>
							</p>
						) : !preview.config.code.trim() ? (
							<p className="custom-preview-note">
								<CodeIcon size={14} />
								<span>Write some code, or start from an example, to see it here.</span>
							</p>
						) : status.kind === "stopped" ? (
							<p className="custom-preview-note" data-tone="warn">
								<WarnIcon size={14} />
								<span>{status.message}</span>
							</p>
						) : (
							<SandboxFrame
								key={preview.run}
								widget={{ id, title: preview.config.title }}
								code={preview.config.code}
								config={previewSettings.value}
								data={data}
								onStatus={setStatus}
								onLog={(entry) => setLogs((current) => [...current, entry].slice(-CONSOLE_LINES))}
							/>
						)}
					</div>
					<Console logs={logs} onClear={() => setLogs([])} />
				</section>

				{!readOnly && (
					<footer className="widget-config-foot custom-editor-foot">
						<span className="custom-applied" key={applied} data-shown={applied > 0 || undefined}>
							{applied > 0 && !changed && (
								<>
									<CheckIcon size={12} /> Applied
								</>
							)}
						</span>
						<button type="button" disabled={!changed} onClick={() => setDraft(config)}>
							Revert
						</button>
						<button type="button" className="custom-apply" disabled={!canApply} onClick={apply}>
							Apply
							<kbd aria-hidden="true">{isApple() ? "⌘↵" : "Ctrl+↵"}</kbd>
						</button>
					</footer>
				)}
			</div>
		</ConfigSheet>
	);
}

const TAB_LABELS: Record<Tab, string> = {
	code: "Code",
	settings: "Settings",
	examples: "Examples",
};

const HINT = "tack.search(), tack.cards(), tack.avatar(), tack.config, tack.onUpdate()";

const PLACEHOLDER = `// Draw anything with the board's data. For example:
const { items } = await tack.search("repo:owner/name is:open");
document.body.textContent = \`\${items.length} open\`;`;

function sameConfig(a: CustomConfig, b: CustomConfig): boolean {
	return a.title === b.title && a.code === b.code && a.data === b.data;
}

function isApple(): boolean {
	return /Mac|iPhone|iPad/.test(navigator.platform);
}

/**
 * A plain textarea for code, with line numbers, that keeps indentation on
 * Enter and indents or outdents lines with ⌘] and ⌘[. Tab moves focus on,
 * as everywhere else.
 */
function CodeArea({
	label,
	value,
	readOnly,
	rows = 14,
	placeholder,
	onChange,
}: {
	label: string;
	value: string;
	readOnly: boolean;
	rows?: number;
	placeholder?: string;
	onChange: (value: string) => void;
}) {
	const gutter = useRef<HTMLDivElement>(null);
	const lines = Math.max(1, value.split("\n").length);
	const edit = (area: HTMLTextAreaElement, text: string, start: number, end: number) => {
		area.setRangeText(text, start, end, "end");
		onChange(area.value);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (readOnly) return;
		const area = event.currentTarget;
		const { selectionStart: start, selectionEnd: end, value: text } = area;
		if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
			const lineStart = text.lastIndexOf("\n", start - 1) + 1;
			const indent = /^[\t ]*/.exec(text.slice(lineStart, start))?.[0] ?? "";
			const opens = /[{[(]\s*$/.test(text.slice(lineStart, start));
			event.preventDefault();
			edit(area, `\n${indent}${opens ? "  " : ""}`, start, end);
			return;
		}
		if ((event.key === "]" || event.key === "[") && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			const from = text.lastIndexOf("\n", start - 1) + 1;
			const block = text.slice(from, end);
			const next =
				event.key === "]" ? block.replace(/^/gm, "  ") : block.replace(/^( {1,2}|\t)/gm, "");
			area.setRangeText(next, from, end, "select");
			onChange(area.value);
		}
	};
	return (
		<div className="custom-code" data-readonly={readOnly || undefined}>
			<div className="custom-gutter" ref={gutter} aria-hidden="true">
				{Array.from({ length: lines }, (_, i) => (
					<span key={i}>{i + 1}</span>
				))}
			</div>
			<textarea
				aria-label={label}
				className="custom-code-input"
				value={value}
				readOnly={readOnly}
				rows={rows}
				placeholder={placeholder}
				spellCheck={false}
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				wrap="off"
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={onKeyDown}
				onScroll={(event) => {
					if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
				}}
			/>
		</div>
	);
}

/** How much of the limit it uses, and what the API offers. */
function Meter({ used, limit, hint }: { used: number; limit: number; hint: string | null }) {
	const share = used / limit;
	return (
		<p className="custom-meter" data-over={share > 1 || undefined}>
			{hint && <code className="custom-meter-hint">{hint}</code>}
			<span className="custom-meter-count">
				{(used / 1000).toFixed(1)} of {limit / 1000} KB
			</span>
		</p>
	);
}

/** What the preview logged and threw, newest last. */
function Console({ logs, onClear }: { logs: LogEntry[]; onClear: () => void }) {
	const list = useRef<HTMLOListElement>(null);
	useEffect(() => {
		const el = list.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [logs]);
	if (logs.length === 0) return null;
	return (
		<div className="custom-console">
			<ol ref={list} aria-label="Console" aria-live="polite">
				{logs.map((entry, i) => (
					<li key={`${entry.at}-${i}`} data-level={entry.level}>
						{entry.level === "uncaught" ? "Error: " : ""}
						{entry.text}
					</li>
				))}
			</ol>
			<button type="button" className="custom-link" onClick={onClear}>
				Clear
			</button>
		</div>
	);
}

/** Each example's thumbnail, drawn in the board's tokens. */
function ExampleArt({ id }: { id: string }) {
	switch (id) {
		case "burndown":
			return (
				<svg viewBox="0 0 64 36" width="64" height="36">
					<path d="M2 6 14 9 24 8 34 17 44 20 54 28 62 30V34H2Z" className="fill-soft" />
					<path d="M2 6 14 9 24 8 34 17 44 20 54 28 62 30" className="stroke" />
					<path d="M2 6 62 34" className="dash" />
				</svg>
			);
		case "labels":
			return (
				<svg viewBox="0 0 64 36" width="64" height="36">
					<rect x="3" y="6" width="22" height="9" rx="4.5" className="chip-a" />
					<rect x="28" y="4" width="32" height="12" rx="6" className="chip-b" />
					<rect x="8" y="19" width="30" height="12" rx="6" className="chip-c" />
					<rect x="41" y="21" width="16" height="8" rx="4" className="chip-a" />
				</svg>
			);
		default:
			return (
				<svg viewBox="0 0 64 36" width="64" height="36">
					{[6, 17, 28].map((y, i) => (
						<g key={y}>
							<circle cx="7" cy={y} r="4" className="face" />
							<rect
								x="15"
								y={y - 2.5}
								width={[44, 30, 18][i]}
								height="5"
								rx="2.5"
								className="bar"
							/>
						</g>
					))}
				</svg>
			);
	}
}
