import { type ReactNode, useState } from "react";
import { type Status, statusLabel } from "./activity.ts";
import type { RemotePresence, User } from "./presence.ts";

/** Avatars shown before the rest collapse into "+N". */
const MAX_SHOWN = 5;

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
 * again to stop. Idle and away people fade back.
 */
export function People({
	user,
	selfId,
	people,
	following,
	onFollow,
	self,
}: {
	user: User;
	/** Our awareness client id, to spot people following us. */
	selfId: number;
	people: RemotePresence[];
	following: number | null;
	onFollow: (clientId: number | null) => void;
	/** Your own avatar, e.g. an account menu, given its label. Defaults to a plain avatar. */
	self?: (label: string) => ReactNode;
}) {
	const shown = people.slice(0, MAX_SHOWN);
	const rest = people.slice(MAX_SHOWN);
	const followers = people.filter((p) => p.following === selfId).length;
	const selfLabel =
		followers > 0
			? `${user.name} (you) · ${followers === 1 ? "1 person" : `${followers} people`} following you`
			: `${user.name} (you)`;
	return (
		<div className="people" role="group" aria-label="People here">
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
				<span
					className="avatar avatar-more"
					data-tooltip={rest.map((p) => p.user.name).join(", ")}
					aria-label={`${rest.length} more: ${rest.map((p) => p.user.name).join(", ")}`}
				>
					+{rest.length}
				</span>
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
			onClick={onClick}
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
