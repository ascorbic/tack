import type { Card, MissingCard } from "./cards.ts";
import { DISCUSSION_CLOSE, type Operation } from "./changes.ts";

// Confirming pushed changes: a change the forge accepted is `sent` until the
// card shows it (from a webhook, or reconciliation), then `applied`.

/**
 * Whether a card shows what an operation did: `true` if it does, `false`
 * if it doesn't (yet), and `null` if no card could, such as a comment or a
 * milestone (cards don't show those), in which case the forge's answer is
 * the confirmation. Pending targets must be resolved first.
 *
 * For creates, `card` is the created item's card.
 */
export function reflects(op: Operation, card: Card | MissingCard): boolean | null {
	switch (op.kind) {
		case "issue.create":
			return !("missing" in card) && card.kind === "issue";
		case "pr.create":
			return !("missing" in card) && card.kind === "pull";
		case "item.labels": {
			if ("missing" in card) return false;
			const names = new Set(card.labels.map((label) => label.name.toLowerCase()));
			return (
				(op.add ?? []).every((name) => names.has(name.toLowerCase())) &&
				!(op.remove ?? []).some((name) => names.has(name.toLowerCase()))
			);
		}
		case "item.assignees": {
			if ("missing" in card) return false;
			const logins = new Set(card.assignees.map((person) => person.login.toLowerCase()));
			return (
				(op.add ?? []).every((login) => logins.has(login.toLowerCase())) &&
				!(op.remove ?? []).some((login) => logins.has(login.toLowerCase()))
			);
		}
		case "item.state": {
			if ("missing" in card) return false;
			if (op.state === "open") return card.state === "open" || card.state === "draft";
			if (card.state !== "closed" && card.state !== "merged") return false;
			// Pull requests have no reason; issues closed without one are completed.
			if (!op.reason || card.kind === "pull" || card.stateReason === null) return true;
			// Discussions call the reasons something else: resolved, outdated.
			const reason = card.kind === "discussion" ? DISCUSSION_CLOSE[op.reason] : op.reason;
			return card.stateReason.toLowerCase() === reason;
		}
		case "item.milestone":
		case "item.subIssue":
		case "item.blockedBy":
		case "item.comment":
		case "discussion.create":
			return null;
	}
}

/**
 * The item a sent change is confirmed on: the item it created, or the one
 * it changed. Null for changes no card shows.
 */
export function confirmationKey(op: Operation, resultKey?: string): string | null {
	switch (op.kind) {
		case "issue.create":
		case "pr.create":
			return resultKey?.toLowerCase() ?? null;
		case "item.labels":
		case "item.assignees":
		case "item.state":
			return "key" in op.target ? op.target.key.toLowerCase() : (resultKey?.toLowerCase() ?? null);
		default:
			return null;
	}
}
