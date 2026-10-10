import type { BoardInfo, BoardList } from "../../shared/boards.ts";

// The home page's tabs, from the board list: pure, so it's unit-tested.

export type Tab = "recent" | "mine" | "shared" | "open" | "archived";

/** Boards you were invited to and haven't opened yet. */
export function unseenShared(list: BoardList): BoardInfo[] {
	return list.shared.filter((board) => board.visitedAt === null);
}

/**
 * Each tab's boards. Recent leads with boards shared with you that you
 * haven't opened yet, so an invite is the first thing you see; the team's
 * boards leave out yours and those shared with you, which have tabs.
 */
export function tabLists(list: BoardList): Record<Tab, BoardInfo[]> {
	const unseen = unseenShared(list);
	const recentIds = new Set(list.recent.map((board) => board.id));
	const yours = new Set([...list.mine, ...list.shared].map((board) => board.id));
	return {
		recent: [...unseen.filter((board) => !recentIds.has(board.id)), ...list.recent],
		mine: list.mine,
		shared: list.shared,
		open: list.open.filter((board) => !yours.has(board.id)),
		archived: list.archived,
	};
}

/** The tab a home page opens on: what you were last at, else what's yours. */
export function defaultTab(lists: Record<Tab, BoardInfo[]>): Tab {
	if (lists.recent.length > 0) return "recent";
	if (lists.mine.length > 0 || lists.shared.length === 0) return "mine";
	return "shared";
}

/** The list with one board renamed where it is (re-sorting would move it from under you). */
export function renameIn(list: BoardList, id: string, title: string, slug: string): BoardList {
	const rename = (boards: BoardInfo[]) =>
		boards.map((board) => (board.id === id ? { ...board, title, slug } : board));
	return {
		...list,
		recent: rename(list.recent),
		mine: rename(list.mine),
		shared: rename(list.shared),
		archived: rename(list.archived),
		open: rename(list.open),
	};
}
