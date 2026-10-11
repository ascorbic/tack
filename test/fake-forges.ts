// Fake GitLab, Forgejo and Tangled servers for tests (#65), with no network.
// Each answers the API calls its adapter makes (src/server/forges/gitlab*.ts,
// forgejo*.ts, tangled.ts), keeps what's written, and records every request
// as `METHOD path?query` in `log`. `forgesFetch` routes by host, so one
// function serves a Worker's `outboundService`, or `fetch` in Node tests.
//
// Responses are made with the `Response` the caller passes (Miniflare's, for
// `outboundService`), else the global one.

type ResponseCtor = typeof Response;

export interface FakeUser {
	id: number;
	username: string;
}

const T0 = "2026-10-01T00:00:00.000Z";

function json(R: ResponseCtor, body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new R(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** A field as text: GitLab takes lists of labels as one comma-separated string. */
function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
	const text = await request.text();
	return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

// --- GitLab ----------------------------------------------------------------

export interface FakeGitLabItem {
	iid: number;
	title: string;
	state?: "opened" | "closed" | "merged";
	labels?: { name: string; color: string }[];
	assignees?: string[];
	author?: string;
	notes?: number;
	upvotes?: number;
	updated_at?: string;
	confidential?: boolean;
	milestone?: string | null;
	// Merge requests.
	draft?: boolean;
	pipeline?: { id: number; status: string; failedJobs?: string[] } | null;
	reviewers?: { username: string; state: string }[];
	detailed_merge_status?: string;
	source_branch?: string;
}

interface FakeProject {
	id: number;
	path: string;
	visibility: "public" | "internal" | "private";
	issues: Map<number, FakeGitLabItem>;
	mrs: Map<number, FakeGitLabItem>;
	notes: { kind: string; iid: number; id: number; body: string; created_at: string }[];
	branches: Set<string>;
	commits: { branch: string; files: string[] }[];
	labels: { name: string; color: string }[];
	milestones: { id: number; title: string }[];
	members: string[];
}

export class FakeGitLab {
	readonly log: string[] = [];
	private projects = new Map<number, FakeProject>();
	private users = new Map<string, FakeUser>();
	private nextNote = 1;
	/** The token the instance is configured with; anything else is anonymous. */
	constructor(
		readonly host: string,
		readonly token = "gl-token",
		private R: ResponseCtor = Response,
	) {
		for (const [id, username] of [
			[11, "ada"],
			[12, "grace"],
			[13, "tack-bot"],
		] as const) {
			this.users.set(username, { id, username });
		}
	}

	addProject(
		id: number,
		path: string,
		visibility: FakeProject["visibility"] = "public",
	): FakeProject {
		const project: FakeProject = {
			id,
			path,
			visibility,
			issues: new Map(),
			mrs: new Map(),
			notes: [],
			branches: new Set(["main"]),
			commits: [],
			labels: [
				{ name: "bug", color: "#d73a4a" },
				{ name: "ux", color: "#a2eeef" },
			],
			milestones: [{ id: 501, title: "v2" }],
			members: ["ada", "grace", "tack-bot"],
		};
		this.projects.set(id, project);
		return project;
	}

	project(id: number): FakeProject {
		const project = this.projects.get(id);
		if (!project) throw new Error(`no project ${id}`);
		return project;
	}

	setIssue(id: number, issue: FakeGitLabItem): void {
		this.project(id).issues.set(issue.iid, { updated_at: T0, ...issue });
	}

	setMergeRequest(id: number, mr: FakeGitLabItem): void {
		this.project(id).mrs.set(mr.iid, { updated_at: T0, ...mr });
	}

	notesOn(id: number, iid: number): string[] {
		return this.project(id)
			.notes.filter((note) => note.iid === iid)
			.map((note) => note.body);
	}

	/** An issue as the API shows it. */
	issueJson(project: FakeProject, item: FakeGitLabItem, kind: "issue" | "mr", details: boolean) {
		const section = kind === "mr" ? "merge_requests" : "issues";
		const milestone = item.milestone
			? (project.milestones.find((m) => m.title === item.milestone) ?? {
					id: 0,
					title: item.milestone,
				})
			: null;
		return {
			id: project.id * 1000 + item.iid,
			iid: item.iid,
			project_id: project.id,
			title: item.title,
			description: "",
			state: item.state ?? "opened",
			web_url: `https://${this.host}/${project.path}/-/${section}/${item.iid}`,
			created_at: T0,
			updated_at: item.updated_at ?? T0,
			closed_at: item.state === "closed" ? item.updated_at : null,
			labels: details ? (item.labels ?? []) : (item.labels ?? []).map((l) => l.name),
			assignees: (item.assignees ?? []).map((username) => ({
				id: this.users.get(username)?.id,
				username,
				avatar_url: `https://${this.host}/avatars/${username}.png`,
			})),
			author: {
				username: item.author ?? "ada",
				avatar_url: `https://${this.host}/avatars/${item.author ?? "ada"}.png`,
			},
			user_notes_count: item.notes ?? 0,
			upvotes: item.upvotes ?? 0,
			downvotes: 0,
			milestone: milestone ? { id: milestone.id, title: milestone.title, due_date: null } : null,
			confidential: item.confidential ?? false,
			...(kind === "mr"
				? {
						draft: item.draft ?? false,
						merged_at: item.state === "merged" ? item.updated_at : null,
						sha: `sha-${item.iid}`,
						has_conflicts: false,
						detailed_merge_status: item.detailed_merge_status ?? "mergeable",
						source_branch: item.source_branch ?? `branch-${item.iid}`,
						changes_count: "3",
						reviewers: (item.reviewers ?? []).map((r) => ({
							username: r.username,
							avatar_url: "",
						})),
						...(details && item.pipeline !== undefined
							? {
									head_pipeline: item.pipeline
										? {
												id: item.pipeline.id,
												status: item.pipeline.status,
												web_url: `https://${this.host}/${project.path}/-/pipelines/${item.pipeline.id}`,
											}
										: null,
								}
							: {}),
					}
				: {}),
		};
	}

	fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input, init);
		const url = new URL(request.url);
		const R = this.R;
		this.log.push(`${request.method} ${url.pathname}${url.search}`);
		const authed = request.headers.get("authorization") === `Bearer ${this.token}`;
		const match = /^\/api\/v4\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname);
		if (url.pathname === "/api/v4/users") {
			const user = this.users.get(url.searchParams.get("username") ?? "");
			return json(R, user ? [user] : []);
		}
		if (!match) return json(R, { message: "404 Not Found" }, 404);
		const ref = decodeURIComponent(match[1] ?? "");
		const project = [...this.projects.values()].find(
			(p) => String(p.id) === ref || p.path === ref.toLowerCase(),
		);
		if (!project || (project.visibility !== "public" && !authed)) {
			return json(R, { message: "404 Project Not Found" }, 404);
		}
		const rest = match[2] ?? "";
		const write = request.method !== "GET";
		if (write && !authed) return json(R, { message: "401 Unauthorized" }, 401);

		if (rest === "") {
			return json(R, {
				id: project.id,
				path_with_namespace: project.path,
				visibility: project.visibility,
				web_url: `https://${this.host}/${project.path}`,
				default_branch: "main",
				permissions: { project_access: authed ? { access_level: 30 } : null, group_access: null },
			});
		}
		if (rest === "/labels") return json(R, project.labels);
		if (rest === "/milestones") {
			const title = url.searchParams.get("title");
			return json(
				R,
				project.milestones.filter((m) => !title || m.title === title),
			);
		}
		if (rest === "/members/all")
			return json(
				R,
				project.members.map((username) => ({ username })),
			);

		const list = /^\/(issues|merge_requests)$/.exec(rest);
		if (list && request.method === "GET") {
			const kind = list[1] === "issues" ? "issue" : "mr";
			const items = [...(kind === "issue" ? project.issues : project.mrs).values()];
			const iids = url.searchParams.getAll("iids[]").map(Number);
			const after = url.searchParams.get("updated_after");
			const branch = url.searchParams.get("source_branch");
			const details = url.searchParams.get("with_labels_details") === "true";
			const visible = items
				.filter((item) => iids.length === 0 || iids.includes(item.iid))
				.filter((item) => !after || (item.updated_at ?? T0) > after)
				.filter((item) => !branch || item.source_branch === branch)
				.filter((item) => !item.confidential || authed);
			return json(
				R,
				visible.map((item) => this.issueJson(project, item, kind, details)),
			);
		}
		if (list && request.method === "POST" && list[1] === "issues") {
			const body = await bodyOf(request);
			const iid = Math.max(0, ...project.issues.keys()) + 1;
			const labels = text(body.labels)
				.split(",")
				.filter(Boolean)
				.map((name) => project.labels.find((l) => l.name === name) ?? { name, color: "#cccccc" });
			const issue: FakeGitLabItem = {
				iid,
				title: String(body.title),
				labels,
				updated_at: new Date().toISOString(),
			};
			project.issues.set(iid, issue);
			return json(R, this.issueJson(project, issue, "issue", false), 201);
		}
		if (list && request.method === "POST" && list[1] === "merge_requests") {
			const body = await bodyOf(request);
			const iid = Math.max(0, ...project.mrs.keys(), ...project.issues.keys()) + 1;
			const mr: FakeGitLabItem = {
				iid,
				title: String(body.title),
				source_branch: String(body.source_branch),
				updated_at: new Date().toISOString(),
			};
			project.mrs.set(iid, mr);
			return json(R, this.issueJson(project, mr, "mr", false), 201);
		}

		const one = /^\/(issues|merge_requests)\/(\d+)(\/.*)?$/.exec(rest);
		if (one) {
			const kind = one[1] === "issues" ? "issue" : "mr";
			const item = (kind === "issue" ? project.issues : project.mrs).get(Number(one[2]));
			if (!item || (item.confidential && !authed))
				return json(R, { message: "404 Not found" }, 404);
			const sub = one[3] ?? "";
			if (sub === "" && request.method === "GET") {
				return json(R, this.issueJson(project, item, kind, true));
			}
			if (sub === "" && request.method === "PUT") {
				const body = await bodyOf(request);
				const add = text(body.add_labels).split(",").filter(Boolean);
				const remove = new Set(text(body.remove_labels).split(",").filter(Boolean));
				let labels = (item.labels ?? []).filter((l) => !remove.has(l.name));
				for (const name of add) {
					if (!labels.some((l) => l.name === name)) {
						labels = [
							...labels,
							project.labels.find((l) => l.name === name) ?? { name, color: "#cccccc" },
						];
					}
				}
				item.labels = labels;
				if (body.state_event === "close") item.state = "closed";
				if (body.state_event === "reopen") item.state = "opened";
				if (body.milestone_id !== undefined) {
					item.milestone =
						project.milestones.find((m) => m.id === body.milestone_id)?.title ?? null;
				}
				if (Array.isArray(body.assignee_ids)) {
					item.assignees = [...this.users.values()]
						.filter((u) => (body.assignee_ids as number[]).includes(u.id))
						.map((u) => u.username);
				}
				item.updated_at = new Date().toISOString();
				return json(R, this.issueJson(project, item, kind, false));
			}
			if (sub === "/notes" && request.method === "POST") {
				const body = await bodyOf(request);
				const note = {
					kind,
					iid: item.iid,
					id: this.nextNote++,
					body: String(body.body),
					created_at: new Date().toISOString(),
				};
				project.notes.push(note);
				item.notes = (item.notes ?? 0) + 1;
				return json(R, note, 201);
			}
			if (sub === "/notes") {
				return json(
					R,
					project.notes.filter((n) => n.iid === item.iid && n.kind === kind).reverse(),
				);
			}
			if (sub === "/reviewers") {
				return json(
					R,
					(item.reviewers ?? []).map((r) => ({
						user: { username: r.username, avatar_url: "" },
						state: r.state,
					})),
				);
			}
		}
		const jobs = /^\/pipelines\/(\d+)\/jobs$/.exec(rest);
		if (jobs) {
			const mr = [...project.mrs.values()].find((m) => m.pipeline?.id === Number(jobs[1]));
			return json(
				R,
				(mr?.pipeline?.failedJobs ?? []).map((name) => ({
					name,
					web_url: `https://${this.host}/${project.path}/-/jobs/${name}`,
				})),
			);
		}
		const branch = /^\/repository\/branches\/(.+)$/.exec(rest);
		if (branch) {
			return project.branches.has(decodeURIComponent(branch[1] ?? ""))
				? json(R, { name: decodeURIComponent(branch[1] ?? "") })
				: json(R, { message: "404 Branch Not Found" }, 404);
		}
		if (rest === "/repository/commits" && request.method === "POST") {
			const body = await bodyOf(request);
			project.branches.add(String(body.branch));
			project.commits.push({
				branch: String(body.branch),
				files: (body.actions as { file_path: string }[]).map((a) => a.file_path),
			});
			return json(R, { id: "c0ffee" }, 201);
		}
		if (rest === "/repository/tree") {
			return json(R, [
				{ name: "0001-first.md", type: "blob" },
				{ name: "drafts", type: "tree" },
			]);
		}
		return json(R, { message: "404 Not Found" }, 404);
	};
}

