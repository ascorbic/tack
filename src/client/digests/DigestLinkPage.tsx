import { useEffect, useRef, useState } from "react";
import { describeDigestError } from "../../shared/digests.ts";
import { type TokenResult, followToken } from "./api.ts";
import "../boards/templates.css";
import "../export/export.css";
import "./digests.css";

// Where the links in digest emails land (#68), signed in or not:
//
//   /digest?confirm=TOKEN              confirms an address, straight away
//   /digest?unsubscribe=1&token=TOKEN  stops the digest, on a click
//
// Confirming happens on load: only someone signed in asked for it, to an
// address they typed. Stopping waits for a click, so a mail scanner opening
// the link doesn't unsubscribe anyone (mail clients' one-click unsubscribe
// posts to the API directly, RFC 8058).

export type DigestLinkState =
	| { kind: "busy" }
	| { kind: "ask"; token: string }
	| { kind: "done"; action: "confirm" | "unsubscribe"; result: TokenResult & { ok: true } }
	| { kind: "error"; message: string };

export function readLink(
	search: string,
): { kind: "confirm" | "unsubscribe"; token: string } | null {
	const params = new URLSearchParams(search);
	const confirm = params.get("confirm");
	if (confirm) return { kind: "confirm", token: confirm };
	const token = params.get("token");
	if (params.has("unsubscribe") && token) return { kind: "unsubscribe", token };
	return null;
}

export default function DigestLinkPage() {
	const [link] = useState(() => readLink(location.search));
	useEffect(() => {
		document.title = "Weekly digest · Tack";
	}, []);
	return <DigestLink link={link} follow={followToken} />;
}

export function DigestLink({
	link,
	follow,
	initial,
}: {
	link: { kind: "confirm" | "unsubscribe"; token: string } | null;
	/** Where links are followed; the gallery passes its own. */
	follow: typeof followToken;
	initial?: DigestLinkState;
}) {
	const [state, setState] = useState<DigestLinkState>(
		() =>
			initial ??
			(!link
				? { kind: "error", message: describeDigestError("expired") }
				: link.kind === "confirm"
					? { kind: "busy" }
					: { kind: "ask", token: link.token }),
	);
	const started = useRef(false);

	const go = async (kind: "confirm" | "unsubscribe", token: string) => {
		setState({ kind: "busy" });
		const result = await follow(kind, token);
		if (result.ok) setState({ kind: "done", action: kind, result });
		else setState({ kind: "error", message: describeDigestError(result.error) });
	};

	useEffect(() => {
		if (initial || started.current || link?.kind !== "confirm") return;
		started.current = true;
		void go("confirm", link.token);
		// Once, on arrival.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<main className="digest-link-page">
			<section
				className="digest-link-card"
				data-tone={state.kind === "error" ? "error" : state.kind === "busy" ? "busy" : undefined}
				aria-live="polite"
			>
				<Mark kind={state.kind === "error" ? "error" : state.kind === "done" ? "done" : "mail"} />
				{state.kind === "busy" && (
					<>
						<h1>One moment…</h1>
						<p>{link?.kind === "confirm" ? "Confirming your address." : "Stopping your digest."}</p>
					</>
				)}
				{state.kind === "ask" && (
					<>
						<h1>Stop this digest?</h1>
						<p>You won’t get this board’s weekly digest by email any more.</p>
						<button
							type="button"
							className="primary new-board-create"
							onClick={() => void go("unsubscribe", state.token)}
						>
							Stop emailing me
						</button>
					</>
				)}
				{state.kind === "done" && state.action === "confirm" && (
					<>
						<h1>You’re all set</h1>
						<p>
							The weekly digest of <strong>{state.result.title ?? "the board"}</strong> comes to
							your inbox
							{state.result.schedule ? `, ${state.result.schedule}` : " once a week"}. Every email
							has a link to stop.
						</p>
						{state.result.path && (
							<a className="primary new-board-create" href={state.result.path}>
								Open the board
							</a>
						)}
					</>
				)}
				{state.kind === "done" && state.action === "unsubscribe" && (
					<>
						<h1>Stopped</h1>
						<p>
							{state.result.title ? (
								<>
									No more digests of <strong>{state.result.title}</strong>.
								</>
							) : (
								"No more digests of that board."
							)}{" "}
							You can ask for it again from the board’s menu.
						</p>
					</>
				)}
				{state.kind === "error" && (
					<>
						<h1>That didn’t work</h1>
						<p>{state.message}</p>
						<a className="primary new-board-create" href="/">
							Go to your boards
						</a>
					</>
				)}
			</section>
		</main>
	);
}

function Mark({ kind }: { kind: "mail" | "done" | "error" }) {
	return (
		<svg className="digest-link-mark" viewBox="0 0 56 56" aria-hidden="true">
			<circle cx="28" cy="28" r="26" />
			{kind === "done" ? (
				<path d="m18 29 7 7 13-15" pathLength="1" />
			) : kind === "error" ? (
				<path d="M28 18v12M28 37v.5" pathLength="1" />
			) : (
				<path d="M17 21h22v15H17ZM17.5 22 28 30l10.5-8" pathLength="1" />
			)}
		</svg>
	);
}
