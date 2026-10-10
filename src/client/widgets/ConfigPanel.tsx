import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type * as v from "valibot";
import { parseSearch } from "../../shared/search.ts";
import {
	LIST_PRESETS,
	LIST_SORTS,
	type ListConfig,
	type ListSort,
} from "../../shared/widgetRegistry.ts";
import { describeSearch, dropNote, queryChips, refreshNote } from "./describe.ts";
import { CheckIcon, DropIcon, RefreshIcon, WarnIcon } from "./icons.tsx";

// Configuring widgets: a panel written for the list (the search, with live
// feedback on what it reads and whether cards can be dropped on it), and one
// generated from any kind's Valibot schema for kinds without their own.

const SORT_LABELS: Record<ListSort, string> = {
	updated: "Updated",
	created: "Created",
	comments: "Comments",
	reactions: "Reactions",
};
const LIMITS = [10, 30, 50, 100];
const HOSTS = ["github.com", "fake.tack"];

/** The panel's frame: a floating sheet, like the selection actions' panels. */
export function ConfigSheet({
	label,
	onClose,
	children,
}: {
	label: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		const el = ref.current;
		(el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector("input"))?.focus({
			preventScroll: true,
		});
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (!target || el?.contains(target)) return;
			// The button that opened it toggles it itself.
			if (target.closest("[data-config-toggle]")) return;
			close.current();
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, []);
	return (
		<div
			ref={ref}
			role="dialog"
			aria-label={label}
			className="widget-config nodrag nopan nowheel"
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Escape") {
					event.preventDefault();
					close.current();
				}
			}}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
			onWheel={(event) => event.stopPropagation()}
		>
			{children}
		</div>
	);
}

export function ListConfigPanel({
	config,
	onChange,
	onClose,
	suggestedRepo,
}: {
	config: ListConfig;
	onChange: (changes: Partial<ListConfig>) => void;
	onClose: () => void;
	/** For the ready-made searches: the board's busiest repository (`owner/name`). */
	suggestedRepo?: string | null;
}) {
	const id = useId();
	// The search is committed when you press Enter or leave the field, not on
	// every keystroke: each change runs it again for everyone looking.
	const [draft, setDraft] = useState(config.q);
	useEffect(() => setDraft(config.q), [config.q]);
	const chips = useMemo(() => queryChips(parseSearch(draft)), [draft]);
	const commit = () => {
		if (draft.trim() !== config.q.trim()) onChange({ q: draft.trim() });
	};
	const drop = dropNote(draft);
	const presets = suggestedRepo
		? LIST_PRESETS
		: LIST_PRESETS.filter((preset) => !preset.q("x/y").includes("x/y"));

	return (
		<ConfigSheet label="Edit list" onClose={() => (commit(), onClose())}>
			<header className="widget-config-head">
				<h3>Edit list</h3>
				<p>Any search on {config.host}, kept live for everyone looking.</p>
			</header>
			<label className="widget-field" htmlFor={`${id}-q`}>
				<span className="widget-field-label">Search</span>
				<textarea
					id={`${id}-q`}
					className="mono"
					data-autofocus
					rows={2}
					value={draft}
					spellCheck={false}
					placeholder="repo:owner/name is:open label:bug"
					onChange={(event) => setDraft(event.target.value.replace(/\n/g, " "))}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							commit();
						}
					}}
				/>
			</label>
			{chips.length > 0 ? (
				<div className="widget-config-chips" aria-label="How Tack reads it">
					{chips.map((chip, i) => (
						<span
							key={`${i}:${chip.text}`}
							className="widget-chip mono"
							data-tone={chip.tone}
							data-negated={chip.negated || undefined}
						>
							{chip.text}
						</span>
					))}
				</div>
			) : (
				<div className="widget-config-presets">
					{presets.map((preset) => (
						<button
							key={preset.label}
							type="button"
							className="widget-preset"
							onClick={() => {
								const q = preset.q(suggestedRepo ?? "");
								setDraft(q);
								onChange({ q, title: config.title || preset.title });
							}}
						>
							{preset.label}
						</button>
					))}
				</div>
			)}
			{draft.trim() && (
				<ul className="widget-config-notes">
					<li>
						<RefreshIcon size={14} />
						{refreshNote(draft)}
					</li>
					<li data-tone={drop.ok ? undefined : "warn"}>
						{drop.ok ? <DropIcon size={14} /> : <WarnIcon size={14} />}
						{drop.text}
					</li>
				</ul>
			)}
			<label className="widget-field" htmlFor={`${id}-title`}>
				<span className="widget-field-label">Title</span>
				<input
					id={`${id}-title`}
					value={config.title}
					maxLength={120}
					placeholder={draft.trim() ? describeSearch(draft) : "Named after the search"}
					onChange={(event) => onChange({ title: event.target.value })}
					onKeyDown={(event) => event.key === "Enter" && onClose()}
				/>
			</label>
			<div className="widget-field">
				<span className="widget-field-label">Sort by</span>
				<Segmented
					label="Sort by"
					options={LIST_SORTS.map((sort) => ({ value: sort, label: SORT_LABELS[sort] }))}
					value={config.sort}
					onChange={(sort) => onChange({ sort })}
				/>
			</div>
			<div className="widget-field-row">
				<div className="widget-field">
					<span className="widget-field-label">Show up to</span>
					<Segmented
						label="Show up to"
						options={LIMITS.map((limit) => ({ value: limit, label: String(limit) }))}
						value={config.limit}
						onChange={(limit) => onChange({ limit })}
					/>
				</div>
				<label className="widget-field" htmlFor={`${id}-host`}>
					<span className="widget-field-label">On</span>
					<select
						id={`${id}-host`}
						value={config.host}
						onChange={(event) => onChange({ host: event.target.value })}
					>
						{[...new Set([config.host, ...HOSTS])].map((host) => (
							<option key={host} value={host}>
								{host}
							</option>
						))}
					</select>
				</label>
			</div>
			<footer className="widget-config-foot">
				<button type="button" className="primary" onClick={() => (commit(), onClose())}>
					<CheckIcon size={14} />
					Done
				</button>
			</footer>
		</ConfigSheet>
	);
}

