import { useCallback, useEffect, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type { Spotlight } from "../../shared/facilitation.ts";
import type { Author } from "../../shared/shapes.ts";
import type { RemotePresence } from "../presence.ts";
import { facilitation, useSpotlight } from "./store.ts";

// Spotlight (#50): "bring everyone to me". Stronger than following: when
// someone spotlights, everyone else starts following them at once, and a
// latecomer joins on arrival. People can still break out (any pan or zoom of
// their own, or Escape, as with following), and rejoin with a click. It
// ends when the spotlighter stops or leaves.

interface FollowControls {
	following: number | null;
	follow: (clientId: number | null) => void;
	stop: () => void;
}

export function startSpotlight(awareness: Awareness, user: Author): void {
	facilitation.send({
		type: "spotlight",
		on: true,
		clientId: awareness.clientID,
		user: { name: user.name, color: user.color },
	});
}

export function stopSpotlight(): void {
	facilitation.send({ type: "spotlight", on: false });
}

export interface SpotlightState {
	spotlight: Spotlight | null;
	/** You're the one spotlighting. */
	mine: boolean;
	/** Whoever's spotlighting, if it's someone else and they're here. */
	leader: RemotePresence | undefined;
	/** You're following the spotlight right now. */
	along: boolean;
	/** You broke out of this spotlight. */
	brokeOut: boolean;
	rejoin: () => void;
}

export function useSpotlightFollow(
	awareness: Awareness,
	people: RemotePresence[],
	follow: FollowControls,
): SpotlightState {
	const spotlight = useSpotlight();
	const mine = spotlight?.clientId === awareness.clientID;
	const leaderId = spotlight && !mine ? spotlight.clientId : null;
	const leader = leaderId === null ? undefined : people.find((p) => p.clientId === leaderId);
	const run = spotlight ? `${spotlight.clientId}:${spotlight.since}` : null;
	const [brokeOutOf, setBrokeOutOf] = useState<string | null>(null);
	const along = leaderId !== null && follow.following === leaderId;

	// A new spotlight (or arriving during one) brings you along, once they're here.
	const present = leader !== undefined;
	const { follow: setFollowing, stop } = follow;
	useEffect(() => {
		if (leaderId !== null && present && brokeOutOf !== run) setFollowing(leaderId);
		// Only when the spotlight itself changes, or its holder appears.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [run, present]);

	// Panning away breaks out of it.
	const wasAlong = useRef(false);
	useEffect(() => {
		if (wasAlong.current && !along && leaderId !== null && present) setBrokeOutOf(run);
		wasAlong.current = along;
	}, [along, leaderId, present, run]);

	// It ended: stop following them.
	const lastLeader = useRef<number | null>(null);
	const following = follow.following;
	useEffect(() => {
		const last = lastLeader.current;
		lastLeader.current = leaderId;
		if (leaderId === null && last !== null && following === last) stop();
	}, [leaderId, following, stop]);

	const rejoin = useCallback(() => {
		setBrokeOutOf(null);
		if (leaderId !== null) setFollowing(leaderId);
	}, [leaderId, setFollowing]);

	return {
		spotlight,
		mine,
		leader,
		along,
		brokeOut: brokeOutOf !== null && brokeOutOf === run,
		rejoin,
	};
}

/**
 * What the spotlight looks like: following the spotlighter (a bright frame
 * in their colour, and a way to break out), having broken out (a way back),
 * or spotlighting yourself (who's with you, and Stop).
 */
export function SpotlightIndicator({
	state,
	withYou,
	onBreakOut,
}: {
	state: SpotlightState;
	/** How many people are following you, when you're spotlighting. */
	withYou: number;
	onBreakOut: () => void;
}) {
	const { spotlight, mine, leader, along, brokeOut, rejoin } = state;
	if (!spotlight) return null;
	if (mine) {
		return (
			<SpotlightPill color={spotlight.user.color} kind="mine">
				<span>
					You’re spotlighting
					<span className="spotlight-count">
						{withYou === 0 ? " · bringing everyone over…" : ` · ${withYou} with you`}
					</span>
				</span>
				<button type="button" onClick={stopSpotlight}>
					Stop
				</button>
			</SpotlightPill>
		);
	}
	if (!leader) return null;
	if (along) {
		return (
			<div
				className="follow spotlight"
				style={{ "--follow": leader.user.color } as React.CSSProperties}
				data-status={leader.status}
			>
				<div className="follow-frame spotlight-frame" aria-hidden="true" />
				<SpotlightPill color={leader.user.color} kind="along">
					<span>
						<strong>{leader.user.name}</strong> is spotlighting
					</span>
					<button type="button" onClick={onBreakOut}>
						Break out
					</button>
				</SpotlightPill>
			</div>
		);
	}
	if (brokeOut) {
		return (
			<SpotlightPill color={leader.user.color} kind="away">
				<span>
					<strong>{leader.user.name}</strong> is spotlighting
				</span>
				<button type="button" onClick={rejoin}>
					Rejoin
				</button>
			</SpotlightPill>
		);
	}
	return null;
}

export function SpotlightPill({
	color,
	kind,
	children,
}: {
	color: string;
	kind: "mine" | "along" | "away";
	children: React.ReactNode;
}) {
	return (
		<div
			className="spotlight-pill"
			data-kind={kind}
			role="status"
			style={{ "--spotlight": color || "var(--accent)" } as React.CSSProperties}
		>
			<SpotlightIcon />
			{children}
		</div>
	);
}

export function SpotlightIcon({ size = 16 }: { size?: number }) {
	return (
		<svg
			className="spotlight-icon"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			aria-hidden="true"
		>
			<path d="M3.2 2.5 7 9.2M12.8 2.5 9 9.2" className="spotlight-beam" />
			<ellipse cx="8" cy="12.2" rx="5" ry="1.9" />
		</svg>
	);
}
