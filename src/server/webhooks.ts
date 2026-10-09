import { forgeByName } from "./forges/index.ts";
import { repos } from "./namespaces.ts";

/** `POST /webhooks/:forge`: the adapter verifies and normalises, Repo ingests. */
export async function handleWebhook(
	request: Request,
	env: Env,
	forgeName: string,
): Promise<Response> {
	const adapter = forgeByName(forgeName);
	if (!adapter?.receiveWebhook) return new Response("Unknown forge", { status: 404 });

	const result = await adapter.receiveWebhook(request, env);
	if (result.type === "response") return result.response;

	const outcome = await repos(env).getByName(result.delivery.repoKey).ingest(result.delivery);
	return Response.json(outcome, { status: 202 });
}