function Segmented<T extends string | number>({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: { value: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
}) {
	return (
		<div className="widget-segmented" role="radiogroup" aria-label={label}>
			{options.map((option) => (
				<button
					key={String(option.value)}
					type="button"
					role="radio"
					aria-checked={option.value === value}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

// --- Generated from a schema -----------------------------------------------------

interface SchemaNode {
	type: string;
	entries?: Record<string, SchemaNode>;
	wrapped?: SchemaNode;
	options?: unknown[];
	pipe?: SchemaNode[];
	requirement?: unknown;
}

/** A field of an object schema, as a form control: strings, numbers, booleans and picklists. */
interface Field {
	key: string;
	kind: "string" | "number" | "boolean" | "picklist";
	options?: string[];
	min?: number;
	max?: number;
}

function unwrap(schema: SchemaNode): SchemaNode {
	let node = schema;
	while (node.wrapped) node = node.wrapped;
	return node;
}

/** The fields a config schema has that a form can edit. Anything else is left alone. */
export function schemaFields(schema: v.GenericSchema<unknown>): Field[] {
	const root = unwrap(schema as unknown as SchemaNode);
	if (root.type !== "object" || !root.entries) return [];
	return Object.entries(root.entries).flatMap(([key, entry]): Field[] => {
		const node = unwrap(entry);
		const actions = node.pipe ?? [];
		const bound = (type: string) =>
			actions.find((action) => action.type === type)?.requirement as number | undefined;
		switch (node.type) {
			case "string":
				return [{ key, kind: "string" }];
			case "number":
				return [{ key, kind: "number", min: bound("min_value"), max: bound("max_value") }];
			case "boolean":
				return [{ key, kind: "boolean" }];
			case "picklist":
				return [{ key, kind: "picklist", options: (node.options ?? []).map(String) }];
			default:
				return [];
		}
	});
}

function labelFor(key: string): string {
	const words = key.replace(/([A-Z])/g, " $1").toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A config form for any kind, generated from its schema. */
export function SchemaConfigPanel({
	title,
	schema,
	config,
	onChange,
	onClose,
}: {
	title: string;
	schema: v.GenericSchema<unknown>;
	config: Record<string, unknown>;
	onChange: (changes: Record<string, unknown>) => void;
	onClose: () => void;
}) {
	const id = useId();
	const fields = schemaFields(schema);
	return (
		<ConfigSheet label={`Edit ${title}`} onClose={onClose}>
			<header className="widget-config-head">
				<h3>Edit {title.toLowerCase()}</h3>
			</header>
			{fields.length === 0 && <p className="widget-config-empty">Nothing to set up.</p>}
			{fields.map((field) => {
				const value = config[field.key];
				const control = `${id}-${field.key}`;
				if (field.kind === "boolean") {
					return (
						<label key={field.key} className="widget-field widget-field-check" htmlFor={control}>
							<input
								id={control}
								type="checkbox"
								checked={value === true}
								onChange={(event) => onChange({ [field.key]: event.target.checked })}
							/>
							<span className="widget-field-label">{labelFor(field.key)}</span>
						</label>
					);
				}
				return (
					<label key={field.key} className="widget-field" htmlFor={control}>
						<span className="widget-field-label">{labelFor(field.key)}</span>
						{field.kind === "picklist" ? (
							<select
								id={control}
								value={typeof value === "string" ? value : ""}
								onChange={(event) => onChange({ [field.key]: event.target.value })}
							>
								{field.options?.map((option) => (
									<option key={option} value={option}>
										{option}
									</option>
								))}
							</select>
						) : (
							<input
								id={control}
								type={field.kind === "number" ? "number" : "text"}
								min={field.min}
								max={field.max}
								value={typeof value === "string" || typeof value === "number" ? value : ""}
								onChange={(event) =>
									onChange({
										[field.key]:
											field.kind === "number" ? Number(event.target.value) : event.target.value,
									})
								}
							/>
						)}
					</label>
				);
			})}
			<footer className="widget-config-foot">
				<button type="button" className="primary" onClick={onClose}>
					<CheckIcon size={14} />
					Done
				</button>
			</footer>
		</ConfigSheet>
	);
}
