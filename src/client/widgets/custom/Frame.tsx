import { useEffect, useRef, useState } from "react";
import { SANDBOX_PATH } from "../../../shared/customWidgets.ts";
import type { CustomDataSource } from "./data.ts";
import { type LogEntry, SandboxHost, type SandboxStatus } from "./sandbox.ts";

/**
 * A custom widget's code, running in its sandbox (#66): an iframe with
 * `sandbox="allow-scripts"` and nothing else, loading the Worker's sandbox
 * page, and a `SandboxHost` answering it. It runs once: give it a new `key`
 * to run new code. Once stopped (it never loaded, or stopped answering) the
 * iframe is gone, and `onStatus` says why.
 */
export function SandboxFrame({
	widget,
	code,
	config,
	data,
	interactive = true,
	onStatus,
	onLog,
}: {
	widget: { id: string; title: string };
	code: string;
	config: Record<string, unknown>;
	data: CustomDataSource;
	/** Whether it takes the pointer (on the board: only once the widget is selected). */
	interactive?: boolean;
	onStatus?: (status: SandboxStatus) => void;
	onLog?: (entry: LogEntry) => void;
}) {
	const ref = useRef<HTMLIFrameElement>(null);
	const [status, setStatus] = useState<SandboxStatus>({ kind: "starting" });
	const handlers = useRef({ onStatus, onLog });
	handlers.current = { onStatus, onLog };
	// What it starts with: a new run is a new `key`.
	const [start] = useState(() => ({ widget, code, config, data }));

	useEffect(() => {
		const frame = ref.current;
		if (!frame) return;
		const host = new SandboxHost(frame, {
			...start,
			onStatus: (next) => {
				setStatus(next);
				handlers.current.onStatus?.(next);
			},
			onLog: (entry) => handlers.current.onLog?.(entry),
		});
		return () => host.destroy();
	}, [start]);

	if (status.kind === "stopped") return null;
	return (
		<iframe
			ref={ref}
			className="custom-frame"
			data-status={status.kind}
			src={SANDBOX_PATH}
			// Scripts, and nothing else: an opaque origin, no popups, forms or navigating the board.
			sandbox="allow-scripts"
			allow=""
			referrerPolicy="no-referrer"
			title={`${widget.title || "Custom widget"} (custom widget)`}
			tabIndex={interactive ? 0 : -1}
			style={{ pointerEvents: interactive ? "auto" : "none" }}
		/>
	);
}
