import type { NodeProps } from "@xyflow/react";
import {
	Component,
	type ComponentType,
	type ErrorInfo,
	type ReactNode,
	memo,
	useContext,
} from "react";
import type { ShapeNode } from "./board.ts";
import { deleteShapes } from "./board.ts";
import { DocContext, ReadOnlyContext } from "./DocContext.ts";
import { reportError } from "./errors.ts";
import "./errors.css";

// One shape that can't be drawn (a widget with unexpected data, a malformed
// card from a forge, a bad connector end) mustn't take the board down for
// everyone who has it on screen, and bring them straight back to a crash on
// reload. Each shape, the connector layer and each panel draws inside its
// own boundary: what fails says so in its place, is reported like any other
// render error, and the rest of the board carries on.

interface BoundaryProps {
	/** What to show instead, given a way to try again. */
	fallback: (retry: () => void) => ReactNode;
	/** When this changes (the shape was edited, perhaps fixed), try again. */
	resetKey?: unknown;
	children: ReactNode;
}

interface State {
	failed: boolean;
	resetKey: unknown;
}

/** Catches render errors below it, reports them, and shows `fallback` instead. */
export class PartBoundary extends Component<BoundaryProps, State> {
	override state: State = { failed: false, resetKey: this.props.resetKey };

	static getDerivedStateFromError(): Partial<State> {
		return { failed: true };
	}

	static getDerivedStateFromProps(props: BoundaryProps, state: State): Partial<State> | null {
		// Changed since it failed: draw it again.
		if (props.resetKey !== state.resetKey) return { failed: false, resetKey: props.resetKey };
		return null;
	}

	override componentDidCatch(error: unknown, info: ErrorInfo): void {
		reportError(error, "boundary", { componentStack: info.componentStack ?? undefined });
	}

	retry = () => this.setState({ failed: false });

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
	}
}

/** What a shape that can't be drawn shows in its place. */
function BrokenShape({ id, retry }: { id: string; retry: () => void }) {
	const doc = useContext(DocContext);
	const readOnly = useContext(ReadOnlyContext);
	return (
		<div className="broken-shape" role="alert">
			<span className="broken-shape-icon" aria-hidden="true">
				<svg viewBox="0 0 16 16" width="16" height="16">
					<path
						d="M8 1.5 15 14H1L8 1.5Z"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinejoin="round"
					/>
					<path d="M8 6v3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
					<circle cx="8" cy="11.6" r="0.85" fill="currentColor" />
				</svg>
			</span>
			<span className="broken-shape-text">This shape couldn’t be shown</span>
			<span className="broken-shape-actions">
				<button type="button" className="nodrag" onClick={retry}>
					Try again
				</button>
				{doc && !readOnly && (
					<button type="button" className="nodrag" onClick={() => deleteShapes(doc, [id])}>
						Delete
					</button>
				)}
			</span>
		</div>
	);
}

/** A node type that draws inside its own boundary (see above). */
export function withBoundary(Node: ComponentType<NodeProps<ShapeNode>>) {
	return memo(function WithBoundary(props: NodeProps<ShapeNode>) {
		return (
			<PartBoundary
				resetKey={props.data.shape}
				fallback={(retry) => <BrokenShape id={props.id} retry={retry} />}
			>
				<Node {...props} />
			</PartBoundary>
		);
	});
}

/** A panel or layer that draws inside its own boundary, saying so in a toast-sized note if it fails. */
export function PanelBoundary({ name, children }: { name: string; children: ReactNode }) {
	return (
		<PartBoundary
			fallback={(retry) => (
				<div className="broken-panel" role="alert">
					<span>{name} couldn’t be shown.</span>
					<button type="button" onClick={retry}>
						Try again
					</button>
				</div>
			)}
		>
			{children}
		</PartBoundary>
	);
}
