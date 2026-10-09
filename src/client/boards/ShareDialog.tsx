import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { scaledDuration } from "../motion.ts";
import { SharePanel } from "./SharePanel.tsx";

type Props = Omit<Parameters<typeof SharePanel>[0], "onClose" | "headingId">;

/**
 * The share panel in a modal dialog: it springs up from the Share button,
 * and Escape or a click outside closes it.
 */
export function ShareDialog({
	open,
	onClose,
	...panel
}: Props & { open: boolean; onClose: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [closing, setClosing] = useState(false);
	const headingId = useId();

	useEffect(() => {
		const el = dialog.current;
		if (!el) return;
		if (open && !el.open) {
			setClosing(false);
			el.showModal();
		} else if (!open && el.open) {
			el.close();
		}
	}, [open]);

	// Play the exit animation, then close for real.
	const close = () => {
		if (closing) return;
		setClosing(true);
		setTimeout(() => {
			dialog.current?.close();
			setClosing(false);
			onClose();
		}, scaledDuration(140));
	};

	// In the body, so the top bar's styles and stacking don't reach it.
	return createPortal(
		<dialog
			ref={dialog}
			className="share-dialog"
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
			{open && <SharePanel {...panel} headingId={headingId} onClose={close} />}
		</dialog>,
		document.body,
	);
}
