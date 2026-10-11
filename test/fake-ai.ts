// A fake Workers AI for tests (#73): the Worker's `AI` binding, run in
// Miniflare as a tiny Worker whose `run()` asks this one, in Node, so tests
// see everything sent to the model and choose what comes back. Requests look
// like the real binding's (a model, then `{ messages, response_format, … }`)
// and answers like a chat-completions model's (`choices[0].message.content`).

import { type Request, Response } from "miniflare";

export interface AiCall {
	model: string;
	input: {
		messages?: { role: string; content: string }[];
		response_format?: { type: string; json_schema?: { name?: string } };
		[key: string]: unknown;
	};
}

/** The Worker standing in for the binding: `env.AI.run(model, input)` over RPC. */
export const FAKE_AI_SCRIPT = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class FakeAi extends WorkerEntrypoint {
	async run(model, input) {
		const response = await this.env.NODE.fetch("http://fake-ai/run", {
			method: "POST",
			body: JSON.stringify({ model, input }),
		});
		if (!response.ok) throw new Error("AiError: " + (await response.text()));
		return response.json();
	}
}
export default { fetch: () => new Response("fake ai") };
`;

export class FakeAi {
	readonly calls: AiCall[] = [];
	/** Fail every request (as Workers AI does when it's down). */
	failing = false;
	/** What a name request answers; by default, the first words of the first note. */
	name: (notes: string[]) => string = (notes) =>
		(notes[0] ?? "Untitled").split(/\s+/).slice(0, 3).join(" ");

	/** Every note text sent, in any request, for checking what was never sent. */
	get sent(): string {
		return JSON.stringify(this.calls.map((call) => call.input.messages));
	}

	readonly fetch = async (request: Request): Promise<Response> => {
		const call = (await request.json()) as AiCall;
		this.calls.push(call);
		if (this.failing) return new Response("3040: capacity temporarily exceeded", { status: 500 });
		const user = call.input.messages?.find((message) => message.role === "user")?.content ?? "";
		const schema = call.input.response_format?.json_schema?.name;
		let content: unknown;
		if (schema === "pile_groups") {
			const { notes } = JSON.parse(user) as { notes: { id: string; text: string }[] };
			// Two piles: the first half, and the rest.
			const half = Math.ceil(notes.length / 2);
			content = {
				groups: [
					{ name: "First half", notes: notes.slice(0, half).map((note) => note.id) },
					{ name: "Second half", notes: notes.slice(half).map((note) => note.id) },
				],
			};
		} else {
			const notes = JSON.parse(user.replace(/^Notes: /, "").replace(/\nName:$/, "")) as string[];
			content = { name: this.name(notes) };
		}
		return Response.json({
			choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
		});
	};
}
