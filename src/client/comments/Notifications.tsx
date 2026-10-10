import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { boardPath } from "../../shared/boards.ts";
import type { Notification, NotificationList } from "../../shared/comments.ts";
import { relativeTime } from "../boards/api.ts";
import { useLinger } from "../useLinger.ts";
import { Avatar } from "../People.tsx";
import { AtIcon, BellIcon, BubbleIcon } from "./icons.tsx";
import { authorUser, useNow } from "./Thread.tsx";
import "./comments.css";

// The top bar's notifications (#51): mentions, and replies in threads you're
// in, from every board you can open. Checked every minute and whenever the
// tab comes back; a mention on the board you're looking at shows at once.
// Opening one goes to its thread (`#comment=…`), on this board or another.

export interface NotificationsApi {
	list(): Promise<NotificationList | null>;
	read(which: {
		ids?: string[];
		board?: string;
		thread?: string;
		all?: boolean;
	}): Promise<NotificationList | null>;
}

export const liveNotifications: NotificationsApi = {
	list: async () => {
		const response = await fetch("/api/notifications", { headers: { accept: "application/json" } });
		return response.ok ? ((await response.json()) as NotificationList) : null;
	},
	read: async (which) => {
		const response = await fetch("/api/notifications/read", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify(which),
		});
		return response.ok ? ((await response.json()) as NotificationList) : null;
	},
};

const POLL_MS = 60_000;
const EMPTY: NotificationList = { notifications: [], unread: 0 };

export class NotificationStore {
	private list: NotificationList = EMPTY;
	private listeners = new Set<() => void>();
	private loading: Promise<void> | null = null;
	private again = false;
	private api: NotificationsApi;

	constructor(api: NotificationsApi = liveNotifications) {
		this.api = api;
	}

	/** Ask somewhere else from now on (the playground), forgetting anything on its way. */
	use(api: NotificationsApi): void {
		this.api = api;
		this.loading = null;
		void this.refresh();
	}

	get = (): NotificationList => this.list;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	refresh(): Promise<void> {
		// Asked again while asking: ask once more afterwards, as something may have changed.
		if (this.loading) {
			this.again = true;
			return this.loading;
		}
		const api = this.api;
		const loading = api
			.list()
			.then((list) => {
				// Only the answer from where we're asking now.
				if (list && api === this.api) this.set(list);
			})
			.catch(() => {})
			.finally(() => {
				if (this.loading !== loading) return;
				this.loading = null;
				if (this.again) {
					this.again = false;
					void this.refresh();
				}
			});
		this.loading = loading;
		return loading;
	}

	async read(which: Parameters<NotificationsApi["read"]>[0]): Promise<void> {
		// Show it read straight away.
		const matches = (n: Notification) =>
			which.all ||
			which.ids?.includes(n.id) ||
			(n.board.id === which.board && n.thread === which.thread);
		if (!this.list.notifications.some((n) => !n.read && matches(n))) return;
		const notifications = this.list.notifications.map((n) =>
			matches(n) ? { ...n, read: true } : n,
		);
		this.set({ notifications, unread: notifications.filter((n) => !n.read).length });
		const list = await this.api.read(which).catch(() => null);
		if (list) this.set(list);
	}

	set(list: NotificationList): void {
		this.list = list;
		for (const listener of this.listeners) listener();
	}
}

export const notificationStore = new NotificationStore();

export function NotificationsButton({
	boardId,
	store = notificationStore,
	initiallyOpen = false,
}: {
	/** The board you're on: its notifications open in place. */
	boardId?: string;
	store?: NotificationStore;
	initiallyOpen?: boolean;
}) {
	const list = useSyncExternalStore(store.subscribe, store.get);
	const [open, setOpen] = useState(initiallyOpen);
	const shown = useLinger(open ? true : null, 180);
	const root = useRef<HTMLDivElement>(null);
	const now = useNow();
	const unread = list.unread;
	const previous = useRef(unread);
	const [ring, setRing] = useState(0);

	useEffect(() => {
		void store.refresh();
		const timer = setInterval(() => void store.refresh(), POLL_MS);
		const onFocus = () => {
			if (document.visibilityState === "visible") void store.refresh();
		};
		document.addEventListener("visibilitychange", onFocus);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onFocus);
		};
	}, [store]);

	// The bell rings when something new arrives.
	useEffect(() => {
		if (unread > previous.current) setRing((n) => n + 1);
		previous.current = unread;
	}, [unread]);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
		window.addEventListener("pointerdown", onDown, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const go = (notification: Notification) => {
		void store.read({ ids: [notification.id] });
		setOpen(false);
		const hash = `#comment=${encodeURIComponent(notification.thread)}`;
		if (notification.board.id === boardId) {
			location.hash = hash;
		} else {
			location.assign(`${boardPath(notification.board)}${hash}`);
		}
	};

	return (
		<div className="notifications" ref={root}>
			<button
				type="button"
				className="notifications-button"
				aria-label={unread > 0 ? `Notifications: ${unread} unread` : "Notifications"}
				aria-expanded={open}
				data-tooltip={
					unread > 0
						? `${unread} unread: mentions of you and replies in threads you’re in, on any board`
						: "Mentions of you and replies in threads you’re in, on any board"
				}
				data-unread={unread > 0 || undefined}
				onClick={() => {
					setOpen((value) => !value);
					if (!open) void store.refresh();
				}}
			>
				<span className="notifications-bell" key={ring} data-ring={ring > 0 || undefined}>
					<BellIcon size={16} />
				</span>
				{unread > 0 && (
					<span className="notifications-badge" key={`n${unread}`}>
						{unread > 9 ? "9+" : unread}
					</span>
				)}
			</button>
			{shown.value && (
				<div
					className="notifications-popover"
					role="dialog"
					aria-label="Notifications"
					data-leaving={shown.leaving || undefined}
				>
					<header>
						<h2>Notifications</h2>
						{unread > 0 && (
							<button type="button" onClick={() => void store.read({ all: true })}>
								Mark all read
							</button>
						)}
					</header>
					{list.notifications.length === 0 ? (
						<div className="notifications-empty">
							<span className="notifications-empty-icon" aria-hidden="true">
								<AtIcon size={18} />
							</span>
							<strong>You’re all caught up</strong>
							<p>Mentions and replies to your comments show up here.</p>
						</div>
					) : (
						<ul>
							{list.notifications.map((notification, i) => (
								<li
									key={notification.id}
									data-unread={!notification.read || undefined}
									style={{ "--i": Math.min(i, 10) } as React.CSSProperties}
								>
									<button type="button" onClick={() => go(notification)}>
										<span className="notifications-avatar">
											<Avatar user={authorUser(notification.by)} />
											<span className="notifications-kind" data-kind={notification.kind}>
												{notification.kind === "mention" ? (
													<AtIcon size={10} />
												) : (
													<BubbleIcon size={10} />
												)}
											</span>
										</span>
										<span className="notifications-main">
											<span className="notifications-line">
												<strong>{notification.by.name || notification.by.login}</strong>{" "}
												{notification.kind === "mention" ? "mentioned you" : "replied"}
												{notification.board.id === boardId ? (
													" here"
												) : (
													<>
														{" "}
														on <em>{notification.board.title}</em>
													</>
												)}
											</span>
											<span className="notifications-excerpt">{notification.excerpt}</span>
											<time>{relativeTime(notification.at, now)}</time>
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}
