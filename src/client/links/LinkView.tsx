import { useRef, useState } from "react";
import { type LinkPreview, linkHost, linkHue, linkLabel } from "../../shared/linkPreview.ts";
import { safeUrl } from "../changes/inline.ts";
import { type Entrance, entranceStyle } from "../entering.ts";
import "./links.css";

// A link card (links.ts): a web page as its preview, beside issue cards and
// stickies. The preview image (or, without one, the site's icon on a tint of
// its own), then the site, the title, the description and where it is. It
// opens as a card's title does: once selected, or with ⌘/Ctrl, and the ↗ at
// once. Images come through the instance (`imageSrc`), never from the page's
// own host, and one that won't load falls back to the tint, never a broken
// image.

export type LinkState =
	/** Being read for the first time, here. */
	| "loading"
	/** Read: whatever it said. */
	| "ok"
	| "failed"
	| "blocked"
	/** Not read yet, and not by this client (a viewer, or nobody's asked). */
	| "pending";

export interface LinkViewProps {
	url: string;
	preview: LinkPreview | null;
	/** This client is reading it for the first time. */
	loading?: boolean;
	selected?: boolean;
	/** Simplified rendering for low zoom levels. */
	compact?: boolean;
	enter?: boolean;
	entrance?: Entrance | null;
	/** Where to load an image from (the instance's proxy), or null to show none. */
	imageSrc?: (src: string) => string | null;
}

export function linkState(preview: LinkPreview | null, loading?: boolean): LinkState {
	if (preview) return preview.status;
	return loading ? "loading" : "pending";
}

/** The first letter or digit of a host, for a tile when there's no icon. */
function initialOf(host: string): string {
	return (/[a-z0-9]/i.exec(host.replace(/^www\./, ""))?.[0] ?? "·").toUpperCase();
}

/** An image through the instance that, if it won't load, is never shown broken. */
function useImage(src: string | undefined, imageSrc: LinkViewProps["imageSrc"]) {
	const [failed, setFailed] = useState<string | null>(null);
	const [loaded, setLoaded] = useState<string | null>(null);
	const resolved = src && imageSrc ? imageSrc(src) : null;
	const usable = resolved && failed !== resolved ? resolved : null;
	return {
		src: usable,
		loaded: usable !== null && loaded === usable,
		props: usable
			? {
					src: usable,
					onError: () => setFailed(usable),
					onLoad: () => setLoaded(usable),
				}
			: null,
	};
}

/** The site's icon, or its initial on its tint. */
export function SiteIcon({
	icon,
	host,
	imageSrc,
	size,
}: {
	icon?: string;
	host: string;
	imageSrc: LinkViewProps["imageSrc"];
	size: "small" | "large";
}) {
	const image = useImage(icon, imageSrc);
	return (
		<span className="link-icon" data-size={size} aria-hidden="true">
			{image.props ? (
				<img
					{...image.props}
					alt=""
					draggable={false}
					decoding="async"
					data-loaded={image.loaded || undefined}
				/>
			) : /^[\d.:[\]]+$/.test(host) ? (
				// An address, not a name: a globe rather than a digit.
				<svg className="link-globe" viewBox="0 0 16 16">
					<circle cx="8" cy="8" r="6.25" />
					<path d="M1.75 8h12.5M8 1.75c-3.2 3.4-3.2 9.1 0 12.5M8 1.75c3.2 3.4 3.2 9.1 0 12.5" />
				</svg>
			) : (
				<span className="link-initial">{initialOf(host)}</span>
			)}
		</span>
	);
}

