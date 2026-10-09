import type { Visibility } from "../../shared/boards.ts";

// Small line icons for boards, drawn on a 16px grid with `currentColor`.

export function VisibilityIcon({
	visibility,
	size = 16,
}: {
	visibility: Visibility;
	size?: number;
}) {
	return (
		<svg
			className="icon"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			aria-hidden="true"
			data-visibility={visibility}
		>
			{visibility === "private" && (
				<>
					<rect x="3.25" y="7" width="9.5" height="6.5" rx="1.6" />
					<path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7" />
				</>
			)}
			{visibility === "instance" && (
				<>
					<circle cx="6" cy="5.5" r="2.1" />
					<path d="M2.25 13c.4-2.2 1.9-3.5 3.75-3.5S9.35 10.8 9.75 13" />
					<circle cx="11.25" cy="6.25" r="1.65" />
					<path d="M10.6 9.6c1.7-.3 3 .8 3.3 2.9" />
				</>
			)}
			{visibility === "public" && (
				<>
					<circle cx="8" cy="8" r="5.75" />
					<path d="M2.4 8h11.2M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25z" />
				</>
			)}
		</svg>
	);
}

export const VISIBILITY_LABEL: Record<Visibility, string> = {
	private: "Private",
	instance: "Everyone on this Tack",
	public: "Public",
};

export function PlusIcon() {
	return (
		<svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M8 3v10M3 8h10" />
		</svg>
	);
}

export function ShareIcon() {
	return (
		<svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="6" cy="6" r="2.25" />
			<path d="M2 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5M12 5v5M9.5 7.5h5" />
		</svg>
	);
}

export function EyeIcon() {
	return (
		<svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" />
			<circle cx="8" cy="8" r="2" />
		</svg>
	);
}

export function ArchiveIcon() {
	return (
		<svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<rect x="2" y="3" width="12" height="3" rx="1" />
			<path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 8.75h3" />
		</svg>
	);
}

export function SearchIcon() {
	return (
		<svg className="icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="7" cy="7" r="4.25" />
			<path d="M10.25 10.25L13.5 13.5" />
		</svg>
	);
}

export function MoreIcon() {
	return (
		<svg className="icon icon-fill" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="3.5" cy="8" r="1.3" />
			<circle cx="8" cy="8" r="1.3" />
			<circle cx="12.5" cy="8" r="1.3" />
		</svg>
	);
}
