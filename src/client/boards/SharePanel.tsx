import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Person } from "../../shared/auth.ts";
import type {
	BoardInfo,
	BoardMember,
	BoardMembers,
	MemberRole,
	Role,
	UpdateBoardRequest,
	Visibility,
} from "../../shared/boards.ts";
import { personColor, personUser } from "../auth/me.ts";
import { Avatar } from "../People.tsx";
import type { ApiResult } from "./api.ts";
import { VisibilityIcon } from "./icons.tsx";

/** What sharing does, so the gallery can fake it. */
export interface ShareActions {
	members: () => Promise<ApiResult<BoardMembers>>;
	invite: (logins: string[], role: MemberRole) => Promise<ApiResult<BoardMembers>>;
	setRole: (login: string, role: Role) => Promise<ApiResult<BoardMembers>>;
	remove: (login: string) => Promise<ApiResult<BoardMembers>>;
	update: (request: UpdateBoardRequest) => Promise<ApiResult<BoardInfo>>;
	/** The link to copy. */
	link: string;
}

const LOGIN = /^@?[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

const VISIBILITY: Record<Visibility, { label: string; describe: (role: MemberRole) => string }> = {
	private: {
		label: "Only people invited",
		describe: () => "Only the people above can open this board.",
	},
	instance: {
		label: "Anyone on this Tack",
		describe: (role) => `Everyone who can sign in here ${can(role)}.`,
	},
	public: {
		label: "Anyone with the link",
		describe: (role) =>
			`Anyone with the link can view, no sign-in needed. People on this Tack ${can(role)}.`,
	},
};

const can = (role: MemberRole) => (role === "editor" ? "can edit" : "can view");

const ERRORS: Record<string, string> = {
	invalid_login: "That doesn’t look like a GitHub username.",
	owner_required: "Only the board’s owner can do that.",
	forbidden: "You can’t change sharing on this board.",
	offline: "Couldn’t reach Tack. Check your connection and try again.",
};

/**
 * Sharing a board, FigJam-style: invite people by GitHub username, set
 * what each person can do, choose who else can open it, and copy the link.
 * People who can't manage the board see who's on it, and can copy the link
 * or leave.
 */
export function SharePanel({
	board,
	me,
	actions,
	onBoard,
	onClose,
	onLeft,
	headingId,
}: {
	board: BoardInfo;
	me: Person | null;
	actions: ShareActions;
	/** The board changed (visibility, or ownership). */
	onBoard: (board: BoardInfo) => void;
	onClose?: () => void;
	/** You left the board. */
	onLeft?: () => void;
	headingId?: string;
}) {
	const [members, setMembers] = useState<BoardMember[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [fresh, setFresh] = useState<Set<string>>(new Set());

	useEffect(() => {
		let cancelled = false;
		void actions.members().then((result) => {
			if (cancelled) return;
			if (result.ok) setMembers(result.value.members);
			else setError(ERRORS[result.error] ?? "Couldn’t load who’s on this board.");
		});
		return () => {
			cancelled = true;
		};
	}, [actions]);

	const apply = (result: ApiResult<BoardMembers>): boolean => {
		if (!result.ok) {
			setError(
				result.error === "invalid_login" && result.logins?.length
					? `“${result.logins.join("”, “")}” ${result.logins.length === 1 ? "isn’t a" : "aren’t"} GitHub username${result.logins.length === 1 ? "" : "s"}.`
					: (ERRORS[result.error] ?? "Something went wrong. Please try again."),
			);
			return false;
		}
		setError(null);
		setMembers(result.value.members);
		return true;
	};

	const invite = async (logins: string[], role: MemberRole) => {
		const known = new Set(members?.map((member) => member.login));
		const ok = apply(await actions.invite(logins, role));
		if (ok) {
			const added = logins.map((login) => login.replace(/^@/, "").toLowerCase());
			setFresh(new Set(added.filter((login) => !known.has(login))));
		}
		return ok;
	};

	const setRole = async (member: BoardMember, value: string) => {
		if (value === "remove") {
			apply(await actions.remove(member.login));
			return;
		}
		const ok = apply(await actions.setRole(member.login, value as Role));
		// Handing over ownership changes what you can do here.
		if (ok && value === "owner") {
			const refreshed = await actions.update({});
			if (refreshed.ok) onBoard(refreshed.value);
		}
	};

	const update = async (request: UpdateBoardRequest) => {
		const result = await actions.update(request);
		if (result.ok) {
			setError(null);
			onBoard(result.value);
		} else {
			setError(ERRORS[result.error] ?? "Couldn’t change that. Please try again.");
		}
	};

	const leave = async () => {
		const self = members?.find((member) => member.person?.id === me?.id);
		if (!self) return;
		if (apply(await actions.remove(self.login))) onLeft?.();
	};

	const isOwner = board.owner !== null && board.owner.id === me?.id;
	const amMember = members?.some((member) => member.person?.id === me?.id) ?? false;

	return (
		<div className="share" data-managing={board.canManage}>
			<header className="share-head">
				<h2 id={headingId}>
					Share <span className="share-title">“{board.title}”</span>
				</h2>
				{onClose && (
					<button type="button" className="share-close" aria-label="Close" onClick={onClose}>
						<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
							<path d="M3 3l8 8M11 3l-8 8" />
						</svg>
					</button>
				)}
			</header>

			{board.canManage && <InviteForm onInvite={invite} onInvalid={setError} />}

			{error && (
				<p className="share-error" role="alert">
					{error}
				</p>
			)}

			<ul className="share-members" aria-label="People with access" aria-busy={members === null}>
				{members === null
					? [0, 1].map((i) => <li key={i} className="share-member share-member-skeleton" />)
					: members.map((member) => (
							<MemberRow
								key={member.login}
								member={member}
								you={member.person !== null && member.person.id === me?.id}
								fresh={fresh.has(member.login)}
								manage={board.canManage && member.role !== "owner"}
								canTransfer={isOwner && member.person !== null}
								onRole={(value) => void setRole(member, value)}
							/>
						))}
			</ul>

			<section className="share-access" aria-label="General access">
				<h3>General access</h3>
				<div className="share-access-row">
					<span className="share-access-icon" data-visibility={board.visibility}>
						<VisibilityIcon visibility={board.visibility} />
					</span>
					<div className="share-access-text">
						{board.canManage ? (
							<Select
								label="Who can open this board"
								value={board.visibility}
								onChange={(value) => void update({ visibility: value as Visibility })}
								options={(Object.keys(VISIBILITY) as Visibility[]).map((value) => ({
									value,
									label: VISIBILITY[value].label,
								}))}
								strong
							/>
						) : (
							<strong>{VISIBILITY[board.visibility].label}</strong>
						)}
						<span className="share-access-describe">
							{VISIBILITY[board.visibility].describe(board.instanceRole)}
						</span>
					</div>
					{board.visibility !== "private" &&
						(board.canManage ? (
							<Select
								label="What people on this Tack can do"
								value={board.instanceRole}
								onChange={(value) => void update({ instanceRole: value as MemberRole })}
								options={[
									{ value: "editor", label: "Can edit" },
									{ value: "viewer", label: "Can view" },
								]}
							/>
						) : (
							<span className="share-role-label">
								{board.instanceRole === "editor" ? "Can edit" : "Can view"}
							</span>
						))}
				</div>
			</section>

			<footer className="share-foot">
				{amMember && !isOwner && (
					<button type="button" className="share-leave" onClick={() => void leave()}>
						Leave board
					</button>
				)}
				<CopyLink link={actions.link} />
			</footer>
		</div>
	);
}

function InviteForm({
	onInvite,
	onInvalid,
}: {
	onInvite: (logins: string[], role: MemberRole) => Promise<boolean>;
	onInvalid: (message: string) => void;
}) {
	const [value, setValue] = useState("");
	const [role, setRole] = useState<MemberRole>("editor");
	const [busy, setBusy] = useState(false);
	const id = useId();

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const logins = value
			.split(/[\s,]+/)
			.map((login) => login.trim())
			.filter(Boolean);
		if (logins.length === 0) return;
		const invalid = logins.filter((login) => !LOGIN.test(login));
		if (invalid.length > 0) {
			onInvalid(
				`“${invalid.join("”, “")}” ${invalid.length === 1 ? "isn’t a GitHub username" : "aren’t GitHub usernames"}.`,
			);
			return;
		}
		setBusy(true);
		if (await onInvite(logins, role)) setValue("");
		setBusy(false);
	};

	return (
		<form className="share-invite" onSubmit={(event) => void submit(event)}>
			<label htmlFor={id} className="visually-hidden">
				GitHub usernames to invite
			</label>
			<span className="share-invite-field">
				<span className="share-invite-at" aria-hidden="true">
					@
				</span>
				<input
					id={id}
					value={value}
					placeholder="GitHub username, or several"
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => setValue(event.target.value)}
				/>
				<Select
					label="Invite as"
					value={role}
					onChange={(next) => setRole(next as MemberRole)}
					options={[
						{ value: "editor", label: "Can edit" },
						{ value: "viewer", label: "Can view" },
					]}
				/>
			</span>
			<button type="submit" className="primary" disabled={busy || !value.trim()}>
				{busy ? "Inviting…" : "Invite"}
			</button>
		</form>
	);
}

