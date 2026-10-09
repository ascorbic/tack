import { forgeByName } from "./forges/index.ts";
import { log } from "./log.ts";
import { repoObject, repoObjectName } from "./routing.ts";

/** `POST /webhooks/:forge`: the adapter verifies and normalises, Repo ingests. */
export async function handleWebhook(
	request: Request,
	env: Env,
	forgeName: string,
): Promise<Response> {
	const adapter = forgeByName(forgeName);
	if (!adapter?.receiveWebhook) return new Response("Unknown forge", { status: 404 });

	const logger = log.with({ forge: forgeName });
	logger.info("webhook.received", { bytes: Number(request.headers.get("content-length") ?? 0) });

	const result = await adapter.receiveWebhook(request, env);
	if (result.type === "response") {
		// Handled by the adapter: pings, bad signatures, ignored events.
		const { status } = result.response;
		const body: unknown = await result.response
			.clone()
			.json()
			.catch(() => null);
		if (status >= 500) logger.error("webhook.failed", { status, body });
		else if (status === 401 || status === 403) logger.warn("webhook.rejected", { status, body });
		else logger.info("webhook.ignored", { status, body });
		return result.response;
	}

	const { delivery } = result;
	const context = {
		delivery: delivery.id,
		event: delivery.event,
		action: delivery.action,
		repo: delivery.repo.name,
		repoId: repoObjectName(delivery.repo),
	};
	logger.info("webhook.verified", { ...context, cards: delivery.cards.length });

	try {
		// Deliveries carry the repository id, so renames never split the cache.
		const outcome = await repoObject(env, delivery.repo).ingest(delivery);
		return Response.json(outcome, { status: 202 });
	} catch (error) {
		logger.error("webhook.failed", { ...context, error });
		return Response.json({ error: "ingest failed" }, { status: 500 });
	}
}
