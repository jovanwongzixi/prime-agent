/**
 * Block literal `find /` calls before they start. Load with
 * `--extension packages/coding-agent/examples/extensions/block-root-find.ts`.
 *
 * This is a convenience guard, not a security boundary: commands assembled in
 * Python at runtime or launched by other subprocess APIs are not visible here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Match a root path argument, but not /tmp or another path below root.
const ROOT_FIND =
	/(?:^|[;&|()\n])\s*(?:sudo\s+)?find\s+(?:(?:-[HLPO]|--)\s+)*(?:\/+(?=$|[\s;&|)])|["']\/+["'](?=$|[\s;&|)]))/;
const LITERAL_BASH = /\bbash\s*\(\s*(?:[rRuU]{0,2})?(["'])(?<command>(?:\\.|(?!\1)[^\\])*)\1/g;

function containsRootFind(command: string): boolean {
	return ROOT_FIND.test(command);
}

function containsLiteralRootFind(code: string): boolean {
	if (/^(?:[ \t]*\r?\n)*[ \t]*%%bash\b/.test(code)) {
		return containsRootFind(code.replace(/^(?:[ \t]*\r?\n)*[ \t]*%%bash[^\r\n]*(?:\r?\n|$)/, ""));
	}
	for (const match of code.matchAll(LITERAL_BASH)) {
		if (containsRootFind(match.groups?.command ?? "")) return true;
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		const blocked =
			(event.toolName === "bash" &&
				typeof event.input.command === "string" &&
				containsRootFind(event.input.command)) ||
			(event.toolName === "ipython" &&
				typeof event.input.code === "string" &&
				containsLiteralRootFind(event.input.code));
		if (blocked) {
			return { block: true, reason: "Root-wide find is blocked. Search a narrower directory instead." };
		}
		return undefined;
	});
}
