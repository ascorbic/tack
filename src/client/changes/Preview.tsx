import { useEffect, useRef, useState } from "react";
import type { IssueEdit } from "../../shared/actions.ts";
import type { PendingChange, PushAs, Target } from "../../shared/changes.ts";
import type { RepoMeta } from "../../shared/push.ts";
import { IssueExtrasPicker } from "../actions/IssuePanels.tsx";
import { SUBMIT_HINT } from "../actions/Popover.tsx";
import type { User } from "../presence.ts";
import { labelColor } from "./api.ts";
import { type ChangeIndex, changeRepo, isPending } from "./describe.ts";
import { BotIcon, BranchIcon, ChevronIcon, FileIcon, KindIcon } from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { LabelChip, StagerAvatar, TargetRef } from "./parts.tsx";

// A preview of exactly what a change will write, drawn the way GitHub will
// show it: the new issue's title, body and labels in their colours, the
// comment as it'll read, the files in a pull request.

export interface PreviewProps {
	change: PendingChange;
	index: ChangeIndex;
	meta: (repo: string) => RepoMeta | undefined;
	/** Who it'll be written as, for comments and new threads. */
	as: PushAs;
	user: User;
	/**
	 * Correct a new issue in review: its title, description, labels,
	 * milestone and assignees. Absent where it can't be changed.
	 */
	onEdit?: (edit: IssueEdit) => boolean;
}

export function ChangePreview({ change, index, meta, as, user, onEdit }: PreviewProps) {
	const { op } = change;
	const repo = changeRepo(change, index) ?? "";
	const info = meta(repo);
	const color = (name: string) => labelColor(info, name);
	switch (op.kind) {
		case "issue.create":
			return onEdit && isPending(change) ? (
				<EditableIssue change={change} repo={repo} meta={info} onEdit={onEdit} />
			) : (
				<div className="preview preview-thread" data-compact={!op.body || undefined}>
					<div className="preview-thread-title">
						<KindIcon op={op} size={15} />
						<span>{op.title}</span>
					</div>
					{op.body && <Body source={op.body} />}
					<IssueFacts change={change} color={color} />
				</div>
			);
		case "discussion.create":
			return (
				<div className="preview preview-thread">
					<span className="preview-fact preview-category">{op.category}</span>
					<div className="preview-thread-title">
						<KindIcon op={op} size={15} />
						<span>{op.title}</span>
					</div>
					<Body source={op.body} />
				</div>
			);
		case "pr.create":
			return <PullPreview change={change} />;
		case "item.comment":
			return (
				<div className="preview">
					<Target target={op.target} index={index} />
					<div className="preview-comment">
						<span className="preview-comment-author">
							{as === "app" ? (
								<span className="preview-bot" aria-hidden="true">
									<BotIcon size={12} />
								</span>
							) : (
								<StagerAvatar
									stager={{ name: user.name, color: user.color }}
									avatarUrl={user.avatarUrl}
									size={18}
								/>
							)}
							<strong>{as === "app" ? "Tack (bot)" : (user.login ?? user.name)}</strong>
							{as === "user" && <span className="preview-via">via Tack</span>}
						</span>
						<Body source={op.body} />
					</div>
				</div>
			);
		case "item.labels":
			return (
				<div className="preview preview-inline">
					<Target target={op.target} index={index} />
					<div className="preview-facts">
						{op.add?.map((name) => (
							<LabelChip key={`+${name}`} name={name} color={color(name)} mode="add" />
						))}
						{op.remove?.map((name) => (
							<LabelChip key={`-${name}`} name={name} color={color(name)} mode="remove" />
						))}
					</div>
				</div>
			);
		case "item.assignees":
			return (
				<div className="preview preview-inline">
					<Target target={op.target} index={index} />
					<div className="preview-facts">
						{op.add?.map((login) => (
							<span key={`+${login}`} className="preview-fact" data-mode="add">
								+ @{login}
							</span>
						))}
						{op.remove?.map((login) => (
							<span key={`-${login}`} className="preview-fact" data-mode="remove">
								− @{login}
							</span>
						))}
					</div>
				</div>
			);
		case "item.milestone":
			return (
				<div className="preview preview-inline">
					<Target target={op.target} index={index} />
					<div className="preview-facts">
						{op.milestone ? (
							<Milestone title={op.milestone} />
						) : (
							<span className="preview-fact" data-mode="remove">
								No milestone
							</span>
						)}
					</div>
				</div>
			);
		case "item.state":
			return (
				<div className="preview preview-inline">
					<Target target={op.target} index={index} />
					<div className="preview-facts">
						<span className="preview-state" data-state={op.state} data-reason={op.reason}>
							<KindIcon op={op} size={13} />
							{op.state === "open"
								? "Reopened"
								: op.reason === "not_planned"
									? "Closed as not planned"
									: op.reason === "duplicate"
										? "Closed as a duplicate"
										: "Closed as completed"}
						</span>
					</div>
				</div>
			);
		case "item.subIssue":
			return (
				<div className="preview preview-link">
					<Target target={op.child} index={index} />
					<span className="preview-link-verb">becomes a sub-issue of</span>
					<Target target={op.parent} index={index} />
				</div>
			);
		case "item.blockedBy":
			return (
				<div className="preview preview-link">
					<Target target={op.target} index={index} />
					<span className="preview-link-verb">is blocked by</span>
					<Target target={op.blockedBy} index={index} />
				</div>
			);
	}
}

