import { Component, type ErrorInfo, type ReactNode } from "react";
import { BrandMark } from "./BrandMark.tsx";
import { reportError } from "./errors.ts";
import "./errors.css";

interface State {
	error: Error | null;
}

/** Catches render errors anywhere below it, reports them, and shows a fallback. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
	override state: State = { error: null };

	static getDerivedStateFromError(error: unknown): State {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	override componentDidCatch(error: unknown, info: ErrorInfo): void {
		reportError(error, "boundary", { componentStack: info.componentStack ?? undefined });
	}

	override render(): ReactNode {
		const { error } = this.state;
		return error ? <ErrorFallback error={error} /> : this.props.children;
	}
}

export function ErrorFallback({ error }: { error: Error }) {
	return (
		<main className="crash" role="alert">
			<div className="crash-panel">
				<span className="crash-mark">
					<BrandMark size={56} />
				</span>
				<h1>Something came unstuck</h1>
				<p>
					Tack hit an unexpected error and couldn’t carry on. Boards are saved as you go, so
					reloading is safe. We’ve logged what happened.
				</p>
				<div className="crash-actions">
					<button type="button" className="primary" onClick={() => location.reload()}>
						Reload
					</button>
					<a href="/">Go to Tack home</a>
				</div>
				<details>
					<summary>Error details</summary>
					<pre className="mono">
						{error.name}: {error.message}
					</pre>
				</details>
			</div>
		</main>
	);
}
