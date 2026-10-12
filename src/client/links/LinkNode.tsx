import { type NodeProps, useStore } from "@xyflow/react";
import { memo, useContext, useMemo, useState } from "react";
import { readPreview } from "../../shared/linkPreview.ts";
import { ServicesContext } from "../actions/services.ts";
import { type ShapeNode, isFresh } from "../board.ts";
import { entranceOf } from "../entering.ts";
import { LinkView } from "./LinkView.tsx";
import { useUnfurling } from "./unfurling.ts";

/** Below this zoom, link cards switch to their simplified rendering, as cards do. */
const COMPACT_ZOOM = 0.45;

export const LinkNode = memo(function LinkNode({ data, selected }: NodeProps<ShapeNode>) {
	const url = typeof data.shape.url === "string" ? data.shape.url : "";
	const preview = useMemo(() => readPreview(data.shape.preview), [data.shape.preview]);
	const loading = useUnfurling(data.id);
	const compact = useStore((state) => state.transform[2] < COMPACT_ZOOM);
	const [enter] = useState(() => isFresh(data.id));
	const [entrance] = useState(() => entranceOf(data.id));
	const links = useContext(ServicesContext)?.links;
	return (
		<LinkView
			url={url}
			preview={preview}
			loading={loading}
			selected={selected}
			compact={compact}
			enter={enter}
			entrance={entrance}
			imageSrc={links?.imageSrc}
		/>
	);
});