/** A new issue's labels, assignees and milestone, as GitHub will show them. */
function IssueFacts({ change, color }: { change: PendingChange; color: (name: string) => string }) {
	const { op } = change;
	if (op.kind !== "issue.create") return null;
	if (!op.labels?.length && !op.assignees?.length && !op.milestone) return null;
	return (
		<div className="preview-facts">
			{op.labels?.map((name) => (
				<LabelChip key={name} name={name} color={color(name)} />
			))}
			{op.assignees?.map((login) => (
				<span key={login} className="preview-fact">
					@{login}
				</span>
			))}
			{op.milestone && <Milestone title={op.milestone} />}
		</div>
	);
}

type Editing = "title" | "body" | "extras" | null;

/**
 * A new issue in review that can still be corrected: click its title to
 * reword it, its description to write one, and its labels, milestone and
 * assignees to change them. Words made from a sticky are written back to
 * the sticky. Enter (or ⌘↵ in the description) saves, Escape doesn't.
 */
function EditableIssue({
	change,
	repo,
	meta,
	onEdit,
}: {
	change: PendingChange;
	repo: string;
	meta: RepoMeta | undefined;
	onEdit: (edit: IssueEdit) => boolean;
}) {
	const [editing, setEditing] = useState<Editing>(null);
	if (change.op.kind !== "issue.create") return null;
	const { op } = change;
	const color = (name: string) => labelColor(meta, name);
	const fromSticky = change.effect?.kind === "replace";
	const writesBack = fromSticky ? " (and its sticky)" : "";
	return (
		<div
			className="preview preview-thread preview-editable"
			data-compact={(!op.body && editing !== "body") || undefined}
			data-editing={editing ?? undefined}
		>
			{editing === "title" ? (
				<TextEdit
					key="title"
					label="Title"
					initial={op.title}
					onSave={(title) => onEdit({ title })}
					onDone={() => setEditing(null)}
				/>
			) : (
				<button
					type="button"
					className="preview-thread-title preview-edit-target"
					title={`Edit the title${writesBack}`}
					onClick={() => setEditing("title")}
				>
					<KindIcon op={op} size={15} />
					<span>{op.title}</span>
					<EditGlyph />
				</button>
			)}
			{editing === "body" ? (
				<TextEdit
					key="body"
					label="Description"
					initial={op.body ?? ""}
					multiline
					onSave={(body) => onEdit({ body })}
					onDone={() => setEditing(null)}
				/>
			) : op.body ? (
				<div className="preview-edit-body">
					<Body source={op.body} />
					<button
						type="button"
						className="preview-edit-link"
						title={`Edit the description${writesBack}`}
						onClick={() => setEditing("body")}
					>
						Edit description
					</button>
				</div>
			) : null}
			<div className="preview-edit-row">
				{!op.body && editing !== "body" && (
					<button type="button" className="preview-edit-link" onClick={() => setEditing("body")}>
						Add a description
					</button>
				)}
				{editing !== "extras" && meta && (
					<button
						type="button"
						className="preview-edit-facts"
						title="Change labels, milestone and assignees"
						onClick={() => setEditing("extras")}
					>
						<IssueFacts change={change} color={color} />
						<span className="preview-edit-link">
							{op.labels?.length || op.milestone || op.assignees?.length
								? "Change"
								: "Labels, milestone, assignees"}
						</span>
					</button>
				)}
				{!meta && <IssueFacts change={change} color={color} />}
			</div>
			{editing === "extras" && meta && (
				<div className="preview-edit-extras">
					<IssueExtrasPicker
						repo={repo}
						meta={meta}
						value={{ labels: op.labels, milestone: op.milestone, assignees: op.assignees }}
						onChange={(value) => onEdit(value)}
					/>
					<button type="button" className="preview-edit-done" onClick={() => setEditing(null)}>
						Done
					</button>
				</div>
			)}
		</div>
	);
}

