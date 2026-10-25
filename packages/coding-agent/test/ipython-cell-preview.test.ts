import type { TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme, preloadCodeHighlighter, theme } from "../src/modes/interactive/theme/theme.js";

type CellState = ConstructorParameters<typeof IPythonCellComponent>[0];

/**
 * The collapsed summary row shows a one-line code preview next to the status
 * marker. It renders plain and dim (matching the quieted thinking trace) so it
 * reads as metadata; the expanded block keeps full highlighting.
 */
describe("IPythonCellComponent collapsed preview styling", () => {
	let previousColorTerm: string | undefined;

	beforeAll(async () => {
		previousColorTerm = process.env.COLORTERM;
		await preloadCodeHighlighter();
	});

	afterAll(() => {
		if (previousColorTerm === undefined) {
			delete process.env.COLORTERM;
		} else {
			process.env.COLORTERM = previousColorTerm;
		}
	});

	function useTruecolor(): void {
		process.env.COLORTERM = "truecolor";
		initTheme("dark");
	}

	const renderCell = (state: CellState): string => new IPythonCellComponent(state).render(100).join("\n");

	it.each([false, true])("shows explicit IPython timeouts in the %s layout, updates, and replay", (expanded) => {
		useTruecolor();
		const args = { code: "pass", timeout: 15 };
		const tool = new ToolExecutionComponent("ipython", "cell", args, {}, undefined, {} as TUI, "/tmp");
		tool.updateResult({ content: [{ type: "text", text: "3" }], details: { status: "ok" }, isError: false });
		tool.setExpanded(expanded);
		const renderedTimeout = () => tool.render(100)[0].match(/timeout ([\d.]+)s/)?.[1];
		expect(renderedTimeout()).toBe("15");
		for (const timeout of [undefined, 300, 0.5, 15, undefined]) {
			tool.updateArgs({ code: "print(1)", ...(timeout === undefined ? {} : { timeout }) });
			expect(renderedTimeout()).toBe(timeout?.toString());
		}
	});

	it("renders the collapsed python preview plain and dim, without syntax colors", () => {
		useTruecolor();
		const raw = renderCell({
			code: 'print("hello world")',
			content: [{ type: "text", text: "hello world" }],
			details: { status: "ok", durationMs: 12, stdout: "hello world" },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});

		expect(raw).toContain(theme.fg("dim", 'print("hello world")'));
		expect(raw).not.toContain(theme.getFgAnsi("syntaxString"));
		// Line counts and duration render in the same dim tone as the preview.
		expect(raw).toContain(theme.fg("dim", "↑ 1 ↓ 1 lines"));
		expect(raw).toContain(theme.fg("dim", "12ms"));
	});

	it("renders the collapsed bash preview dim instead of bash-mode green", () => {
		useTruecolor();
		const raw = renderCell({
			code: "!git status --short",
			content: [{ type: "text", text: "ok" }],
			details: { status: "ok", durationMs: 12, stdout: "ok" },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});

		expect(raw).toContain(theme.fg("dim", "!git status --short"));
		expect(raw).not.toContain(theme.fg("bashMode", "!git status --short"));
	});

	it("keeps syntax highlighting and timeout guidance in expanded python cells", () => {
		useTruecolor();
		const evalue =
			"Long-running call exceeded the execution deadline; was this intended?\nUse a larger timeout or a background process.";
		const raw = renderCell({
			code: 'print("hello world")',
			content: [{ type: "text", text: "hello world" }],
			details: { status: "error", error: { ename: "TimeoutError", evalue, traceback: [] } },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});

		expect(raw).toContain(theme.getFgAnsi("syntaxString"));
		expect(raw).toContain("was this intended?");
		expect(raw).toContain("Use a larger timeout or a background process.");
	});

	it("keeps bash-mode green on the expanded bash code block", () => {
		useTruecolor();
		const raw = renderCell({
			code: "!git status --short",
			content: [{ type: "text", text: "ok" }],
			details: { status: "ok", durationMs: 12, stdout: "ok" },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});

		expect(raw).toContain(theme.fg("bashMode", "!git status --short"));
	});
});