// --- Forgejo ----------------------------------------------------------------

export interface FakeForgejoItem {
	number: number;
	title: string;
	pull?: boolean;
	state?: "open" | "closed";
	merged?: boolean;
	draft?: boolean;
	labels?: { id: number; name: string; color: string }[];
	assignees?: string[];
	comments?: number;
	updated_at?: string;
	statuses?: { status: string; context: string }[];
	reviews?: { login: string; state: string }[];
	mergeable?: boolean;
	milestone?: string | null;
	head?: string;
}

interface FakeRepo {
	id: number;
	name: string;
	private: boolean;
	items: Map<number, FakeForgejoItem>;
	comments: { number: number; body: string; created_at: string }[];
	dependencies: { number: number; on: { owner: string; repo: string; index: number } }[];
	branches: Set<string>;
	labels: { id: number; name: string; color: string }[];
	milestones: { id: number; title: string }[];
}

export class FakeForgejo {
	readonly log: string[] = [];
	private repos = new Map<string, FakeRepo>();
	constructor(
		readonly host: string,
		readonly token = "fj-token",
		private R: ResponseCtor = Response,
	) {}

	addRepo(id: number, name: string, isPrivate = false): FakeRepo {
		const repo: FakeRepo = {
			id,
			name,
			private: isPrivate,
			items: new Map(),
			comments: [],
			dependencies: [],
			branches: new Set(["main"]),
			labels: [
				{ id: 1, name: "bug", color: "ee0701" },
				{ id: 2, name: "enhancement", color: "84b6eb" },
			],
			milestones: [{ id: 7, title: "1.0" }],
		};
		this.repos.set(name, repo);
		return repo;
	}

