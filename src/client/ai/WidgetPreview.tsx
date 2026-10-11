import { type NodeProps, ReactFlowProvider } from "@xyflow/react";
import { useEffect } from "react";
import { widgetPreviewId } from "../../shared/ai.ts";
import type { ShapeProps } from "../../shared/shapes.ts";
import { widgetDefinition, widgetSize } from "../../shared/widgetRegistry.ts";
import type { ShapeNode } from "../board.ts";
import { ReadOnlyContext } from "../DocContext.ts";
import { WidgetNode } from "../widgets/WidgetNode.tsx";
import { widgetStore } from "../widgets/store.ts";

// A widget that isn't on the board yet (#64), drawn as it will be once it's
// placed: its own node, fed with its own results (asked for as a preview, as
// whoever's looking), read-only, scaled to fit. It's drawn inside a React
// Flow of its own, so it's never the board's zoomed-out view, and nothing
// that follows nodes on the board (panels, resize grips) finds it.

export function WidgetPreview({
	id,
	widget,
	config,
	width = 320,
	height = 340,
	onPreview,
}: {
	/** This proposal's own id: its results arrive for `widgetPreviewId(id)`. */
	id: string;
	widget: string;
	config: Record<string, unknown>;
	/** The room it has: it's scaled down to fit, never up. */
	width?: number;
	height?: number;
	/** Ask for its results (again). */
	onPreview?: (id: string) => void;
}) {
	const shapeId = widgetPreviewId(id);
	const definition = widgetDefinition(widget);
	const size = widgetSize({ widget, w: definition?.size.w, h: definition?.size.h });
	const scale = Math.min(1, width / size.w, height / size.h);
	const shape: ShapeProps = {
		type: "widget",
		widget,
		config,
		x: 0,
		y: 0,
		z: "a0",
		w: size.w,
		h: size.h,
	};

	useEffect(() => {
		onPreview?.(id);
		widgetStore.onPreviewRefresh = (asked) => {
			if (asked === shapeId) onPreview?.(id);
		};
		return () => {
			widgetStore.onPreviewRefresh = null;
		};
	}, [id, shapeId, onPreview]);

	const props = {
		id: shapeId,
		data: { shape, id: shapeId },
		selected: false,
		type: "widget",
	} as unknown as NodeProps<ShapeNode>;
	return (
		<div
			className="ai-preview-stage"
			style={{ width: Math.round(size.w * scale), height: Math.round(size.h * scale) }}
		>
			<div
				className="ai-preview-widget"
				inert
				style={{ width: size.w, height: size.h, transform: `scale(${scale})` }}
			>
				<ReactFlowProvider>
					<ReadOnlyContext value>
						<WidgetNode {...props} />
					</ReadOnlyContext>
				</ReactFlowProvider>
			</div>
		</div>
	);
}
