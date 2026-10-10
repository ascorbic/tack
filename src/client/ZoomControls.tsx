import { ControlButton, Controls, useStore } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { type CommandId, isApplePlatform, shortcutHint } from "./shortcuts.ts";

// The zoom controls in the canvas's corner: in, the zoom level, out, fit
// and the shortcut sheet. The level says where you are ("what zoom are you
// at?" when following along) and opens a menu of the zoom shortcuts, with a
// switch for the minimap.

const apple = isApplePlatform();

const ITEMS: { id: CommandId; label: string }[] = [
	{ id: "zoomIn", label: "Zoom in" },
	{ id: "zoomOut", label: "Zoom out" },
	{ id: "zoomToFit", label: "Zoom to fit" },
	{ id: "zoomTo100", label: "Zoom to 100%" },
	{ id: "zoomToSelection", label: "Zoom to selection" },
];

export function ZoomControls({
	onCommand,
	onShortcuts,
	hasSelection,
	minimap,
	onMinimap,
	onNavigate,
}: {
	/** Run a canvas command (see commands.ts). */
	onCommand: (id: CommandId) => boolean;
	onShortcuts: () => void;
	hasSelection: boolean;
	/** Whether the minimap is shown; null when there's nothing for it to show. */
	minimap: boolean | null;
	onMinimap: (on: boolean) => void;
	/** The view is about to move, e.g. to stop following someone. */
	onNavigate?: () => void;
}) {
	const zoom = useStore((state) => Math.round(state.transform[2] * 100));
	const [open, setOpen] = useState(false);
	const menu = useRef<HTMLDivElement>(null);
	const run = (id: CommandId) => {
		onNavigate?.();
		onCommand(id);
	};

	useEffect(() => {
		if (!open) return;
		const close = (event: Event) => {
			if (event instanceof KeyboardEvent && event.key !== "Escape") return;
			if (event.target instanceof Node && menu.current?.parentElement?.contains(event.target)) {
				if (!(event instanceof KeyboardEvent)) return;
			}
			setOpen(false);
		};
		window.addEventListener("pointerdown", close, true);
		window.addEventListener("keydown", close, true);
		menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
		return () => {
			window.removeEventListener("pointerdown", close, true);
			window.removeEventListener("keydown", close, true);
		};
	}, [open]);

	return (
		<Controls
			showZoom={false}
			showFitView={false}
			showInteractive={false}
			aria-label="Zoom"
			className="zoom-controls"
		>
			<ControlButton
				onClick={() => run("zoomIn")}
				title={`Zoom in (${shortcutHint("zoomIn", apple)})`}
				aria-label="Zoom in"
			>
				<svg viewBox="0 0 32 32" aria-hidden="true">
					<path d="M32 18.133H18.133V32h-4.266V18.133H0v-4.266h13.867V0h4.266v13.867H32z" />
				</svg>
			</ControlButton>
			<ControlButton
				className="zoom-level"
				onClick={() => setOpen((current) => !current)}
				title="Zoom options"
				aria-label={`Zoom: ${zoom}%`}
				aria-haspopup="menu"
				aria-expanded={open}
			>
				{zoom}%
			</ControlButton>
			<ControlButton
				onClick={() => run("zoomOut")}
				title={`Zoom out (${shortcutHint("zoomOut", apple)})`}
				aria-label="Zoom out"
			>
				<svg viewBox="0 0 32 5" aria-hidden="true">
					<path d="M0 0h32v4.2H0z" />
				</svg>
			</ControlButton>
			<ControlButton
				className="react-flow__controls-fitview"
				onClick={() => run("zoomToFit")}
				title={`Zoom to fit (${shortcutHint("zoomToFit", apple)})`}
				aria-label="Zoom to fit"
			>
				<svg viewBox="0 0 32 30" aria-hidden="true">
					<path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" />
				</svg>
			</ControlButton>
			<ControlButton
				onClick={onShortcuts}
				title="Keyboard shortcuts (?)"
				aria-label="Keyboard shortcuts"
				className="shortcuts-button"
			>
				?
			</ControlButton>
			{open && (
				<div ref={menu} className="zoom-menu" role="menu" aria-label="Zoom">
					{ITEMS.map((item) => {
						const disabled = item.id === "zoomToSelection" && !hasSelection;
						return (
							<button
								key={item.id}
								type="button"
								role="menuitem"
								disabled={disabled}
								onClick={() => {
									setOpen(false);
									run(item.id);
								}}
							>
								<span>{item.label}</span>
								<kbd>{shortcutHint(item.id, apple)}</kbd>
							</button>
						);
					})}
					{minimap !== null && (
						<>
							<span className="zoom-menu-divider" role="separator" />
							<button
								type="button"
								role="menuitemcheckbox"
								aria-checked={minimap}
								onClick={() => {
									setOpen(false);
									onMinimap(!minimap);
								}}
							>
								<span>Minimap</span>
								<span className="zoom-menu-check" aria-hidden="true">
									{minimap ? "✓" : ""}
								</span>
							</button>
						</>
					)}
				</div>
			)}
		</Controls>
	);
}
