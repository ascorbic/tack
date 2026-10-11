import { useId, useState } from "react";
import type { BoardInfo } from "../../shared/boards.ts";
import { type ApiError, boardsApi } from "./api.ts";
import { Modal } from "./Modal.tsx";
import "./customWidgets.css";

// The board owner's switch for custom widgets (#66): off by default, and
// said plainly what turning it on means before it's on.

export function CustomWidgetsDialog({
	board,
	open,
	onClose,
	onChanged,
}: {
	board: Pick<BoardInfo, "id" | "title" | "customWidgets">;
	open: boolean;
	onClose: () => void;
	onChanged: (board: BoardInfo) => void;
}) {
	const headingId = useId();
	return (
		<Modal open={open} onClose={onClose} className="custom-widgets-dialog" labelledBy={headingId}>
			{(close) => (
				<CustomWidgetsPanel
					headingId={headingId}
					enabled={board.customWidgets === true}
					onChange={async (enabled) => {
						const result = await boardsApi.update(board.id, { customWidgets: enabled });
						if (result.ok) onChanged(result.value);
						return result.ok ? null : result.error;
					}}
					onClose={close}
				/>
			)}
		</Modal>
	);
}

/** The dialog's insides, board-free for the gallery. */
export function CustomWidgetsPanel({
	headingId,
	enabled,
	onChange,
	onClose,
}: {
	headingId?: string;
	enabled: boolean;
	/** Resolves with an error, or null once it's changed. */
	onChange: (enabled: boolean) => Promise<ApiError | null>;
	onClose: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [shown, setShown] = useState(enabled);
	const switchId = useId();
	const toggle = async (next: boolean) => {
		setShown(next);
		setBusy(true);
		setError(null);
		const failed = await onChange(next);
		setBusy(false);
		if (failed) {
			setShown(!next);
			setError(
				failed === "owner_required"
					? "Only the board’s owner can change this."
					: "That didn’t work. Try again in a moment.",
			);
		}
	};
	return (
		<div className="custom-widgets" data-enabled={shown || undefined}>
			<span className="custom-widgets-art" aria-hidden="true">
				<svg viewBox="0 0 40 40" width="40" height="40">
					<rect x="4" y="7" width="32" height="26" rx="7" className="frame" />
					<path
						d="M15 15.5 10.5 20l4.5 4.5M25 15.5l4.5 4.5-4.5 4.5M21.5 13l-3 14"
						className="code"
					/>
				</svg>
			</span>
			<h2 id={headingId}>Custom widgets</h2>
			<p className="custom-widgets-lede">
				Custom widgets are bits of JavaScript that anyone who can edit this board writes, drawing
				the board’s data however they like: a burndown, a label cloud, a list of contributors.
			</p>
			<ul className="custom-widgets-points">
				<li>
					<strong>Sandboxed.</strong> Their code can’t reach the network, Tack, your session or
					anything else on the page.
				</li>
				<li>
					<strong>Read only.</strong> They can search GitHub and read cards, but never change
					anything.
				</li>
				<li>
					<strong>As whoever’s looking.</strong> A widget reads with the permissions of each person
					viewing it, private repositories they can read included.
				</li>
			</ul>
			<p className="custom-widgets-warning" role="note">
				<strong>Only turn this on if you trust everyone who can edit this board.</strong> Someone
				could write a widget that reads what other people can see and tries to send it somewhere.
				The sandbox blocks every way browsers let it, but no sandbox is perfect.
			</p>
			<label className="custom-widgets-switch" htmlFor={switchId}>
				<span>
					<strong>Run custom widgets on this board</strong>
					<span>{shown ? "On: their code runs for everyone here." : "Off: nothing runs."}</span>
				</span>
				<input
					id={switchId}
					type="checkbox"
					role="switch"
					checked={shown}
					disabled={busy}
					onChange={(event) => void toggle(event.target.checked)}
				/>
				<span className="custom-widgets-track" aria-hidden="true">
					<span className="custom-widgets-knob" />
				</span>
			</label>
			{error && (
				<p className="custom-widgets-error" role="alert">
					{error}
				</p>
			)}
			<div className="custom-widgets-actions">
				<button type="button" className="custom-widgets-done" onClick={onClose}>
					Done
				</button>
			</div>
		</div>
	);
}
