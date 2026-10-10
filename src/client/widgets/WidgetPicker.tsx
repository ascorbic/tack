import type { DragEvent } from "react";
import { WIDGETS, listPresets } from "../../shared/widgetRegistry.ts";
import { ListIcon, MilestoneIcon, ReviewIcon, StaleIcon, UnknownIcon } from "./icons.tsx";
import { DependencyIcon, ReleaseIcon, TimelineIcon } from "./kindIcons.tsx";

// The widget picker (#37): the widget tool's tray. Every kind in the
// registry, and ready-made lists. Click one to add it in the middle of the
// view, or drag it to where it should go.

export type AddWidget = (
	kind: string,
	config?: Record<string, unknown>,
	at?: { x: number; y: number },
) => void;

/** The MIME type for dragging a widget off the picker onto the canvas. */
export const WIDGET_DRAG_TYPE = "application/x-tack-widget";

const ICONS: Record<string, () => React.ReactNode> = {
	list: () => <ListIcon size={18} />,
	timeline: () => <TimelineIcon size={18} />,
	release: () => <ReleaseIcon size={18} />,
	dependencies: () => <DependencyIcon size={18} />,
	review: () => <ReviewIcon size={18} />,
	milestone: () => <MilestoneIcon size={18} />,
	stale: () => <StaleIcon size={18} />,
};

export function WidgetPicker({
	suggestedRepo,
	login = null,
	onAdd,
}: {
	/** The board's busiest repository (`owner/name`), for ready-made lists. */
	suggestedRepo: string | null;
	/** Who's adding it, signed in: `@me` in ready-made lists is them, the same for everyone. */
	login?: string | null;
	onAdd: (kind: string, config?: Record<string, unknown>) => void;
}) {
	const presets = listPresets(suggestedRepo, login);
	const drag = (kind: string, config?: Record<string, unknown>) => (event: DragEvent) => {
		event.dataTransfer.setData(WIDGET_DRAG_TYPE, JSON.stringify({ kind, config }));
		event.dataTransfer.effectAllowed = "copy";
	};
	return (
		<div className="toolbar-options widget-picker" role="group" aria-label="Widgets">
			{Object.values(WIDGETS).map((definition) => (
				<button
					key={definition.kind}
					type="button"
					className="widget-picker-kind"
					title={definition.description}
					draggable
					onDragStart={drag(definition.kind)}
					onClick={() => onAdd(definition.kind)}
				>
					<span className="widget-kind" data-kind={definition.kind} aria-hidden="true">
						{ICONS[definition.kind]?.() ?? <UnknownIcon size={18} />}
					</span>
					<span className="widget-picker-text">
						<strong>{definition.title}</strong>
						<span>{definition.description}</span>
					</span>
				</button>
			))}
			<span className="toolbar-divider" aria-hidden="true" />
			<div className="widget-picker-presets" role="group" aria-label="Ready-made lists">
				<span className="widget-picker-presets-label">
					Quick lists
					{suggestedRepo && (
						<>
							{" "}
							for <span className="mono">{suggestedRepo}</span>
						</>
					)}
				</span>
				{presets.map((preset) => {
					const config = { q: preset.q, title: preset.title };
					return (
						<button
							key={preset.label}
							type="button"
							className="widget-preset"
							draggable
							title={config.q}
							onDragStart={drag("list", config)}
							onClick={() => onAdd("list", config)}
						>
							{preset.label}
						</button>
					);
				})}
			</div>
		</div>
	);
}
