import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// Small, transient messages at the bottom of the canvas, FigJam-style:
// "Deleted 5 stickies · Undo". Used instead of confirmation dialogs.

export interface Toast {
	id: number;
	message: string;
	action?: { label: string; hint?: string; run: () => void };
}

const LIFETIME_MS = 6000;

export class ToastStore {
	private toasts: Toast[] = [];
	private readonly listeners = new Set<() => void>();
	private nextId = 1;

	show(toast: Omit<Toast, "id">): number {
		const id = this.nextId++;
		// One at a time: a new toast replaces the last, like FigJam's.
		this.toasts = [{ ...toast, id }];
		this.emit();
		return id;
	}

	dismiss(id: number): void {
		const next = this.toasts.filter((toast) => toast.id !== id);
		if (next.length === this.toasts.length) return;
		this.toasts = next;
		this.emit();
	}

	getSnapshot = (): Toast[] => this.toasts;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

export function Toasts({ store }: { store: ToastStore }) {
	const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot);
	// Keep the last toast mounted while it animates out.
	const [leaving, setLeaving] = useState<Toast | null>(null);
	const previous = useRef<Toast | undefined>(undefined);
	const current = toasts[0];
	useEffect(() => {
		if (previous.current && previous.current.id !== current?.id) setLeaving(previous.current);
		previous.current = current;
	}, [current]);

	return (
		<div className="toasts" role="status" aria-live="polite">
			{leaving && leaving.id !== current?.id && (
				<ToastView
					key={leaving.id}
					toast={leaving}
					leaving
					onGone={() => setLeaving(null)}
					onDismiss={() => {}}
				/>
			)}
			{current && (
				<ToastView key={current.id} toast={current} onDismiss={() => store.dismiss(current.id)} />
			)}
		</div>
	);
}

function ToastView({
	toast,
	leaving = false,
	onDismiss,
	onGone,
}: {
	toast: Toast;
	leaving?: boolean;
	onDismiss: () => void;
	onGone?: () => void;
}) {
	const [paused, setPaused] = useState(false);
	const dismiss = useRef(onDismiss);
	dismiss.current = onDismiss;
	useEffect(() => {
		if (leaving || paused) return;
		const timer = setTimeout(() => dismiss.current(), LIFETIME_MS);
		return () => clearTimeout(timer);
	}, [leaving, paused]);

	return (
		<div
			className="toast"
			data-leaving={leaving}
			onPointerEnter={() => setPaused(true)}
			onPointerLeave={() => setPaused(false)}
			onAnimationEnd={(event) => {
				if (leaving && event.animationName === "toast-out") onGone?.();
			}}
		>
			<span className="toast-message">{toast.message}</span>
			{toast.action && (
				<button
					type="button"
					className="toast-action"
					tabIndex={leaving ? -1 : 0}
					onClick={() => {
						toast.action?.run();
						onDismiss();
					}}
				>
					{toast.action.label}
					{toast.action.hint && <kbd>{toast.action.hint}</kbd>}
				</button>
			)}
		</div>
	);
}
