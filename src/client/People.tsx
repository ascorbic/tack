import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type Status, statusLabel } from "./activity.ts";
import type { RemotePresence, User } from "./presence.ts";

/** Avatars shown before the rest collapse into "+N" (the top bar has room for 8 at 1280). */
export const MAX_SHOWN = 8;

export function initials(name: string): string {
	return name
		.split(/\s+/)
		.map((word) => word[0] ?? "")
		.join("")
		.slice(0, 2)
		.toUpperCase();
}

/**
 * Who's here, in the top bar. Click someone to follow their view; click
 * again to stop. Idle and away people fade back. Past eight, the rest
 * fold into "+N", which opens everyone in a list, to follow or jump to.
 * When people follow you, a chip says so.
 */
export function People({
	user,
	selfId,
	people,
	following,
	onFollow,
	onJump,
	self,
}: {
	user: User;
	/** Our awareness client id, to spot people following us. */
	selfId: number;
	people: RemotePresence[];
	following: number | null;
	onFollow: (clientId: number | null) => void;
	/** Go to where someone's looking, once. */
	onJump?: (clientId: number) => void;
	/** Your own avatar, e.g. an account menu, given its label. Defaults to a plain avatar. */
	self?: (label: string) => ReactNode;
}) {
	const shown = people.length > MAX_SHOWN ? people.slice(0, MAX_SHOWN - 1) : people;
	const rest = people.slice(shown.length);
	const followers = people.filter((p) => p.following === selfId);
	const selfLabel =
		followers.length > 0
			? `${user.name} (you) · ${followers.length === 1 ? "1 person" : `${followers.length} people`} following you`
			: `${user.name} (you)`;
	return (
		<div className="people" role="group" aria-label="People here">
			{followers.length > 0 && (
				<span
					className="people-followers"
					role="status"
					title={followers.map((p) => p.user.name).join(", ")}
				>
					<EyeIcon />
					{followers.length === 1
						? `${firstName(followers[0]!.user.name)} is following you`
						: `${followers.length} following you`}
				</span>
			)}
			{self ? self(selfLabel) : <Avatar user={user} label={selfLabel} />}
			{shown.map((person) => {
				const isFollowed = following === person.clientId;
				const status = statusLabel(person.status);
				const details = [status, person.following === selfId ? "following you" : null]
					.filter(Boolean)
					.join(" · ");
				return (
					<Avatar
						key={person.clientId}
						user={person.user}
						status={person.status}
						followsYou={person.following === selfId}
						pressed={isFollowed}
						label={`${person.user.name}${details ? ` · ${details}` : ""}`}
						hint={isFollowed ? "Stop following" : "Follow"}
						onClick={() => onFollow(isFollowed ? null : person.clientId)}
					/>
				);
			})}
			{rest.length > 0 && (
				<Everyone
					people={people}
					more={rest.length}
					selfId={selfId}
					following={following}
					onFollow={onFollow}
					onJump={onJump}
				/>
			)}
		</div>
	);
}

function firstName(name: string): string {
	return name.split(/\s+/)[0] || name;
}

function EyeIcon() {
	return (
		<svg className="people-eye" width="14" height="14" viewBox="0 0 10 10" aria-hidden="true">
			<path d="M1 5s1.5-2.75 4-2.75S9 5 9 5 7.5 7.75 5 7.75 1 5 1 5z" />
			<circle cx="5" cy="5" r="1.2" />
		</svg>
	);
}