	repo(name: string): FakeRepo {
		const repo = this.repos.get(name);
		if (!repo) throw new Error(`no repo ${name}`);
		return repo;
	}

	setItem(name: string, item: FakeForgejoItem): void {
		this.repo(name).items.set(item.number, { updated_at: "2026-10-01T02:00:00+02:00", ...item });
	}

	issueJson(repo: FakeRepo, item: FakeForgejoItem) {
		const milestone = item.milestone
			? (repo.milestones.find((m) => m.title === item.milestone) ?? null)
			: null;
		return {
			id: repo.id * 1000 + item.number,
			number: item.number,
			title: item.title,
			body: "",
			state: item.state ?? "open",
			html_url: `https://${this.host}/${repo.name}/${item.pull ? "pulls" : "issues"}/${item.number}`,
			created_at: "2026-10-01T02:00:00+02:00",
			updated_at: item.updated_at,
			closed_at: item.state === "closed" ? item.updated_at : null,
			labels: item.labels ?? [],
			assignees: (item.assignees ?? []).map((login) => ({
				login,
				avatar_url: `https://${this.host}/avatars/${login}`,
			})),
			user: { login: "ada", avatar_url: `https://${this.host}/avatars/ada` },
			comments: item.comments ?? 0,
			milestone: milestone ? { title: milestone.title, due_on: null } : null,
			pull_request: item.pull
				? { merged: item.merged ?? false, merged_at: null, draft: item.draft ?? false }
				: null,
		};
	}

