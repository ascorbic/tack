import type { ReactNode } from "react";
import { CUSTOM_EXAMPLES } from "../../../shared/customWidgetExamples.ts";
import { WidgetEmpty, WidgetShell } from "../chrome.tsx";
import { CodeIcon, LockIcon, PlayIcon, WarnIcon } from "../icons.tsx";
import "./custom.css";

// A custom widget (#66) as it's drawn, board-free so the gallery shows every
// state: off on this board, nothing written yet, settings that aren't JSON,
// running (its sandbox is `children`), and stopped.

export type CustomState =
	/** The owner hasn't turned custom widgets on: nothing runs. */
	| { kind: "off" }
	/** No code yet. */
	| { kind: "empty" }
	/** Its settings can't be read, so it isn't run. */
	| { kind: "invalid"; message: string }
	| { kind: "running" }
	/** It never loaded, or stopped answering. */
	| { kind: "stopped"; message: string };

const SHELL_STATUS = {
	off: "unconfigured",
	empty: "unconfigured",
	invalid: "error",
	running: "ready",
	stopped: "error",
} as const;

export function CustomView({
	title,
	state,
	selected = false,
	enter = false,
	readOnly = false,
	interactive = false,
	errors = 0,
	refreshing = false,
	children,
	onEnable,
	onEdit,
	onRunAgain,
	onRefresh,
	onExample,
}: {
	title: string;
	state: CustomState;
	selected?: boolean;
	enter?: boolean;
	readOnly?: boolean;
	/** Whether the sandbox takes the pointer: once selected, on the board. */
	interactive?: boolean;
	/** Uncaught errors from its code since it started. */
	errors?: number;
	refreshing?: boolean;
	/** The sandbox, while it runs. */
	children?: ReactNode;
	/** For the board's owner, while custom widgets are off. */
	onEnable?: () => void;
	/** Open the code: to edit it, or read it. */
	onEdit?: () => void;
	onRunAgain?: () => void;
	onRefresh?: () => void;
	/** Start from an example (editors, while it's empty). */
	onExample?: (id: string) => void;
}) {
	const editLabel = readOnly ? "View code" : "Edit code";
	return (
		<WidgetShell
			kind="custom"
			icon={<CodeIcon />}
			title={title || "Custom widget"}
			subtitle={<span className="custom-subtitle">Custom · runs in a sandbox</span>}
			status={SHELL_STATUS[state.kind]}
			selected={selected}
			enter={enter}
			refreshing={refreshing}
			onRefresh={state.kind === "running" ? onRefresh : undefined}
			tools={
				onEdit && (
					<button
						type="button"
						className="widget-tool"
						aria-label={editLabel}
						data-tooltip={editLabel}
						data-config-toggle
						onClick={onEdit}
					>
						<CodeIcon />
					</button>
				)
			}
			configureLabel={editLabel}
			bodyClass={state.kind === "running" ? "custom-body" : undefined}
			far={{ value: "</>", label: title || "Custom widget" }}
			footer={
				state.kind === "running" ? (
					<footer className="widget-foot custom-foot">
						<span className="custom-sandboxed" title="Its code can’t reach the network or the app">
							<LockIcon size={12} />
							Sandboxed
						</span>
						{errors > 0 && (
							<button
								type="button"
								className="custom-errors nodrag nopan"
								onClick={onEdit}
								disabled={!onEdit}
							>
								<span className="custom-errors-dot" aria-hidden="true" />
								{errors === 1 ? "1 error" : `${errors} errors`}
							</button>
						)}
					</footer>
				) : undefined
			}
		>
			{state.kind === "running" ? (
				<div className="custom-stage" data-interactive={interactive || undefined}>
					{children}
					{!interactive && (
						<div className="custom-shield" aria-hidden="true">
							<span className="custom-shield-hint">Select to use</span>
						</div>
					)}
				</div>
			) : (
				<CustomEmpty
					state={state}
					readOnly={readOnly}
					onEnable={onEnable}
					onEdit={onEdit}
					onRunAgain={onRunAgain}
					onExample={onExample}
				/>
			)}
		</WidgetShell>
	);
}

function CustomEmpty({
	state,
	readOnly,
	onEnable,
	onEdit,
	onRunAgain,
	onExample,
}: {
	state: Exclude<CustomState, { kind: "running" }>;
	readOnly: boolean;
	onEnable?: () => void;
	onEdit?: () => void;
	onRunAgain?: () => void;
	onExample?: (id: string) => void;
}) {
	switch (state.kind) {
		case "off":
			return (
				<WidgetEmpty
					icon={<LockIcon size={20} />}
					title="Custom widgets are off here"
					detail={
						onEnable
							? "Its code only runs once you allow custom widgets on this board."
							: "Its code only runs once the board’s owner allows custom widgets."
					}
				>
					{onEnable && (
						<button type="button" className="widget-action nodrag nopan" onClick={onEnable}>
							Custom widgets…
						</button>
					)}
				</WidgetEmpty>
			);
		case "empty":
			return readOnly || !onExample ? (
				<WidgetEmpty icon={<CodeIcon size={20} />} title="Nothing here yet" />
			) : (
				<WidgetEmpty
					icon={<CodeIcon size={20} />}
					title="Draw anything from the board’s data"
					detail="A little JavaScript, run in a sandbox. Start from an example:"
				>
					<div className="custom-examples-inline nodrag nopan">
						{CUSTOM_EXAMPLES.map((example) => (
							<button
								key={example.id}
								type="button"
								className="widget-preset"
								title={example.description}
								onClick={() => onExample(example.id)}
							>
								{example.title}
							</button>
						))}
						<button type="button" className="widget-preset" onClick={onEdit}>
							Blank
						</button>
					</div>
				</WidgetEmpty>
			);
		case "invalid":
			return (
				<WidgetEmpty
					icon={<WarnIcon size={20} />}
					title="Its settings aren’t valid"
					detail={state.message}
					tone="warn"
				>
					{!readOnly && onEdit && (
						<button type="button" className="widget-action nodrag nopan" onClick={onEdit}>
							Fix settings
						</button>
					)}
				</WidgetEmpty>
			);
		case "stopped":
			return (
				<WidgetEmpty
					icon={<WarnIcon size={20} />}
					title="This widget stopped"
					detail={state.message}
					tone="warn"
				>
					{onRunAgain && (
						<button type="button" className="widget-action nodrag nopan" onClick={onRunAgain}>
							<PlayIcon />
							Run again
						</button>
					)}
				</WidgetEmpty>
			);
	}
}