function MemberRow({
	member,
	you,
	fresh,
	manage,
	canTransfer,
	onRole,
}: {
	member: BoardMember;
	you: boolean;
	fresh: boolean;
	manage: boolean;
	canTransfer: boolean;
	onRole: (value: string) => void;
}) {
	const person = member.person;
	const user = person
		? personUser(person)
		: { name: member.login, color: personColor(loginHash(member.login)) };
	const roleLabel =
		member.role === "owner" ? "Owner" : member.role === "editor" ? "Can edit" : "Can view";
	return (
		<li
			className="share-member"
			data-fresh={fresh || undefined}
			data-pending={!person || undefined}
		>
			<Avatar user={user} />
			<span className="share-member-who">
				<strong>
					{person?.name || person?.login || member.login}
					{you && <span className="share-you"> (you)</span>}
				</strong>
				<span className="share-member-sub">
					{person ? `@${person.login}` : `@${member.login} · invited, hasn’t signed in yet`}
				</span>
			</span>
			{manage ? (
				<Select
					label={`What ${person?.login ?? member.login} can do`}
					value={member.role}
					onChange={onRole}
					options={[
						{ value: "editor", label: "Can edit" },
						{ value: "viewer", label: "Can view" },
						...(canTransfer ? [{ value: "owner", label: "Make owner" }] : []),
						{ value: "remove", label: "Remove", danger: true },
					]}
				/>
			) : (
				<span className="share-role-label">{roleLabel}</span>
			)}
		</li>
	);
}