	pullJson(repo: FakeRepo, item: FakeForgejoItem) {
		return {
			...this.issueJson(repo, item),
			pull_request: undefined,
			draft: item.draft ?? false,
			merged: item.merged ?? false,
			merged_at: item.merged ? item.updated_at : null,
			mergeable: item.mergeable ?? true,
			head: { sha: item.head ?? `head-${item.number}`, ref: `branch-${item.number}` },
			requested_reviewers: [],
			additions: 10,
			deletions: 2,
			changed_files: 3,
		};
	}

	fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input, init);
		const url = new URL(request.url);
		const R = this.R;
		this.log.push(`${request.method} ${url.pathname}${url.search}`);
		const authed = request.headers.get("authorization") === `token ${this.token}`;
		if (/^\/api\/v1\/orgs\/[^/]+\/labels$/.test(url.pathname)) {
			return json(R, { message: "not found" }, 404);
		}
		const match = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
		if (!match) return json(R, { message: "not found" }, 404);
		const name =
			`${decodeURIComponent(match[1] ?? "")}/${decodeURIComponent(match[2] ?? "")}`.toLowerCase();
		const repo = this.repos.get(name);
		if (!repo || (repo.private && !authed)) return json(R, { message: "not found" }, 404);
		if (request.method !== "GET" && !authed) return json(R, { message: "unauthorized" }, 401);
		const rest = match[3] ?? "";
		if (rest === "") {
			return json(R, {
				id: repo.id,
				full_name: repo.name,
				private: repo.private,
				html_url: `https://${this.host}/${repo.name}`,
				default_branch: "main",
				watchers_count: 4,
				permissions: { admin: false, push: authed, pull: true },
			});
		}
		if (rest === "/labels") return json(R, repo.labels);
		if (rest === "/milestones") return json(R, repo.milestones);
		if (rest === "/assignees") return json(R, [{ login: "ada" }, { login: "grace" }]);
		if (rest === "/issues" && request.method === "GET") {
			const since = url.searchParams.get("since");
			return json(
				R,
				[...repo.items.values()]
					.filter((item) => !since || Date.parse(item.updated_at ?? "") >= Date.parse(since))
					.map((item) => this.issueJson(repo, item)),
			);
		}
		if (rest === "/issues" && request.method === "POST") {
			const body = await bodyOf(request);
			const number = Math.max(0, ...repo.items.keys()) + 1;
			const item: FakeForgejoItem = {
				number,
				title: String(body.title),
				labels: repo.labels.filter((l) => ((body.labels as number[]) ?? []).includes(l.id)),
				updated_at: new Date().toISOString(),
			};
			repo.items.set(number, item);
			return json(R, this.issueJson(repo, item), 201);
		}
		const one = /^\/(issues|pulls)\/(\d+)(\/.*)?$/.exec(rest);
		if (one) {
			const item = repo.items.get(Number(one[2]));
			if (!item || (one[1] === "pulls" && !item.pull))
				return json(R, { message: "not found" }, 404);
			const sub = one[3] ?? "";
			if (sub === "" && request.method === "GET") {
				return json(R, one[1] === "pulls" ? this.pullJson(repo, item) : this.issueJson(repo, item));
			}
			if (sub === "" && request.method === "PATCH") {
				const body = await bodyOf(request);
				if (body.state) item.state = body.state as "open" | "closed";
				if (Array.isArray(body.assignees)) item.assignees = body.assignees as string[];
				if (body.milestone !== undefined) {
					item.milestone = repo.milestones.find((m) => m.id === body.milestone)?.title ?? null;
				}
				item.updated_at = new Date().toISOString();
				return json(R, this.issueJson(repo, item), 201);
			}
			if (sub === "/labels" && request.method === "POST") {
				const body = await bodyOf(request);
				const ids = (body.labels as number[]) ?? [];
				const labels = item.labels ?? [];
				for (const label of repo.labels) {
					if (ids.includes(label.id) && !labels.some((l) => l.id === label.id)) labels.push(label);
				}
				item.labels = labels;
				return json(R, labels);
			}
			const label = /^\/labels\/(\d+)$/.exec(sub);
			if (label && request.method === "DELETE") {
				item.labels = (item.labels ?? []).filter((l) => l.id !== Number(label[1]));
				return new R(null, { status: 204 });
			}
			if (sub === "/comments" && request.method === "POST") {
				const body = await bodyOf(request);
				repo.comments.push({
					number: item.number,
					body: String(body.body),
					created_at: new Date().toISOString(),
				});
				item.comments = (item.comments ?? 0) + 1;
				return json(
					R,
					{ html_url: `https://${this.host}/${repo.name}/issues/${item.number}#c1` },
					201,
				);
			}
			if (sub === "/comments") {
				return json(
					R,
					repo.comments.filter((c) => c.number === item.number),
				);
			}
			if (sub === "/dependencies" && request.method === "POST") {
				const body = await bodyOf(request);
				repo.dependencies.push({
					number: item.number,
					on: body as { owner: string; repo: string; index: number },
				});
				return json(R, this.issueJson(repo, item), 201);
			}
			if (sub === "/reviews") {
				return json(
					R,
					(item.reviews ?? []).map((r) => ({
						user: { login: r.login, avatar_url: "" },
						state: r.state,
					})),
				);
			}
		}
		const status = /^\/commits\/([^/]+)\/status$/.exec(rest);
		if (status) {
			const item = [...repo.items.values()].find(
				(i) => (i.head ?? `head-${i.number}`) === decodeURIComponent(status[1] ?? ""),
			);
			return json(R, {
				state: "pending",
				statuses: (item?.statuses ?? []).map((s) => ({
					status: s.status,
					context: s.context,
					target_url: `https://ci.example/${s.context}`,
				})),
			});
		}
		const branch = /^\/branches\/(.+)$/.exec(rest);
		if (branch) {
			return repo.branches.has(decodeURIComponent(branch[1] ?? ""))
				? json(R, { name: branch[1] })
				: json(R, { message: "not found" }, 404);
		}
		if (rest === "/contents" && request.method === "POST") {
			const body = await bodyOf(request);
			repo.branches.add(String(body.new_branch));
			return json(R, { commit: { sha: "c0ffee" } }, 201);
		}
		if (rest === "/pulls" && request.method === "POST") {
			const body = await bodyOf(request);
			const number = Math.max(0, ...repo.items.keys()) + 1;
			const item: FakeForgejoItem = {
				number,
				title: String(body.title),
				pull: true,
				updated_at: new Date().toISOString(),
			};
			repo.items.set(number, item);
			return json(
				R,
				{ number, html_url: `https://${this.host}/${repo.name}/pulls/${number}` },
				201,
			);
		}
		if (rest === "/pulls") return json(R, []);
		if (rest.startsWith("/contents/")) {
			return json(R, [
				{ name: "0002-second.md", type: "file" },
				{ name: "0001-first.md", type: "file" },
			]);
		}
		return json(R, { message: "not found" }, 404);
	};
}