/** "+N": everyone here in a list, to follow or go to. */
function Everyone({
	people,
	more,
	selfId,
	following,
	onFollow,
	onJump,
}: {
	people: RemotePresence[];
	more: number;
	selfId: number;
	following: number | null;
	onFollow: (clientId: number | null) => void;
	onJump?: (clientId: number) => void;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const id = useId();
	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			setOpen(false);
			button.current?.focus();
		};
		window.addEventListener("pointerdown", onDown);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("pointerdown", onDown);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [open]);
	return (
		<div className="people-more" ref={root}>
			<button
				ref={button}
				type="button"
				className="avatar avatar-more"
				aria-expanded={open}
				aria-controls={id}
				aria-label={`Everyone here: ${people.length + 1} people`}
				onClick={() => setOpen((o) => !o)}
			>
				+{more}
			</button>
			{open && (
				<div className="people-list" id={id} role="dialog" aria-label="Everyone here">
					<h3>
						Here now <span>{people.length + 1}</span>
					</h3>
					<ul>
						{people.map((person) => {
							const isFollowed = following === person.clientId;
							const status = statusLabel(person.status);
							return (
								<li key={person.clientId} data-status={person.status}>
									<Avatar user={person.user} status={person.status} />
									<span className="people-list-who">
										<span className="people-list-name">{person.user.name}</span>
										<span className="people-list-note">
											{[status || "Here", person.following === selfId ? "following you" : null]
												.filter(Boolean)
												.join(" · ")}
										</span>
									</span>
									{onJump && person.view && (
										<button
											type="button"
											onClick={() => {
												onJump(person.clientId);
												setOpen(false);
											}}
										>
											Jump to
										</button>
									)}
									<button
										type="button"
										aria-pressed={isFollowed}
										className="people-list-follow"
										onClick={() => {
											onFollow(isFollowed ? null : person.clientId);
											setOpen(false);
										}}
									>
										{isFollowed ? "Stop" : "Follow"}
									</button>
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</div>
	);
}

export function Avatar({
	user,
	status = "active",
	followsYou = false,
	pressed,
	label,
	hint,
	onClick,
}: {
	user: User;
	status?: Status;
	followsYou?: boolean;
	/** Whether we're following them; undefined for a plain avatar. */
	pressed?: boolean;
	/** Who they are, for the tooltip and screen readers. Omit for a decorative avatar. */
	label?: string;
	/** What clicking does, shown in the tooltip. */
	hint?: string;
	onClick?: () => void;
}) {
	const style = { "--avatar": user.color } as React.CSSProperties;
	const tooltip = label && hint ? `${label}\n${hint}` : label;
	// Clicking says what it did (the ring, the Following pill): the tooltip
	// gets out of the way until the pointer leaves.
	const [clicked, setClicked] = useState(false);
	const content = (
		<>
			{initials(user.name)}
			{user.avatarUrl && <AvatarImage key={user.avatarUrl} src={user.avatarUrl} />}
			{followsYou && (
				<span className="avatar-badge" aria-hidden="true">
					<svg width="10" height="10" viewBox="0 0 10 10">
						<path d="M1 5s1.5-2.75 4-2.75S9 5 9 5 7.5 7.75 5 7.75 1 5 1 5z" />
						<circle cx="5" cy="5" r="1.2" />
					</svg>
				</span>
			)}
		</>
	);
	if (!onClick) {
		return (
			<span className="avatar" style={style} data-status={status} data-tooltip={tooltip}>
				{label && <span className="visually-hidden">{label}</span>}
				<span aria-hidden="true">{content}</span>
			</span>
		);
	}
	return (
		<button
			type="button"
			className="avatar"
			style={style}
			data-status={status}
			data-tooltip={tooltip}
			aria-label={`${hint ?? ""} ${label ?? user.name}`.trim()}
			aria-pressed={pressed}
			data-clicked={clicked || undefined}
			onPointerLeave={() => setClicked(false)}
			onClick={() => {
				setClicked(true);
				onClick();
			}}
		>
			{content}
		</button>
	);
}

/** A signed-in person's GitHub picture, fading in over their initials once it loads. */
function AvatarImage({ src }: { src: string }) {
	const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
	if (state === "failed") return null;
	return (
		<img
			className="avatar-image"
			src={src}
			alt=""
			data-loaded={state === "loaded"}
			onLoad={() => setState("loaded")}
			onError={() => setState("failed")}
		/>
	);
}
