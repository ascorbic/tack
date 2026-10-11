import { type CSSProperties, type ReactNode, useState } from "react";
import { CUSTOM_EXAMPLES, exampleConfig } from "../../shared/customWidgetExamples.ts";
import { type CustomConfig, parseSettings } from "../../shared/customWidgets.ts";
import { CustomWidgetsPanel } from "../boards/CustomWidgetsDialog.tsx";
import { CustomView } from "../widgets/custom/CustomView.tsx";
import { CustomEditor } from "../widgets/custom/Editor.tsx";
import { SandboxFrame } from "../widgets/custom/Frame.tsx";
import type { LogEntry } from "../widgets/custom/sandbox.ts";
import { MILESTONE } from "./kindFixtures.ts";
import { fixtureSource } from "./custom.ts";
import { REPO } from "./widgets.ts";

// Every state of a custom widget (#66), for /play/widgets: off on the
// board (for its owner, and for everyone else), nothing written yet,
// settings that aren't JSON, running (selected or not, with errors),
// stopped, zoomed out; the editor (writing, its examples, settings that
// don't parse, read only) and the owner's switch, off and on.

const data = fixtureSource();
const example = (id: string): CustomConfig => {
	const found = CUSTOM_EXAMPLES.find((each) => each.id === id);
	if (!found) throw new Error(`No example ${id}`);
	return exampleConfig(found, REPO);
};
const BURNDOWN: CustomConfig = {
	...example("burndown"),
	data: JSON.stringify({ repo: REPO, milestone: MILESTONE }, null, 2),
};
const LABELS = example("labels");
/** How far out the zoomed-out sample is, as on a board at about 30%. */
const FAR = 3.4;
const AT = Date.UTC(2026, 9, 9, 14, 30);
const LOGS: LogEntry[] = [
	{ level: "log", text: "drawing 16 items", at: AT },
	{ level: "warn", text: "3 items have no milestone", at: AT + 10 },
	{ level: "uncaught", text: "TypeError: item.labels is undefined (line 12)", at: AT + 20 },
];

function Sample({
	state,
	label,
	h = 340,
	children,
}: {
	state: string;
	label: string;
	h?: number;
	children: ReactNode;
}) {
	return (
		<figure data-state={state}>
			<div className="widget-sample" style={{ height: h }}>
				{children}
			</div>
			<figcaption>{label}</figcaption>
		</figure>
	);
}

/** A running widget: its example's code, over the fake repository. */
function Running({
	config,
	selected = false,
	errors = 0,
}: {
	config: CustomConfig;
	selected?: boolean;
	errors?: number;
}) {
	const settings = parseSettings(config.data);
	return (
		<CustomView
			title={config.title}
			state={{ kind: "running" }}
			selected={selected}
			interactive={selected}
			errors={errors}
			onEdit={() => {}}
			onRefresh={() => {}}
		>
			<SandboxFrame
				widget={{ id: `gallery-${config.title}`, title: config.title }}
				code={config.code}
				config={settings.ok ? settings.value : {}}
				data={data}
				interactive={selected}
			/>
		</CustomView>
	);
}

export function CustomGallery() {
	const [enabled, setEnabled] = useState(false);
	return (
		<>
			<section>
				<h2>Custom widgets</h2>
				<div className="gallery-grid widget-samples">
					<Sample state="custom-running" label="Running, over the fake repository">
						<Running config={BURNDOWN} />
					</Sample>
					<Sample state="custom-selected" label="Selected: it takes the pointer, with errors">
						<Running config={LABELS} selected errors={2} />
					</Sample>
					<Sample state="custom-empty" label="Nothing written yet: start from an example">
						<CustomView
							title=""
							state={{ kind: "empty" }}
							selected
							onEdit={() => {}}
							onExample={() => {}}
						/>
					</Sample>
					<Sample state="custom-empty-view-only" label="Nothing written yet, view only">
						<CustomView title="" state={{ kind: "empty" }} readOnly />
					</Sample>
					<Sample state="custom-off-owner" label="Off on this board: for its owner">
						<CustomView
							title="Burndown"
							state={{ kind: "off" }}
							onEnable={() => {}}
							onEdit={() => {}}
						/>
					</Sample>
					<Sample state="custom-off" label="Off on this board: for everyone else">
						<CustomView title="Burndown" state={{ kind: "off" }} readOnly onEdit={() => {}} />
					</Sample>
					<Sample state="custom-invalid" label="Settings that aren't JSON">
						<CustomView
							title="Burndown"
							state={{
								kind: "invalid",
								message: "Settings aren’t valid JSON: Expected property name (line 1).",
							}}
							onEdit={() => {}}
						/>
					</Sample>
					<Sample state="custom-stopped" label="Stopped: it stopped answering">
						<CustomView
							title="Spinner"
							state={{
								kind: "stopped",
								message: "This widget stopped responding, so Tack stopped it.",
							}}
							onEdit={() => {}}
							onRunAgain={() => {}}
						/>
					</Sample>
					<figure data-state="custom-far">
						<div className="custom-gallery-far" style={{ width: 400 / FAR, height: 340 / FAR }}>
							<div
								className="widget-sample"
								data-far-zoom
								style={
									{
										width: 400,
										height: 340,
										"--unzoom": FAR,
										scale: 1 / FAR,
										transformOrigin: "0 0",
									} as CSSProperties
								}
							>
								<CustomView title="Burndown" state={{ kind: "running" }} />
							</div>
						</div>
						<figcaption>Zoomed out</figcaption>
					</figure>
				</div>
			</section>

			<section>
				<h2>Writing a custom widget</h2>
				<div className="gallery-grid widget-panels custom-gallery-panels">
					<figure data-state="custom-editor">
						<CustomEditor
							id="gallery-editor"
							config={BURNDOWN}
							readOnly={false}
							enabled
							data={data}
							suggestedRepo={REPO}
							onApply={() => {}}
							onClose={() => {}}
						/>
						<figcaption>Its code, with a live preview</figcaption>
					</figure>
					<figure data-state="custom-editor-examples">
						<CustomEditor
							id="gallery-examples"
							config={{ title: "", code: "", data: "{}" }}
							readOnly={false}
							enabled
							data={data}
							suggestedRepo={REPO}
							onApply={() => {}}
							onClose={() => {}}
							initialTab="examples"
						/>
						<figcaption>Examples to start from</figcaption>
					</figure>
					<figure data-state="custom-editor-settings">
						<CustomEditor
							id="gallery-settings"
							config={{ ...LABELS, data: '{ "repo": "acme/imagekit", }' }}
							readOnly={false}
							enabled
							data={data}
							suggestedRepo={REPO}
							onApply={() => {}}
							onClose={() => {}}
							initialTab="settings"
							initialLogs={LOGS}
						/>
						<figcaption>Settings that don't parse, and what the code logged</figcaption>
					</figure>
					<figure data-state="custom-editor-view-only">
						<CustomEditor
							id="gallery-view-only"
							config={LABELS}
							readOnly
							enabled={false}
							data={data}
							suggestedRepo={REPO}
							onApply={() => {}}
							onClose={() => {}}
						/>
						<figcaption>View only, with custom widgets off</figcaption>
					</figure>
					<figure data-state="custom-switch">
						<div className="custom-gallery-dialog">
							<CustomWidgetsPanel
								enabled={enabled}
								onChange={async (next) => {
									await new Promise((resolve) => setTimeout(resolve, 400));
									setEnabled(next);
									return null;
								}}
								onClose={() => {}}
							/>
						</div>
						<figcaption>The owner's switch (try it)</figcaption>
					</figure>
				</div>
			</section>
		</>
	);
}
