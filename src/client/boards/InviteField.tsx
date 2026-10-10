import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type {
	BoardMember,
	MemberRole,
	PeopleSuggestions,
	PersonLookup,
} from "../../shared/boards.ts";
import { personColor, personUser } from "../auth/me.ts";
import { Avatar } from "../People.tsx";
import type { ApiResult } from "./api.ts";
import {
	completeInvite,
	describeInvitee,
	finishedLogins,
	loginHash,
	notOnGitHub,
	parseInvite,
	quoted,
	refused,
} from "./invites.ts";

/** How long typing pauses before a login is looked up, or suggestions fetched. */
const LOOKUP_MS = 300;
const SUGGEST_MS = 120;

/**
 * Who to invite, by GitHub username: people on this Tack are suggested as
 * you type, and each finished username is looked up (on this Tack, then on
 * GitHub) and previewed with their picture and name, so a typo shows up
 * red before it's sent rather than sitting in the list for ever.
 */
export function InviteField({
	members,
	lookup,
	suggest,
	onInvite,
	onError,
}: {
	members: BoardMember[];
	lookup?: (login: string) => Promise<ApiResult<PersonLookup>>;
	suggest?: (q: string) => Promise<ApiResult<PeopleSuggestions>>;
	onInvite: (logins: string[], role: MemberRole) => Promise<boolean>;
	onError: (message: string | null) => void;
}) {
	const [value, setValue] = useState("");
	const [role, setRole] = useState<MemberRole>("editor");
	const [busy, setBusy] = useState(false);
	const [lookups, setLookups] = useState<Map<string, PersonLookup | "checking">>(new Map());
	const asked = useRef(new Map<string, Promise<PersonLookup | null>>());
	const [suggestions, setSuggestions] = useState<PersonLookup[]>([]);
	const [active, setActive] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const id = useId();
	const listId = `${id}-suggestions`;

	const parsed = parseInvite(value);
	const finished = finishedLogins(parsed);
	const memberOf = new Map(members.map((member) => [member.login, member]));

	const ask = (login: string): Promise<PersonLookup | null> => {
		const key = login.toLowerCase();
		const known = asked.current.get(key);
		if (known) return known;
		if (!lookup) return Promise.resolve(null);
		setLookups((current) => new Map(current).set(key, "checking"));
		const promise = lookup(key).then((result) => {
			const answer = result.ok ? result.value : null;
			setLookups((current) => {
				const next = new Map(current);
				if (answer) next.set(key, answer);
				else next.delete(key);
				return next;
			});
			// Couldn't reach Tack: ask again next time rather than remember that.
			if (!answer) asked.current.delete(key);
			return answer;
		});
		asked.current.set(key, promise);
		return promise;
	};

	// Look finished logins up once typing pauses.
	const finishedKey = finished.join(" ").toLowerCase();
	useEffect(() => {
		if (!lookup || !finishedKey) return;
		const timer = setTimeout(() => {
			for (const login of finishedKey.split(" ")) {
				if (!memberOf.has(login)) void ask(login);
			}
		}, LOOKUP_MS);
		return () => clearTimeout(timer);
		// `ask` and `memberOf` are rebuilt each render; the logins are what matter.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [finishedKey, lookup]);

	// Suggest people on this Tack for the login being typed.
	const current = parsed.current;
	useEffect(() => {
		if (!suggest || !current) {
			setSuggestions([]);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void suggest(current).then((result) => {
				if (cancelled || !result.ok) return;
				const typed = new Set(parsed.logins.map((login) => login.toLowerCase()));
				typed.delete(current.toLowerCase());
				setSuggestions(
					result.value.people
						.filter((person) => !memberOf.has(person.login) && !typed.has(person.login))
						.slice(0, 5),
				);
				setActive(0);
			});
		}, SUGGEST_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
		// Suggestions follow the login being typed; the rest is read as it is then.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [current, suggest]);

	const open =
		suggestions.length > 0 &&
		current !== null &&
		dismissed !== current &&
		// Nothing to suggest once it's typed out in full.
		!(suggestions.length === 1 && suggestions[0]?.login === current.toLowerCase());

	const pick = (person: PersonLookup) => {
		setValue(completeInvite(value, person.person?.login ?? person.login));
		const key = person.login.toLowerCase();
		asked.current.set(key, Promise.resolve(person));
		setLookups((current) => new Map(current).set(key, person));
		setSuggestions([]);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const { logins, invalid } = parseInvite(value);
		if (invalid.length > 0) {
			onError(
				`${quoted(invalid)} ${invalid.length === 1 ? "isn’t a GitHub username" : "aren’t GitHub usernames"}.`,
			);
			return;
		}
		if (logins.length === 0) return;
		setBusy(true);
		setSuggestions([]);
		const answers = await Promise.all(
			logins.map((login) =>
				memberOf.has(login.toLowerCase()) ? Promise.resolve(null) : ask(login),
			),
		);
		const bad = refused(answers);
		if (bad.length > 0) {
			onError(notOnGitHub(bad));
			setBusy(false);
			return;
		}
		if (await onInvite(logins, role)) {
			setValue("");
			setLookups(new Map());
		}
		setBusy(false);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (!open) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((index) => (index + step + suggestions.length) % suggestions.length);
		} else if (event.key === "Enter" || event.key === "Tab") {
			const person = suggestions[active];
			if (!person) return;
			event.preventDefault();
			pick(person);
		} else if (event.key === "Escape") {
			// Close the suggestions, not the dialog.
			event.preventDefault();
			event.stopPropagation();
			setDismissed(current);
		}
	};

	const previewed = finished.filter((login) => lookup || memberOf.has(login.toLowerCase()));

	return (
		<form className="share-invite" onSubmit={(event) => void submit(event)}>
			<div className="share-invite-row">
				<label htmlFor={id} className="visually-hidden">
					GitHub usernames to invite
				</label>
				<span className="share-invite-field">
					<span className="share-invite-at" aria-hidden="true">
						@
					</span>
					<input
						id={id}
						role="combobox"
						aria-autocomplete="list"
						aria-expanded={open}
						aria-controls={open ? listId : undefined}
						aria-activedescendant={open ? `${listId}-${active}` : undefined}
						data-autofocus=""
						value={value}
						placeholder="GitHub username, or several"
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => {
							setValue(event.target.value);
							setDismissed(null);
							onError(null);
						}}
						onKeyDown={onKeyDown}
						onBlur={() => setDismissed(current)}
					/>
					<span className="share-select">
						<select
							aria-label="Invite as"
							value={role}
							onChange={(event) => setRole(event.target.value as MemberRole)}
						>
							<option value="editor">Can edit</option>
							<option value="viewer">Can view</option>
						</select>
						<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
							<path d="M2.5 4l2.5 2.5L7.5 4" />
						</svg>
					</span>
				</span>
				<button type="submit" className="primary" disabled={busy || !value.trim()}>
					{busy ? "Inviting…" : "Invite"}
				</button>
				{open && (
					<ul
						className="invite-suggestions"
						id={listId}
						role="listbox"
						aria-label="People on this Tack"
					>
						{suggestions.map((person, index) => (
							<li
								key={person.login}
								id={`${listId}-${index}`}
								role="option"
								aria-selected={index === active}
								onPointerDown={(event) => {
									// Keep focus in the field.
									event.preventDefault();
									pick(person);
								}}
								onPointerEnter={() => setActive(index)}
							>
								<InviteeAvatar login={person.login} person={person.person} />
								<span className="invite-who">
									<strong>{person.person?.name || person.login}</strong>
									<span className="share-login">@{person.person?.login ?? person.login}</span>
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
			{previewed.length > 0 && (
				<ul className="invite-preview" aria-label="Who you’re inviting">
					{previewed.map((login) => {
						const key = login.toLowerCase();
						const answer = lookups.get(key);
						const member = memberOf.get(key);
						const { note, tone } = describeInvitee(login, answer, member);
						const person =
							member?.person ?? (answer && answer !== "checking" ? answer.person : null);
						return (
							<li key={key} data-tone={tone} data-checking={answer === "checking" || undefined}>
								<InviteeAvatar login={key} person={person} />
								<span className="invite-who">
									<strong>{person?.name || person?.login || login}</strong>
									<span className="invite-note">{note}</span>
								</span>
								{tone === "bad" && (
									<svg
										className="invite-flag"
										width="14"
										height="14"
										viewBox="0 0 16 16"
										aria-hidden="true"
									>
										<circle cx="8" cy="8" r="6.25" />
										<path d="M8 4.75v3.75M8 11.1v.15" />
									</svg>
								)}
								{tone === "ok" && (
									<svg
										className="invite-flag"
										width="14"
										height="14"
										viewBox="0 0 16 16"
										aria-hidden="true"
									>
										<path d="M3.5 8.5l3 3 6-7" />
									</svg>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</form>
	);
}

function InviteeAvatar({ login, person }: { login: string; person: PersonLookup["person"] }) {
	return (
		<Avatar
			user={person ? personUser(person) : { name: login, color: personColor(loginHash(login)) }}
		/>
	);
}