/** A quiet select that reads as text until you open it. */
function Select({
	label,
	value,
	options,
	onChange,
	strong = false,
}: {
	label: string;
	value: string;
	options: { value: string; label: string; danger?: boolean }[];
	onChange: (value: string) => void;
	strong?: boolean;
}) {
	return (
		<span className="share-select" data-strong={strong || undefined}>
			<select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
			<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
				<path d="M2.5 4l2.5 2.5L7.5 4" />
			</svg>
		</span>
	);
}

function CopyLink({ link }: { link: string }): ReactNode {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(link);
		} catch {
			// Clipboard blocked (e.g. an insecure origin): select the link instead.
			window.prompt("Copy this link", link);
			return;
		}
		setCopied(true);
		clearTimeout(timer.current);
		// Long enough to read, whatever the motion setting.
		timer.current = setTimeout(() => setCopied(false), 1800);
	};

	return (
		<button
			type="button"
			className="share-copy"
			data-copied={copied || undefined}
			onClick={() => void copy()}
		>
			<span className="share-copy-icon" aria-hidden="true">
				{copied ? (
					<svg width="16" height="16" viewBox="0 0 16 16">
						<path d="M3.5 8.5l3 3 6-7" />
					</svg>
				) : (
					<svg width="16" height="16" viewBox="0 0 16 16">
						<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.4-2.4a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.1 9.2a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
					</svg>
				)}
			</span>
			<span aria-live="polite">{copied ? "Link copied" : "Copy link"}</span>
		</button>
	);
}

function loginHash(login: string): number {
	let hash = 0;
	for (const char of login) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
	return hash;
}