// --- Tangled ----------------------------------------------------------------

export interface FakeTangledItem {
	n: number;
	kind: "issue" | "pull";
	author: string;
	rkey: string;
	title: string;
	state?: string;
	stateUpdatedAt?: string;
	comments?: number;
}

/** tangled.org's pages, api.tangled.org's index, and the PLC directory. */
export class FakeTangled {
	readonly log: string[] = [];
	readonly items: FakeTangledItem[] = [];
	readonly handles = new Map<string, string>();
	constructor(
		/** The repository: `handle/name`, and its DID. */
		readonly repo = "alice.example/knotty",
		readonly repoDid = "did:plc:repoknotty",
		private R: ResponseCtor = Response,
	) {}

	uri(item: FakeTangledItem): string {
		return `at://${item.author}/sh.tangled.repo.${item.kind}/${item.rkey}`;
	}

	record(item: FakeTangledItem) {
		return {
			uri: this.uri(item),
			value: {
				title: item.title,
				createdAt: "2026-10-01T00:00:00Z",
				...(item.kind === "pull"
					? { target: { repo: this.repoDid, branch: "main" } }
					: { repo: this.repoDid }),
			},
		};
	}

	fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input, init);
		const url = new URL(request.url);
		const R = this.R;
		this.log.push(`${request.method} ${url.host}${url.pathname}${url.search}`);
		if (url.host === "plc.directory") {
			const did = decodeURIComponent(url.pathname.slice(1));
			const handle = this.handles.get(did);
			return handle
				? json(R, { id: did, alsoKnownAs: [`at://${handle}`] })
				: json(R, { message: "DID not registered" }, 404);
		}
		if (url.host === "tangled.org") {
			const page = /^\/(.+)\/(issues|pulls)\/(\d+)$/.exec(url.pathname);
			const item =
				page && page[1] === this.repo
					? this.items.find(
							(i) => i.n === Number(page[3]) && i.kind === (page[2] === "pulls" ? "pull" : "issue"),
						)
					: undefined;
			if (!item) return new R("<title>404 · Tangled</title>", { status: 404 });
			// Pages name other items too: the item's own is the subject of its reactions.
			const other = this.items.find((i) => i !== item && i.kind === item.kind);
			return new R(
				`<html><title>${item.title}</title>${other ? `<a href="#">${this.uri(other)}</a>` : ""}<div class="reactions"><input name="subject-uri" type="hidden" value="${this.uri(item)}"></div></html>`,
				{ status: 200, headers: { "content-type": "text/html" } },
			);
		}
		if (url.host === "api.tangled.org") {
			const method = url.pathname.replace(/^\/xrpc\//, "");
			if (method === "sh.tangled.repo.getIssues" || method === "sh.tangled.repo.getPulls") {
				const uris = url.searchParams.getAll(method.endsWith("Issues") ? "issues" : "pulls");
				return json(R, {
					items: this.items.filter((i) => uris.includes(this.uri(i))).map((i) => this.record(i)),
				});
			}
			if (method === "sh.tangled.repo.listIssues" || method === "sh.tangled.repo.listPulls") {
				const kind = method.endsWith("Issues") ? "issue" : "pull";
				if (url.searchParams.get("subject") !== this.repoDid) return json(R, { items: [] });
				const author = url.searchParams.get("author");
				return json(R, {
					items: this.items
						.filter((i) => i.kind === kind && (!author || i.author === author))
						.map((i) => ({
							...this.record(i),
							state: i.state ?? "open",
							...(i.stateUpdatedAt ? { stateUpdatedAt: i.stateUpdatedAt } : {}),
							commentCount: i.comments ?? 0,
						})),
				});
			}
			return json(R, { error: "MethodNotImplemented" }, 501);
		}
		return json(R, { message: "unknown host" }, 502);
	};
}

/** One `fetch` for every fake forge, by host. */
export function forgesFetch(fakes: {
	gitlab?: FakeGitLab[];
	forgejo?: FakeForgejo[];
	tangled?: FakeTangled;
	other?: (request: Request) => Promise<Response> | Response;
}) {
	return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : new Request(input, init);
		const host = new URL(request.url).host;
		const gitlab = fakes.gitlab?.find((fake) => fake.host === host);
		if (gitlab) return gitlab.fetch(request);
		const forgejo = fakes.forgejo?.find((fake) => fake.host === host);
		if (forgejo) return forgejo.fetch(request);
		if (fakes.tangled && ["tangled.org", "api.tangled.org", "plc.directory"].includes(host)) {
			return fakes.tangled.fetch(request);
		}
		if (fakes.other) return fakes.other(request);
		return new Response(JSON.stringify({ message: `no fake for ${host}` }), { status: 502 });
	};
}