export function LinkView({
	url,
	preview,
	loading,
	selected,
	compact,
	enter,
	entrance,
	imageSrc,
}: LinkViewProps) {
	const state = linkState(preview, loading);
	const host = linkHost(url);
	const href = safeUrl(url);
	const image = useImage(preview?.image, imageSrc);
	const title = preview?.title ?? linkLabel(url);
	const site = preview?.siteName ?? host;
	const hasImage = image.src !== null;
	const style = {
		"--link-hue": linkHue(url),
		...(entrance ? entranceStyle(entrance) : {}),
	} as React.CSSProperties;
	const arrival = entrance ? "expand" : enter || undefined;
	const titleLink = useTitleLink(selected);
	const openLabel = `Open ${host}`;

	const media =
		state === "loading" ? (
			<div className="link-media skeleton-media" aria-hidden="true" />
		) : hasImage && image.props ? (
			<div className="link-media" data-loaded={image.loaded || undefined}>
				<img className="link-image" {...image.props} alt="" draggable={false} decoding="async" />
			</div>
		) : (
			<div className="link-media link-tint" aria-hidden="true">
				<SiteIcon icon={preview?.icon} host={host} imageSrc={imageSrc} size="large" />
			</div>
		);

	if (compact) {
		return (
			<article
				className="card link-card compact"
				data-state={state}
				data-image={hasImage || undefined}
				data-selected={selected}
				data-enter={arrival}
				style={style}
			>
				{media}
				<div className="link-body">
					<span className="link-compact-title">{state === "loading" ? host : title}</span>
					<span className="link-compact-host">{host}</span>
				</div>
			</article>
		);
	}

	return (
		<article
			className="card link-card"
			data-state={state}
			data-image={hasImage || undefined}
			data-selected={selected}
			data-enter={arrival}
			aria-busy={state === "loading" || undefined}
			style={style}
		>
			{media}
			<div className="link-body">
				<div className="link-site">
					<SiteIcon icon={preview?.icon} host={host} imageSrc={imageSrc} size="small" />
					<span className="link-site-name">{site}</span>
					{href && (
						<a
							className="card-open link-open nodrag"
							href={href}
							target="_blank"
							rel="noreferrer noopener"
							referrerPolicy="no-referrer"
							draggable={false}
							aria-label={openLabel}
							title={openLabel}
						>
							<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
								<path d="M4.5 2.5h5v5M9.5 2.5 3 9" />
							</svg>
						</a>
					)}
				</div>
				{state === "loading" ? (
					<>
						<div className="link-url mono">{linkLabel(url)}</div>
						<div className="skeleton" style={{ width: "88%" }} />
						<div className="skeleton" style={{ width: "62%" }} />
					</>
				) : (
					<>
						<a
							className="link-title"
							href={href}
							target="_blank"
							rel="noreferrer noopener"
							referrerPolicy="no-referrer"
							draggable={false}
							{...titleLink}
						>
							{title}
						</a>
						{preview?.description ? (
							<p className="link-description">{preview.description}</p>
						) : state === "failed" || state === "blocked" ? (
							<p className="link-note">
								{state === "blocked"
									? "Tack doesn’t read previews from this address."
									: "No preview: the page couldn’t be read."}
							</p>
						) : null}
						{preview?.siteName && <div className="link-host mono">{host}</div>}
					</>
				)}
			</div>
		</article>
	);
}

/**
 * The title opens the page, but a plain click on a card that isn't selected
 * yet selects it (as cards' titles do): it opens once selected, with ⌘/Ctrl,
 * or from the keyboard. The end of a drag that started on it isn't a click.
 */
function useTitleLink(selected: boolean | undefined) {
	const press = useRef<{ selected: boolean; x: number; y: number } | null>(null);
	return {
		onPointerDown: (event: React.PointerEvent) => {
			press.current = { selected: !!selected, x: event.clientX, y: event.clientY };
		},
		onClick: (event: React.MouseEvent) => {
			const p = press.current;
			const moved = p ? Math.hypot(event.clientX - p.x, event.clientY - p.y) > 4 : false;
			const opens =
				event.detail === 0 ||
				(!moved && (event.metaKey || event.ctrlKey || (!!p?.selected && !event.shiftKey)));
			if (!opens) event.preventDefault();
		},
	};
}
