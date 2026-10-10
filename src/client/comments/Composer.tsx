import {
	type KeyboardEvent,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type Mentionable, completeMention, mentionAt } from "../../shared/comments.ts";
import { personColor } from "../auth/me.ts";
import { Avatar } from "../People.tsx";
import { SendIcon } from "./icons.tsx";
import { useMentionable } from "./people.ts";

// Writing a comment: a textarea that grows as you type, Enter to send
// (Shift+Enter for a new line), Escape to cancel, and @ to mention someone
// on the board, picked from a list that filters as you type.

const MAX_SUGGESTIONS = 6;

export function Composer({
	placeholder,
	initial = "",
	submitLabel = "Send",
	autoFocus = true,
	disabled = false,
	compact = false,
	onSubmit,
	onCancel,
}: {
	placeholder: string;
	initial?: string;
	submitLabel?: string;
	autoFocus?: boolean;
	disabled?: boolean;
	/** A reply box: one line until you type more. */
	compact?: boolean;
	onSubmit: (body: string) => void;
	onCancel?: () => void;
}) {
	const [text, setText] = useState(initial);
	const [caret, setCaret] = useState(initial.length);
	const [picked, setPicked] = useState(0);
	const [dismissed, setDismissed] = useState<number | null>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const listId = useId();
	const people = useMentionable();

	const mention = mentionAt(text, caret);
	const suggestions = useMemo(() => {
		if (!mention || mention.start === dismissed) return [];
		const query = mention.query.toLowerCase();
		return people
			.filter(
				(person) =>
					person.login.toLowerCase().startsWith(query) ||
					(person.name ?? "")
						.toLowerCase()
						.split(/\s+/)
						.some((word) => word.startsWith(query)),
			)
			.slice(0, MAX_SUGGESTIONS);
	}, [mention, people, dismissed]);
	const showing = suggestions.length > 0;

	useEffect(() => setPicked(0), [mention?.query]);

	useLayoutEffect(() => {
		const element = input.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
	}, [text]);

	useEffect(() => {
		if (!autoFocus) return;
		const element = input.current;
		// After the popover's entrance has started, so focus doesn't scroll the page.
		const frame = requestAnimationFrame(() => {
			element?.focus({ preventScroll: true });
			element?.setSelectionRange(element.value.length, element.value.length);
		});
		return () => cancelAnimationFrame(frame);
	}, [autoFocus]);

	const choose = (person: Mentionable) => {
		const next = completeMention(text, caret, person.login);
		setText(next.text);
		setCaret(next.caret);
		requestAnimationFrame(() => {
			input.current?.focus();
			input.current?.setSelectionRange(next.caret, next.caret);
		});
	};

	const submit = () => {
		if (!text.trim() || disabled) return;
		onSubmit(text);
		setText("");
		setCaret(0);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		event.stopPropagation();
		if (showing) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setPicked((n) => (n + step + suggestions.length) % suggestions.length);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				const person = suggestions[picked];
				if (person) choose(person);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissed(mention?.start ?? null);
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		} else if (event.key === "Escape") {
			event.preventDefault();
			onCancel?.();
		}
	};

	const empty = text.trim().length === 0;
	return (
		<form
			className="comment-composer"
			data-compact={compact || undefined}
			data-empty={empty || undefined}
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<textarea
				ref={input}
				value={text}
				rows={1}
				placeholder={placeholder}
				aria-label={placeholder}
				disabled={disabled}
				role="combobox"
				aria-expanded={showing}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={showing ? `${listId}-${picked}` : undefined}
				onChange={(event) => {
					setText(event.target.value);
					setCaret(event.target.selectionStart);
					setDismissed(null);
				}}
				onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
				onKeyDown={onKeyDown}
				onPointerDown={(event) => event.stopPropagation()}
			/>
			<button
				type="submit"
				className="comment-send"
				disabled={empty || disabled}
				aria-label={submitLabel}
				title={`${submitLabel} (Enter)`}
			>
				<SendIcon size={15} />
			</button>
			{showing && (
				<ul className="comment-mentions" id={listId} role="listbox" aria-label="People to mention">
					{suggestions.map((person, i) => (
						<li
							key={person.id}
							id={`${listId}-${i}`}
							role="option"
							aria-selected={i === picked}
							onPointerDown={(event) => {
								event.preventDefault();
								event.stopPropagation();
								choose(person);
							}}
							onPointerEnter={() => setPicked(i)}
						>
							<Avatar
								user={{
									name: person.name || person.login,
									color: personColor(person.id),
									avatarUrl: person.avatarUrl,
								}}
							/>
							<span className="comment-mention-name">{person.name || person.login}</span>
							<span className="comment-mention-login">@{person.login}</span>
						</li>
					))}
				</ul>
			)}
		</form>
	);
}
