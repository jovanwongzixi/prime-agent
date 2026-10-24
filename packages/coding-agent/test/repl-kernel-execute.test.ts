import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_DISPLAY_MIME,
	ATTACHMENT_DISPLAY_MIME,
	createDeferred,
	DIFF_DISPLAY_MIME,
	type HostRequestHandlers,
	ReplKernelManager,
} from "../src/core/kernel/index.js";
import * as childProcesses from "../src/utils/child-process.js";

it.each([false, true])("bounds a cell across the process boundary (blocked=%s)", async (blocked) => {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-timeout-"));
	const runtime = `
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let active;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.type === "interrupt" && active === req.id) {
    emit({ event: "done", id: req.id, status: "ok" });
    active = undefined;
  } else if (req.type === "execute") {
    emit({ event: "stdout", id: req.id, text: req.code });
    if (req.code === "hang") {
      active = req.id;
      if (${blocked}) while (true) {}
    } else emit({ event: "done", id: req.id, status: "ok" });
  } else if (req.type === "shutdown") process.exit(0);
});
emit({ event: "ready", protocol: 3 });
`;
	let exited: Promise<unknown> = Promise.resolve();
	const spawnSpy = vi.spyOn(childProcesses, "spawnHidden").mockImplementation((_command, _args, opts) => {
		const child = spawn(process.execPath, ["-e", runtime], opts ?? {});
		exited = once(child, "exit");
		return child;
	});
	const manager = new ReplKernelManager({ python: process.execPath, cwd: dir });
	try {
		await manager.start();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const started = createDeferred<void>();
		const call = manager.execute("hang", { timeoutMs: 100, onStream: () => started.resolve() });
		await started.promise;
		await vi.advanceTimersByTimeAsync(100);
		if (blocked) await vi.advanceTimersByTimeAsync(1000);
		const result = await call;
		expect(result).toMatchObject({ status: "error", stdout: "hang", kernelKilled: blocked });
		expect(result.error?.ename).toBe("TimeoutError");
		expect(manager.isDefunct).toBe(blocked);
		if (!blocked) {
			await expect(manager.execute("next", { timeoutMs: 100 })).resolves.toMatchObject({ status: "ok" });
		}
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.useRealTimers();
		await manager.kill();
		await exited;
		spawnSpy.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveReplPython();
const describeIf = python ? describe : describe.skip;

describeIf("ReplKernelManager execute (real runtime)", () => {
	let dir = "";
	let manager: ReplKernelManager | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-execute-"));
	});

	afterEach(async () => {
		await manager?.shutdown({ snapshot: true, drainHostRequests: true });
		manager = undefined;
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = "";
		}
	});

	it("streams stdout/stderr, returns results, and persists state across cells", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const chunks: { name: string; text: string }[] = [];
		const first = await manager.execute("import sys\nx = 21\nprint('to-out')\nsys.stderr.write('to-err\\n')", {
			onStream: (chunk, name) => chunks.push({ name, text: chunk }),
		});
		expect(first.status).toBe("ok");
		expect(first.stdout).toContain("to-out");
		expect(first.stderr).toContain("to-err");
		expect(chunks.some((c) => c.name === "stdout" && c.text.includes("to-out"))).toBe(true);

		const second = await manager.execute("x * 2");
		expect(second.status).toBe("ok");
		expect(second.result).toBe("42");
	}, 30_000);

	it("reports cell errors with a clean traceback", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const r = await manager.execute("def boom():\n    raise ValueError('nope')\nboom()");
		expect(r.status).toBe("error");
		expect(r.error?.ename).toBe("ValueError");
		expect(r.error?.evalue).toBe("nope");
		expect(r.error?.traceback.join("")).toContain("raise ValueError('nope')");
	}, 30_000);

	it("parses emitted display payloads into diffs, attachments, and sent messages", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const code = [
			"from rlm import emit",
			`emit({${JSON.stringify(DIFF_DISPLAY_MIME)}: {"path": "/tmp/f.py", "old_str": "a", "new_str": "b", "start_line": 3}})`,
			`emit({${JSON.stringify(ATTACHMENT_DISPLAY_MIME)}: {"mime_type": "image/png", "data": "aGVsbG8=", "path": "/tmp/i.png"}})`,
			`emit({${JSON.stringify(AGENT_MESSAGE_DISPLAY_MIME)}: {"id": "m1", "message": "hi", "deliveryStatus": "delivered", "receiverRole": "parent", "target": {"activeSessionId": "a", "sessionId": "s"}}})`,
		].join("\n");
		const r = await manager.execute(code);
		expect(r.status).toBe("ok");
		expect(r.diffs).toEqual([{ path: "/tmp/f.py", oldStr: "a", newStr: "b", startLine: 3 }]);
		expect(r.attachments).toEqual([{ mimeType: "image/png", data: "aGVsbG8=", path: "/tmp/i.png" }]);
		expect(r.sentAgentMessages).toEqual([
			{
				id: "m1",
				message: "hi",
				deliveryStatus: "delivered",
				receiverRole: "parent",
				target: { activeSessionId: "a", sessionId: "s" },
			},
		]);
	}, 30_000);

	it("round-trips host requests through hostHandlers, including error replies", async () => {
		const hostHandlers: HostRequestHandlers = {
			"test.echo": async (payload) => ({ echoed: payload.value, cell: payload.cellSourceCode }),
			"test.fail": async () => {
				throw new Error("handler exploded");
			},
		};
		manager = new ReplKernelManager({ python: python as string, cwd: dir, hostHandlers });

		const ok = await manager.execute(
			"import rlm\nreply = await rlm.host_request('test.echo', {'value': 7})\nreply['echoed']",
		);
		expect(ok.status).toBe("ok");
		expect(ok.result).toBe("7");

		const cellSource = await manager.execute("reply['cell']");
		expect(cellSource.status).toBe("ok");
		expect(cellSource.result).toContain("test.echo");

		const failed = await manager.execute("import rlm\nawait rlm.host_request('test.fail')");
		expect(failed.status).toBe("error");
		expect(failed.error?.ename).toBe("RuntimeError");
		expect(failed.error?.evalue).toBe("handler exploded");

		const unknown = await manager.execute("import rlm\nawait rlm.host_request('test.unknown')");
		expect(unknown.status).toBe("error");
		expect(unknown.error?.evalue).toContain('host request type "test.unknown" is not available');

		const padded = `${"# pad\n".repeat(500)}import rlm\nreply = await rlm.host_request('test.echo', {'value': 9, 'cellSourceCode': 'FAKE'})\n[len(reply['cell']), reply['cell'].endswith(' [... cell source truncated at 2048 chars ...]'), reply['cell'] == 'FAKE']`;
		const capped = await manager.execute(padded);
		expect(capped.status).toBe("ok");
		expect(capped.result).toBe("[2094, True, False]");
	}, 30_000);

	it("spawns through rlm.spawn over the unchanged rlm.run wire type, requires a child name, and refuses a direct rlm call", async () => {
		const requestTypes: string[] = [];
		const hostHandlers: HostRequestHandlers = {
			"rlm.run": async (payload) => {
				requestTypes.push("rlm.run");
				expect(payload.prompt).toBe("child work");
				return {
					rlm_child_id: "sub-a1b2c3d4",
					name: "worker",
					session_dir: dir,
					model: "anthropic/claude-opus-4-7",
				};
			},
		};
		manager = new ReplKernelManager({ python: python as string, cwd: dir, hostHandlers });

		const spawned = await manager.execute(
			"import rlm\nhandle = await rlm.spawn('child work', name='worker')\nhandle.name",
		);
		expect(spawned.status).toBe("ok");
		expect(spawned.result).toBe("'worker'");
		expect(requestTypes).toEqual(["rlm.run"]);

		const nameless = await manager.execute("await rlm.spawn('child work')");
		expect(nameless.status).toBe("error");
		expect(nameless.error?.ename).toBe("TypeError");
		expect(nameless.error?.evalue).toContain("required keyword-only argument: 'name'");
		expect(requestTypes).toEqual(["rlm.run"]);

		const called = await manager.execute("await rlm('child work')");
		expect(called.status).toBe("error");
		expect(called.error?.ename).toBe("TypeError");
		expect(called.error?.evalue).toContain("await rlm.spawn(");
	}, 30_000);

	it("dispose sends the protocol shutdown so live bash children die with the kernel", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const r = await manager.execute("from rlm import bash\nh = bash('sleep 600')\nh.pid");
		expect(r.status).toBe("ok");
		const pid = Number(r.result);
		expect(Number.isInteger(pid)).toBe(true);
		await manager.shutdown({ snapshot: true, drainHostRequests: true });
		let alive = true;
		for (let i = 0; i < 100; i++) {
			try {
				process.kill(pid, 0);
			} catch {
				alive = false;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(alive).toBe(false);
	}, 30_000);

	it("surfaces unattributed background output separately from cell stdout", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const first = await manager.execute(
			[
				"import threading, time",
				"def late():",
				"    time.sleep(0.5)",
				"    print('SECRET-thread', flush=True)",
				"threading.Thread(target=late, daemon=True).start()",
			].join("\n"),
		);
		expect(first.status).toBe("ok");

		const second = await manager.execute("import time\ntime.sleep(1.0)\nprint('own-output')");
		expect(second.status).toBe("ok");
		expect(second.stdout).toContain("own-output");
		expect(second.stdout).not.toContain("SECRET-thread");
		expect(second.backgroundOutput ?? "").toContain("SECRET-thread");
	}, 30_000);
});
