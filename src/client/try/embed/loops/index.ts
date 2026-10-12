import type { Feature, Loop } from "../loop.ts";
import { facilitationLoop } from "./facilitation.ts";
import { pushLoop } from "./push.ts";
import { stacksLoop } from "./stacks.ts";
import { widgetsLoop } from "./widgets.ts";

export const LOOPS: Record<Feature, Loop> = {
	stacks: stacksLoop,
	push: pushLoop,
	facilitation: facilitationLoop,
	widgets: widgetsLoop,
};
