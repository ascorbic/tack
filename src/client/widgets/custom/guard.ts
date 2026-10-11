import { type Node, parse } from "acorn";
import { LOOP_GUARD } from "../../../shared/customWidgets.ts";

// Loop guards for custom widgets' code (#66). In Safari and Firefox (and
// Chrome, for every sandbox on the page) a widget's frame shares a thread
// with the board, so a loop that never ends would freeze the board for
// everyone who opens it, and no ping can stop it. So before the code runs,
// every loop gets a check at the top of its body, `__tackLoop`, which the
// sandbox's bootstrap defines: a loop that keeps the thread for more than
// `LOOP_MS` without letting anything else run throws, and the widget's
// error says which line. Loops that wait (an `await` on a timer, say)
// start counting afresh each time they wake.
//
// It's a guard against mistakes, not a security boundary: code can still
// spin in other ways (a regular expression that backtracks forever, say).
// See docs/security-review.md.

const LOOPS = new Set([
	"ForStatement",
	"ForInStatement",
	"ForOfStatement",
	"WhileStatement",
	"DoWhileStatement",
]);

interface LoopNode extends Node {
	body: Node;
}

/**
 * The code with every loop guarded. Code that doesn't parse is returned
 * as it is, so the browser reports the syntax error where it is.
 */
export function guardLoops(code: string): string {
	let program: Node;
	try {
		program = parse(code, {
			ecmaVersion: "latest",
			sourceType: "module",
			locations: true,
			allowHashBang: true,
		});
	} catch {
		return code;
	}
	// Where each edit goes among others at the same offset: whatever closes
	// there first, then a body's opening brace and check, then a loop's block.
	const edits: { at: number; text: string; rank: number }[] = [];
	let n = 0;
	const visit = (node: Node, parent: Node | null) => {
		if (LOOPS.has(node.type)) {
			const loop = node as LoopNode;
			const name = `__tack$loop${n++}`;
			const line = loop.loc?.start.line ?? 0;
			// The loop's state lives in a block around it, outside any labels it has
			// (`continue label` must name the loop itself).
			let outer: Node = loop;
			let up = parent;
			while (up?.type === "LabeledStatement" && labelled.get(up) === outer) {
				outer = up;
				up = parents.get(up) ?? null;
			}
			edits.push({ at: outer.start, text: `{ const ${name} = { e: -1, t: 0 }; `, rank: 2 });
			edits.push({ at: outer.end, text: " }", rank: 0 });
			const check = `${LOOP_GUARD}(${name}, ${line});`;
			if (loop.body.type === "BlockStatement") {
				edits.push({ at: loop.body.start + 1, text: ` ${check}`, rank: 1 });
			} else {
				edits.push({ at: loop.body.start, text: `{ ${check} `, rank: 1 });
				edits.push({ at: loop.body.end, text: " }", rank: 0 });
			}
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) {
				for (const child of value) if (isNode(child)) walk(child, node);
			} else if (isNode(value)) {
				walk(value, node);
			}
		}
	};
	const parents = new Map<Node, Node | null>();
	const labelled = new Map<Node, Node>();
	const walk = (node: Node, parent: Node | null) => {
		parents.set(node, parent);
		if (node.type === "LabeledStatement") labelled.set(node, (node as LoopNode).body);
		visit(node, parent);
	};
	walk(program, null);
	if (edits.length === 0) return code;
	// From the end, so earlier offsets stay put. Each insertion at an offset
	// lands before the ones already there, so the last rank goes in first.
	edits.sort((a, b) => b.at - a.at || b.rank - a.rank);
	let out = code;
	for (const edit of edits) out = out.slice(0, edit.at) + edit.text + out.slice(edit.at);
	return out;
}

function isNode(value: unknown): value is Node {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as { type?: unknown }).type === "string" &&
		typeof (value as { start?: unknown }).start === "number"
	);
}
