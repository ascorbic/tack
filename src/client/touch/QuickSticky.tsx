import { useEffect, useRef, useState } from "react";
import { STICKY_COLORS, type StickyColor } from "../board.ts";

const COLOR_NAMES: Record<StickyColor, string> = {
	yellow: "Yellow",
	pink: "Pink",
	blue: "Blue",
	green: "Green",
	purple: "Purple",
};

/**
 * Writing a sticky on a phone (#67): a sheet of paper to type on, its
 * colour, and Add. It stays open for the next one, as ideas come in runs:
 * each added sticky flies off the pad onto the board, and the pad's ready
 * again.
 */
export function QuickSticky({
	color,
	onColor,
	onAdd,
	autoFocus = true,
}: {
	color: StickyColor;
	onColor: (color: StickyColor) => void;
	/** Add a sticky with this text. */
	onAdd: (text: string) => void;
	/** Straight to typing (not in the gallery). */
	autoFocus?: boolean;
}) {
	const [text, setText] = useState("");
	const [added, setAdded] = useState(0);
	const field = useRef<HTMLTextAreaElement>(null);

	// Straight to typing, once the sheet's on its way up.
	useEffect(() => {
		if (!autoFocus) return;
		const frame = requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
		return () => cancelAnimationFrame(frame);
	}, [autoFocus]);

	const add = () => {
		const value = text.trim();
		if (!value) {
			field.current?.focus();
			return;
		}
		onAdd(value);
		setText("");
		setAdded((n) => n + 1);
		field.current?.focus({ preventScroll: true });
	};

	return (
		<form
			className="quick-sticky"
			onSubmit={(event) => {
				event.preventDefault();
				add();
			}}
		>
			<div className="quick-pad">
				{/* The last one added, flying off to the board. */}
				{added > 0 && (
					<span key={added} className="quick-flying" data-color={color} aria-hidden="true" />
				)}
				<textarea
					ref={field}
					className="quick-paper"
					data-color={color}
					aria-label="What’s on the sticky"
					placeholder="Type an idea…"
					value={text}
					maxLength={2000}
					enterKeyHint="send"
					rows={4}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						// Enter adds it; Shift+Enter is a new line.
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							add();
						}
					}}
				/>
			</div>
			<div className="quick-row">
				<div className="quick-colors" role="radiogroup" aria-label="Colour">
					{STICKY_COLORS.map((option) => (
						<button
							key={option}
							type="button"
							role="radio"
							className="quick-color"
							data-color={option}
							aria-checked={option === color}
							aria-label={COLOR_NAMES[option]}
							onClick={() => {
								onColor(option);
								field.current?.focus({ preventScroll: true });
							}}
						/>
					))}
				</div>
				<button type="submit" className="quick-add" disabled={!text.trim()}>
					Add
				</button>
			</div>
			<p className="quick-note" role="status">
				{added === 0
					? "It goes in the middle of what you can see."
					: added === 1
						? "Added. Write another, or close when you’re done."
						: `${added} added. Keep going, or close when you’re done.`}
			</p>
		</form>
	);
}