function EditGlyph() {
	return (
		<svg
			className="icon preview-edit-glyph"
			width="13"
			height="13"
			viewBox="0 0 16 16"
			aria-hidden="true"
		>
			<path d="M10.5 2.5l3 3L6 13H3v-3z" />
		</svg>
	);
}

/** A title or description being corrected in place. */
function TextEdit({
	label,
	initial,
	multiline = false,
	onSave,
	onDone,
}: {
	label: string;
	initial: string;
	multiline?: boolean;
	onSave: (value: string) => boolean;
	onDone: () => void;
}) {
	const [value, setValue] = useState(initial);
	const [invalid, setInvalid] = useState(false);
	const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);
	const save = () => {
		if (value === initial) return onDone();
		if (onSave(value)) onDone();
		else setInvalid(true);
	};
	const props = {
		ref: field,
		className: "preview-edit-field",
		"aria-label": label,
		"aria-invalid": invalid || undefined,
		value,
		onChange: (event: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => {
			setValue(event.target.value);
			setInvalid(false);
		},
		onBlur: save,
		onKeyDown: (event: React.KeyboardEvent) => {
			// The sheet's own ⌘↵ pushes: here it saves.
			event.stopPropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				onDone();
			} else if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				save();
			}
		},
	};
	return multiline ? (
		<div className="preview-edit-area">
			<textarea {...props} rows={Math.min(10, Math.max(3, value.split("\n").length + 1))} />
			<span className="preview-edit-hint">{SUBMIT_HINT} to save · Esc to cancel</span>
		</div>
	) : (
		<input {...props} />
	);
}

function Target({ target, index }: { target: Target; index: ChangeIndex }) {
	return <TargetRef target={target} index={index} />;
}

function Milestone({ title }: { title: string }) {
	return (
		<span className="preview-fact preview-milestone">
			<svg className="icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
				<path d="M8 1.75v12.5" />
				<path d="M3.5 4h7.6l1.9 2-1.9 2H3.5z" />
			</svg>
			{title}
		</span>
	);
}

/** A Markdown body, folded when it's long. */
function Body({ source }: { source: string }) {
	const long = source.length > 420 || source.split("\n").length > 10;
	const [open, setOpen] = useState(false);
	return (
		<div className="preview-body" data-folded={long && !open ? true : undefined}>
			<Markdown source={source} />
			{long && (
				<button type="button" className="preview-more" onClick={() => setOpen(!open)}>
					{open ? "Show less" : "Show all"}
				</button>
			)}
		</div>
	);
}

function PullPreview({ change }: { change: PendingChange }) {
	const [openFile, setOpenFile] = useState<string | null>(null);
	if (change.op.kind !== "pr.create") return null;
	const { op } = change;
	return (
		<div className="preview preview-thread">
			<div className="preview-thread-title">
				<KindIcon op={op} size={15} />
				<span>{op.title}</span>
			</div>
			<span className="preview-branch">
				<BranchIcon size={12} />
				<span className="mono">{op.branch}</span>
				<span aria-hidden="true">→</span>
				<span className="mono">{op.base ?? "default branch"}</span>
			</span>
			{op.body && <Body source={op.body} />}
			<ul className="preview-files" aria-label="Files">
				{op.files.map((file) => {
					const lines = file.content.split("\n").length;
					const open = openFile === file.path;
					return (
						<li key={file.path} data-open={open || undefined}>
							<button
								type="button"
								aria-expanded={open}
								onClick={() => setOpenFile(open ? null : file.path)}
							>
								<ChevronIcon />
								<FileIcon size={13} />
								<span className="mono preview-file-path">{file.path}</span>
								<span className="preview-file-lines">+{lines}</span>
							</button>
							{open && (
								<pre className="preview-file-content">
									<code>{file.content}</code>
								</pre>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
