import { useReactFlow } from "@xyflow/react";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type EmbedRegion, roundRect } from "../../shared/embed.ts";
import { shapesMap } from "../../shared/shapes.ts";
import { DocContext } from "../DocContext.ts";
import { scaledDuration } from "../motion.ts";
import { useTheme } from "../useTheme.ts";
import { type EmbedBoard, EmbedPanel } from "./EmbedPanel.tsx";
import { RegionPicker } from "./RegionPicker.tsx";
import { type EmbedUi, useEmbedUi } from "./store.ts";
import "./embeds.css";

/**
 * Copy embed on the board: the panel in a modal dialog, and picking a
 * section or area on the canvas. Drawn inside the board (it reads the
 * selection, the view and the document), opened from Share.
 */
export function BoardEmbeds({ store, board }: { store: EmbedUi; board: EmbedBoard }) {
	const state = useEmbedUi(store);
	const flow = useReactFlow();
	const doc = useContext(DocContext);

	// Asked for from Share: start from the section that's selected, if one is on its own.
	const handled = useRef(state.requested);
	useEffect(() => {
		if (state.requested === handled.current) return;
		handled.current = state.requested;
		const selected = flow.getNodes().filter((node) => node.selected);
		const only = selected.length === 1 ? selected[0] : undefined;
		const shape = only && doc ? shapesMap(doc).get(only.id) : undefined;
		if (only && shape?.get("type") === "section") {
			const title = shape.get("title");
			store.open({
				region: { kind: "section", id: only.id },
				sectionTitle: typeof title === "string" && title ? title : null,
			});
		} else {
			store.open();
		}
	}, [state.requested, flow, doc, store]);

	/** What's on screen, as an area of the board. */
	const thisView = (): EmbedRegion | null => {
		const canvas = document.querySelector<HTMLElement>(".canvas");
		if (!canvas) return null;
		const bounds = canvas.getBoundingClientRect();
		const from = flow.screenToFlowPosition({ x: bounds.left, y: bounds.top });
		const to = flow.screenToFlowPosition({ x: bounds.right, y: bounds.bottom });
		return {
			kind: "rect",
			rect: roundRect({ x: from.x, y: from.y, w: to.x - from.x, h: to.y - from.y }),
		};
	};

	return (
		<>
			<EmbedDialog
				open={state.open}
				onClose={() => store.close()}
				board={board}
				region={state.region}
				sectionTitle={state.sectionTitle}
				onRegion={(region) => store.setRegion(region)}
				onPick={() => store.startPicking()}
				thisView={thisView}
			/>
			{state.picking && (
				<RegionPicker
					onPicked={(region, title) => store.picked(region, title)}
					onCancel={() => store.cancelPicking()}
				/>
			)}
		</>
	);
}

type PanelProps = Omit<Parameters<typeof EmbedPanel>[0], "onClose" | "headingId" | "appTheme">;

/** The embed panel in a modal dialog, springing up like Share's. */
export function EmbedDialog({
	open,
	onClose,
	...panel
}: PanelProps & { open: boolean; onClose: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [closing, setClosing] = useState(false);
	const headingId = useId();
	const { theme } = useTheme();

	useEffect(() => {
		const el = dialog.current;
		if (!el) return;
		if (open && !el.open) {
			setClosing(false);
			el.showModal();
			el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
		} else if (!open && el.open) {
			el.close();
		}
	}, [open]);

	const close = () => {
		if (closing) return;
		setClosing(true);
		setTimeout(() => {
			dialog.current?.close();
			setClosing(false);
			onClose();
		}, scaledDuration(140));
	};

	return createPortal(
		<dialog
			ref={dialog}
			className="share-dialog embed-dialog"
			aria-labelledby={headingId}
			data-closing={closing || undefined}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onClick={(event) => {
				if (event.target === dialog.current) close();
			}}
		>
			{open && (
				<EmbedPanel
					{...panel}
					headingId={headingId}
					onClose={close}
					appTheme={theme === "dark" ? "dark" : "light"}
				/>
			)}
		</dialog>,
		document.body,
	);
}
