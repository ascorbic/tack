import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { scaledDuration } from "../motion.ts";

/**
 * A modal dialog that springs up, and closes on Escape or a click outside,
 * after a short exit (as the share dialog does). `children` gets the close
 * function, so what's inside can close it the same way.
 */
export function Modal({
	open,
	onClose,
	className,
	labelledBy,
	children,
}: {
	open: boolean;
	onClose: () => void;
	className: string;
	labelledBy: string;
	children: (close: () => void) => ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [closing, setClosing] = useState(false);

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
			className={className}
			aria-labelledby={labelledBy}
			data-closing={closing || undefined}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
			onClick={(event) => {
				if (event.target === dialog.current) close();
			}}
		>
			{open && children(close)}
		</dialog>,
		document.body,
	);
}
