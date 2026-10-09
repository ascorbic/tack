import type { Board } from "./board.ts";
import type { Instance } from "./instance.ts";
import type { Repo } from "./repo.ts";

// The Durable Object bindings point back at this same Worker, which the
// config can't express as typed bindings without referencing itself. These
// accessors restore the class types for RPC.

export function boards(env: Env): DurableObjectNamespace<Board> {
	return env.Board as unknown as DurableObjectNamespace<Board>;
}

export function repos(env: Env): DurableObjectNamespace<Repo> {
	return env.Repo as unknown as DurableObjectNamespace<Repo>;
}

/** The singleton holding instance-wide state: the GitHub App, users, sessions, access. */
export function instance(env: Env): DurableObjectStub<Instance> {
	return (env.Instance as unknown as DurableObjectNamespace<Instance>).getByName("instance");
}
