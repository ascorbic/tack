import { isApplePlatform, shortcutHint } from "../shortcuts.ts";
import type { ToastStore } from "../Toasts.tsx";
import type { History } from "../undo.ts";

const apple = isApplePlatform();

/**
 * Say what was staged, with Undo, as deleting does. The toast goes as soon as
 * something else is done, since Undo would then undo that instead.
 */
export function undoToast(toasts: ToastStore, history: History, message: string): void {
	const step = history.top();
	const toast = toasts.show({
		message,
		action: {
			label: "Undo",
			hint: shortcutHint("undo", apple),
			run: () => {
				if (history.top() === step) history.undo();
			},
		},
	});
	const unsubscribe = history.subscribe(() => {
		if (history.top() !== step) {
			toasts.dismiss(toast);
			unsubscribe();
		}
	});
}
