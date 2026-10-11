import { useEffect, useMemo, useState } from "react";
import { CUSTOM_EXAMPLES, exampleConfig } from "../../../shared/customWidgetExamples.ts";
import { type CustomConfig, customWidget, parseSettings } from "../../../shared/customWidgets.ts";
import type { ShapeProps } from "../../../shared/shapes.ts";
import { ConfigToolbar, suggestedRepo, useWidgetHost } from "../host.tsx";
import { useRefreshing, widgetStore } from "../store.ts";
import { useResizeGrips } from "../WidgetNode.tsx";
import { CustomView, type CustomState } from "./CustomView.tsx";
import { liveSource } from "./data.ts";
import { CustomEditor } from "./Editor.tsx";
import { SandboxFrame } from "./Frame.tsx";
import type { SandboxStatus } from "./sandbox.ts";
import { useCustomWidgets } from "./state.ts";

/**
 * A custom widget on the board (#66): its code running in a sandbox, once
 * the board's owner allows custom widgets, taking the pointer once it's
 * selected (so the board pans and selects as usual around it), with its
 * editor beside it.
 */
export function CustomWidget({
	id,
	shape,
	selected,
}: {
	id: string;
	shape: ShapeProps;
	selected: boolean;
}) {
	const host = useWidgetHost(id, shape, customWidget);
	const { config, readOnly } = host;
	const allowed = useCustomWidgets();
	const refreshing = useRefreshing(id);
	const data = useMemo(() => liveSource(id), [id]);
	useEffect(() => () => data.release(), [data]);
	const settings = useMemo(() => parseSettings(config.data), [config.data]);
	const repo = suggestedRepo(host.doc)?.repo ?? null;

	// Every change to what runs (and Run again) starts it afresh.
	const [runs, setRuns] = useState(0);
	const [status, setStatus] = useState<SandboxStatus>({ kind: "starting" });
	const [errors, setErrors] = useState(0);
	const run = `${runs}\n${config.title}\n${config.code}\n${config.data}\n${allowed.enabled}`;
	useEffect(() => {
		setStatus({ kind: "starting" });
		setErrors(0);
	}, [run]);

	const state: CustomState = !allowed.enabled
		? { kind: "off" }
		: !config.code.trim()
			? { kind: "empty" }
			: !settings.ok
				? { kind: "invalid", message: settings.error }
				: status.kind === "stopped"
					? { kind: "stopped", message: status.message }
					: { kind: "running" };

	const apply = (next: CustomConfig) => host.change(next);
	const useExample = (exampleId: string) => {
		const example = CUSTOM_EXAMPLES.find((each) => each.id === exampleId);
		if (example) apply(exampleConfig(example, repo));
	};

	return (
		<div className="widget-frame">
			<CustomView
				title={config.title}
				state={state}
				selected={selected}
				enter={host.enter}
				readOnly={readOnly}
				interactive={selected}
				errors={errors}
				refreshing={refreshing}
				onEnable={allowed.openSettings ?? undefined}
				onEdit={() => host.setConfigOpen((open) => !open)}
				onRunAgain={() => setRuns((n) => n + 1)}
				onRefresh={() => widgetStore.refresh(id)}
				onExample={readOnly ? undefined : useExample}
			>
				{state.kind === "running" && settings.ok && (
					<SandboxFrame
						key={run}
						widget={{ id, title: config.title }}
						code={config.code}
						config={settings.value}
						data={data}
						interactive={selected}
						onStatus={setStatus}
						onLog={(entry) => {
							if (entry.level === "uncaught" || entry.level === "error") setErrors((n) => n + 1);
						}}
					/>
				)}
			</CustomView>
			{useResizeGrips(id, shape, selected)}
			<ConfigToolbar id={id} open={host.configOpen}>
				<CustomEditor
					id={id}
					config={config}
					readOnly={readOnly}
					enabled={allowed.enabled}
					data={data}
					suggestedRepo={repo}
					onApply={apply}
					onEnable={allowed.openSettings ?? undefined}
					onClose={() => host.setConfigOpen(false)}
				/>
			</ConfigToolbar>
		</div>
	);
}
