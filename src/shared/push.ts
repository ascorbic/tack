import type { OperationKind, PushAs } from "./changes.ts";

// The push API: request and response shapes shared by the server's routes
// and the client. Change statuses themselves travel in the board document
// (src/shared/changes.ts), so the client watches those rather than polling.
//
// POST /api/boards/:id/push                      PushRequest → PushResponse
// GET  /api/boards/:id/pushes                    → AuditEntry[] (newest first)
// GET  /api/repos/meta?repo=github.com/o/r       → RepoMeta
// GET  /api/repos/files?repo=github.com/o/r&path=docs/decisions → string[]
// POST /api/boards/:id/snapshots   (image/png body)  → { url: string }
// GET  /snapshots/:id.png          public, unguessable id

export interface PushRequest {
	/** Staged change ids. Their pending dependencies must be included too. */
	ids: string[];
	as: PushAs;
}

export type PushResponse =
	| { ok: true; pushId: string }
	| {
			ok: false;
			reason:
				| "signed_out"
				/** Can stage but not push: no write access to these repositories. */
				| "no_write_access"
				/** The app isn't installed on these repositories. */
				| "not_installed"
				/** A change depends on a pending create that isn't in the push. */
				| "missing_dependency"
				| "busy";
			repos?: string[];
			message: string;
	  };

export interface Label {
	name: string;
	color: string;
	description?: string;
}

export interface Milestone {
	title: string;
	dueOn?: string | null;
}

export interface RepoMeta {
	repo: string;
	labels: Label[];
	milestones: Milestone[];
	/** Logins that can be assigned. */
	assignees: string[];
	/** Discussion categories, empty if discussions are off. */
	discussionCategories: string[];
	/** People watching the repository: who'll get notified by writes. */
	watchers: number;
	defaultBranch: string;
	/** Whether the app can write here (it's installed with the needed permissions). */
	writable: boolean;
	/**
	 * The writes the repository's forge supports (its adapter's
	 * `capabilities.writes`), so the UI only offers those. Absent means unknown.
	 */
	writes?: OperationKind[];
}

/** One push, for the board's audit log. */
export interface AuditEntry {
	pushId: string;
	at: string;
	by: { login: string; name: string | null };
	as: PushAs;
	changes: {
		id: string;
		summary: string;
		status: "applied" | "sent" | "failed";
		url?: string;
		error?: string;
		/** What the forge itself said, when that's different from `error`. */
		detail?: string;
	}[];
}
