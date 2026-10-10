import type { MemberRole, Visibility } from "../../shared/boards.ts";

// Who can open a board, in a few words: the chip beside a board's title,
// and the access picker for new boards, which remembers your choice.

/** The chip beside the title: short, and saying who can edit. */
export function accessLabel(visibility: Visibility, instanceRole: MemberRole): string {
	switch (visibility) {
		case "private":
			return "Invite only";
		case "instance":
			return instanceRole === "editor" ? "Anyone here can edit" : "Anyone here can view";
		case "public":
			return "Public";
	}
}

/** The chip's tooltip: the whole of it. */
export function accessDescription(visibility: Visibility, instanceRole: MemberRole): string {
	const here = `everyone on this Tack can ${instanceRole === "editor" ? "edit" : "view"}`;
	switch (visibility) {
		case "private":
			return "Only people invited can open this board";
		case "instance":
			return `Besides the people invited, ${here}`;
		case "public":
			return `Anyone with the link can view, and ${here}`;
	}
}

const KEY = "tack:new-board-access";

/** Who your new boards are open to, as you last chose (per person, in this browser). */
export function rememberedAccess(login: string | undefined): Visibility {
	try {
		const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
		const value = login ? stored[login.toLowerCase()] : undefined;
		return value === "private" || value === "instance" ? value : "instance";
	} catch {
		return "instance";
	}
}

export function rememberAccess(login: string | undefined, visibility: Visibility): void {
	if (!login) return;
	try {
		const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
		stored[login.toLowerCase()] = visibility;
		localStorage.setItem(KEY, JSON.stringify(stored));
	} catch {}
}
