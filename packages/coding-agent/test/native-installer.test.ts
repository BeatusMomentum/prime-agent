import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeUpdatePlan } from "../src/cli/native-update.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

const installer = resolve(__dirname, "../../../install.sh");
const assets = [
	"package.json",
	"install.sh",
	"prime-agent-runtime/pyproject.toml",
	"prime-agent-runtime/src/rlm/repl.py",
	"theme/prime.json",
	"export-html/template.html",
	"photon_rs_bg.wasm",
];
const platform = `${process.platform}-${process.arch}`;
const feed = new Map<string, Buffer>();
let beforeArchiveResponse: (() => void) | undefined;
const server = createServer((request, response) => {
	if (request.url?.endsWith(".tar.gz")) beforeArchiveResponse?.();
	const data = feed.get(request.url ?? "");
	response.writeHead(data ? 200 : 404);
	response.end(data ?? "not found");
});
let root: string;
let home: string;
let base: string;

function publish(version: string, options: { broken?: boolean; missing?: boolean; link?: boolean } = {}) {
	const source = mkdtempSync(join(root, "archive-"));
	for (const asset of assets) {
		if (options.missing && asset === assets[2]) continue;
		mkdirSync(dirname(join(source, asset)), { recursive: true });
		writeFileSync(join(source, asset), "fixture\n");
	}
	writeFileSync(join(source, "package.json"), JSON.stringify({ version }));
	writeFileSync(join(source, "install.sh"), readFileSync(installer));
	writeFileSync(
		join(source, "prime-agent"),
		options.broken ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
		{ mode: 0o755 },
	);
	if (options.link) symlinkSync("/tmp", join(source, "outside"));
	const filename = `prime-agent-${version}-${platform}.tar.gz`;
	const archive = join(root, filename);
	execFileSync("tar", ["-czf", archive, "-C", source, "."]);
	const bytes = readFileSync(archive);
	const digest = createHash("sha256").update(bytes).digest("hex");
	feed.set(`/releases/v${version}/${filename}`, bytes);
	feed.set(`/releases/v${version}/SHA256SUMS`, Buffer.from(`${digest}  ${filename}\n`));
	feed.set(
		version.includes("-beta") ? "/beta.json" : "/latest.json",
		Buffer.from(
			JSON.stringify({
				version,
				binaries: [{ platform, file: filename, sha256: digest }],
			}),
		),
	);
	return filename;
}

async function install(version: string, extra: NodeJS.ProcessEnv = {}, entrypoint = installer) {
	return run("sh", [entrypoint, version], extra);
}

async function run(executable: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
	const child = spawn(executable, args, {
		cwd: home,
		env: {
			...process.env,
			HOME: home,
			TMPDIR: root,
			PATH: "/usr/bin:/bin",
			XDG_DATA_HOME: join(home, "data"),
			SHELL: "/bin/sh",
			PRIME_AGENT_INSTALL_METHOD: "binary",
			PRIME_AGENT_INSTALLER_NONINTERACTIVE: "1",
			PRIME_AGENT_INSTALLER_PLAIN: "1",
			PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL: "0",
			PRIME_AGENT_DOWNLOAD_BASE_URL: base,
			PRIME_AGENT_CODING_AGENT_DIR: join(home, "agent"),
			DO_NOT_TRACK: "1",
			...extra,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		output += chunk.toString();
	});
	return await new Promise<{ code: number | null; output: string }>((done, reject) => {
		child.once("error", reject);
		child.once("close", (code) => done({ code, output }));
	});
}

function command() {
	return join(home, "data/prime-agent/bin/prime-agent");
}

function daemonSocket() {
	return join(root, `prime-agent-${process.getuid?.() ?? "user"}`, "daemon.sock");
}

async function daemonExecutable() {
	const client = new DaemonClient(daemonSocket());
	try {
		await client.connect();
		return (await client.waitForHello()).runtime?.executablePath;
	} finally {
		client.close();
	}
}

describe.skipIf(process.platform === "win32")("managed compiled installer", () => {
	beforeAll(async () => {
		root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "native-installer-")));
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("missing server address");
		base = `http://127.0.0.1:${address.port}`;
	});
	beforeEach(() => {
		home = mkdtempSync(join(root, "home with spaces-"));
		feed.clear();
		beforeArchiveResponse = undefined;
		vi.stubEnv("PI_OFFLINE", "");
		vi.stubEnv("PI_SKIP_VERSION_CHECK", "");
		vi.stubEnv("PRIME_AGENT_DOWNLOAD_BASE_URL", "");
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		if (!existsSync(daemonSocket())) return;
		const client = new DaemonClient(daemonSocket());
		try {
			await client.connect();
			const hello = await client.waitForHello();
			await client.request({ type: "shutdown", force: true });
			if (hello.supervisorPid)
				await expect
					.poll(
						() => {
							try {
								process.kill(hello.supervisorPid!, 0);
								return false;
							} catch {
								return true;
							}
						},
						{ timeout: 10000 },
					)
					.toBe(true);
		} finally {
			client.close();
		}
	});
	afterAll(async () => {
		await new Promise<void>((done) => server.close(() => done()));
		rmSync(root, { recursive: true, force: true });
	});

	it("defaults to a verified executable without Node, preserves user data, and retains the previous release", async () => {
		publish("1.0.0");
		publish("1.0.1");
		mkdirSync(join(home, ".prime/agent"), { recursive: true });
		writeFileSync(join(home, ".prime/agent/auth.json"), "keep credentials");
		const first = await install("1.0.0", { PRIME_AGENT_INSTALL_METHOD: "auto" });
		expect(first.code, first.output).toBe(0);
		expect(execFileSync(join(home, ".local/bin/prime-agent"), ["--version"], { encoding: "utf8" })).toBe("1.0.0\n");
		const previous = readlinkSync(command());
		const second = await install("1.0.1");
		expect(second.code, second.output).toBe(0);
		expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
		expect(readFileSync(join(home, ".prime/agent/auth.json"), "utf8")).toBe("keep credentials");
		expect(existsSync(join(home, "data/prime-agent/.install-lock"))).toBe(false);
	});

	it.each(["checksum", "missing", "broken", "link", "duplicate"])(
		"leaves the current command working after %s validation fails",
		async (failure) => {
			publish("1.0.0");
			const first = await install("1.0.0");
			expect(first.code, first.output).toBe(0);
			const target = readlinkSync(command());
			const filename = publish("1.0.1", {
				missing: failure === "missing",
				broken: failure === "broken",
				link: failure === "link",
			});
			if (failure === "checksum") feed.set(`/releases/v1.0.1/${filename}`, Buffer.from("corrupt"));
			if (failure === "duplicate")
				feed.set(
					"/releases/v1.0.1/SHA256SUMS",
					Buffer.concat([feed.get("/releases/v1.0.1/SHA256SUMS")!, feed.get("/releases/v1.0.1/SHA256SUMS")!]),
				);
			const result = await install("1.0.1");
			expect(result.code, result.output).not.toBe(0);
			expect(readlinkSync(command())).toBe(target);
			expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe("1.0.0\n");
			expect(existsSync(join(home, "data/prime-agent/.install-lock"))).toBe(false);
		},
	);

	it("plans verified updates and restores the previous release offline", async () => {
		publish("1.0.0");
		expect((await install("1.0.0")).code).toBe(0);
		const executable = realpathSync(command());
		const plan = (force = false, rollback = false) => getNativeUpdatePlan({ force, rollback, executable });
		expect((await plan()).command).toBeUndefined();
		expect((await plan(true)).command).toBeDefined();
		await expect(plan(false, true)).rejects.toThrow("No valid previous");
		publish("1.0.1");
		const update = await plan();
		expect(update.targetVersion).toBe("1.0.1");
		expect(update.command?.args).toContain(`PRIME_AGENT_EXPECTED_CURRENT=${readlinkSync(command())}`);
		expect(update.command?.args).toContainEqual(expect.stringMatching(/^PRIME_AGENT_EXPECTED_SHA256=[a-f0-9]{64}$/));
		const result = await install("1.0.1");
		expect(result.code, result.output).toBe(0);
		const current = readlinkSync(command());
		feed.clear();
		vi.stubEnv("PI_OFFLINE", "1");
		const rollback = await plan(false, true);
		expect(rollback.targetVersion).toBe("1.0.0");
		expect(rollback.command?.args.at(-1)).toBe("--rollback");
		const restored = await install("--rollback");
		expect(restored.code, restored.output).toBe(0);
		expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe("1.0.0\n");
		expect(readlinkSync(join(dirname(command()), "previous"))).toBe(current);
	});

	it.each(["missing", "checksum", "duplicate", "path"])(
		"rejects a %s compiled manifest without changing the installation",
		async (failure) => {
			publish("1.0.0");
			expect((await install("1.0.0")).code).toBe(0);
			const current = readlinkSync(command());
			const artifact = { platform, file: `prime-agent-1.0.1-${platform}.tar.gz`, sha256: "a".repeat(64) };
			if (failure === "checksum") artifact.sha256 = "bad";
			if (failure === "path") artifact.file = "../outside.tar.gz";
			feed.set(
				"/latest.json",
				Buffer.from(
					JSON.stringify({
						version: "1.0.1",
						binaries: failure === "missing" ? [] : failure === "duplicate" ? [artifact, artifact] : [artifact],
					}),
				),
			);
			await expect(
				getNativeUpdatePlan({ force: false, rollback: false, executable: realpathSync(command()) }),
			).rejects.toThrow();
			expect(readlinkSync(command())).toBe(current);
		},
	);

	it("keeps beta updates on the beta channel", async () => {
		publish("1.0.0-beta.1");
		expect((await install("1.0.0-beta.1")).code).toBe(0);
		publish("1.0.0-beta.2");
		publish("9.0.0");
		const plan = await getNativeUpdatePlan({ force: false, rollback: false, executable: realpathSync(command()) });
		expect(plan.targetVersion).toBe("1.0.0-beta.2");
	});

	it.each(["stale", "checksum", "rollback"])(
		"keeps the active release when %s update validation fails",
		async (failure) => {
			publish("1.0.0");
			expect((await install("1.0.0")).code).toBe(0);
			const current = readlinkSync(command());
			publish("1.0.1");
			const result = await install(
				failure === "rollback" ? "--rollback" : "1.0.1",
				failure === "stale"
					? { PRIME_AGENT_EXPECTED_CURRENT: "an older release" }
					: { PRIME_AGENT_EXPECTED_SHA256: "0".repeat(64) },
			);
			expect(result.code, result.output).not.toBe(0);
			expect(readlinkSync(command())).toBe(current);
		},
	);

	it("refuses self-update of an unmanaged executable", async () => {
		await expect(getNativeUpdatePlan({ force: true, rollback: false, executable: process.execPath })).rejects.toThrow(
			"not owned",
		);
	});

	it.each(["changed previous", "missing asset", "broken executable"])(
		"preserves the active release when rollback finds a %s",
		async (failure) => {
			publish("1.0.0");
			expect((await install("1.0.0")).code).toBe(0);
			const previousDir = dirname(realpathSync(command()));
			publish("1.0.1");
			expect((await install("1.0.1")).code).toBe(0);
			const current = readlinkSync(command());
			const previous = readlinkSync(join(dirname(command()), "previous"));
			if (failure === "missing asset") rmSync(join(previousDir, "theme/prime.json"));
			if (failure === "broken executable") writeFileSync(join(previousDir, "prime-agent"), "#!/bin/sh\nexit 1\n");
			const result = await install(
				"--rollback",
				failure === "changed previous" ? { PRIME_AGENT_EXPECTED_PREVIOUS: "an older release" } : {},
			);
			expect(result.code, result.output).not.toBe(0);
			expect(readlinkSync(command())).toBe(current);
			expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
			expect(execFileSync(command(), ["--version"], { encoding: "utf8" })).toBe("1.0.1\n");
		},
	);

	it("refuses to replace an unrelated public command", async () => {
		publish("1.0.0");
		mkdirSync(join(home, ".local/bin"), { recursive: true });
		writeFileSync(join(home, ".local/bin/prime-agent"), "owned by another installer");
		const result = await install("1.0.0");
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("refusing to replace existing command");
		expect(existsSync(command())).toBe(false);
	});

	it.each(["../outside", "/tmp/outside", ".", ".."])("rejects a command name containing a path: %s", async (name) => {
		publish("1.0.0");
		const result = await install("1.0.0", { PRIME_AGENT_CMD: name });
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("command name must be a basename");
		expect(existsSync(command())).toBe(false);
		expect(existsSync(join(home, ".local/outside"))).toBe(false);
	});

	it("preserves a public command replaced by another installer during download", async () => {
		publish("1.0.0");
		expect((await install("1.0.0")).code).toBe(0);
		const current = readlinkSync(command());
		const publicCommand = join(home, ".local/bin/prime-agent");
		publish("1.0.1");
		beforeArchiveResponse = () => {
			rmSync(publicCommand);
			writeFileSync(publicCommand, "owned by another installer");
		};
		const result = await install("1.0.1");
		expect(result.code, result.output).not.toBe(0);
		expect(result.output).toContain("refusing to replace existing command");
		expect(readFileSync(publicCommand, "utf8")).toBe("owned by another installer");
		expect(readlinkSync(command())).toBe(current);
	});

	it.each(["", "../releases/an-earlier-install/prime-agent"])(
		"rejects a stale migration expectation (%s)",
		async (expected) => {
			publish("1.0.1");
			publish("1.0.0");
			expect((await install("1.0.1")).code).toBe(0);
			const active = readlinkSync(command());
			const result = await install("1.0.0", { PRIME_AGENT_EXPECTED_CURRENT: expected });
			expect(result.code, result.output).not.toBe(0);
			expect(readlinkSync(command())).toBe(active);
		},
	);

	it("repairs missing assets on reinstall without replacing files used by an existing process", async () => {
		publish("1.0.0");
		expect((await install("1.0.0")).code).toBe(0);
		const previous = readlinkSync(command());
		const oldRelease = dirname(realpathSync(command()));
		rmSync(join(oldRelease, "theme/prime.json"));
		const result = await install("1.0.0");
		expect(result.code, result.output).toBe(0);
		expect(readlinkSync(command())).not.toBe(previous);
		expect(readFileSync(join(dirname(realpathSync(command())), "theme/prime.json"), "utf8")).toBe("fixture\n");
		expect(existsSync(join(oldRelease, "theme/prime.json"))).toBe(false);
		expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
	});

	it("does not steal another installation's lock", async () => {
		publish("1.0.0");
		const first = await install("1.0.0");
		expect(first.code, first.output).toBe(0);
		const lock = join(home, "data/prime-agent/.install-lock");
		mkdirSync(lock);
		writeFileSync(join(lock, "pid"), `${process.pid}\n`);
		const result = await install("1.0.0");
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("installation is locked");
		expect(readFileSync(join(lock, "pid"), "utf8")).toBe(`${process.pid}\n`);
	});

	it("releases its installation lock after a terminal hangup", async () => {
		const harness = join(root, "hangup.sh");
		writeFileSync(
			harness,
			readFileSync(installer, "utf8").replace(
				/\nmain "\$@"\s*$/,
				() => '\nprime_agent_install_traps\nprime_agent_native_prepare_root\nkill -HUP "$$"\n',
			),
		);
		const result = await install("", {}, harness);
		expect(result.code, result.output).toBe(129);
		expect(existsSync(join(home, "data/prime-agent/.install-lock"))).toBe(false);
	});

	it("reports the supported native platform without installation or release discovery", async () => {
		const result = await install("--native-platform", { PRIME_AGENT_DOWNLOAD_BASE_URL: "http://127.0.0.1:1" });
		expect(result).toEqual({ code: 0, output: platform });
		expect(existsSync(join(home, "data/prime-agent"))).toBe(false);
	});

	it.skipIf(!process.env.PRIME_AGENT_TEST_ARCHIVE)(
		"installs, updates, and rolls back actual compiled releases without Node",
		async () => {
			const archive = process.env.PRIME_AGENT_TEST_ARCHIVE!;
			const name = basename(archive);
			const version = name.slice("prime-agent-".length, -`-${platform}.tar.gz`.length);
			feed.set(`/releases/v${version}/${name}`, readFileSync(archive));
			feed.set(`/releases/v${version}/SHA256SUMS`, readFileSync(join(dirname(archive), "SHA256SUMS")));
			const result = await install(version);
			expect(result.code, result.output).toBe(0);
			expect(
				execFileSync(command(), ["--version"], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } }),
			).toBe(`${version}\n`);
			const originalTarget = readlinkSync(command());
			feed.set(
				"/latest.json",
				Buffer.from(
					JSON.stringify({
						version,
						binaries: [
							{ platform, file: name, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex") },
						],
					}),
				),
			);
			const reinstalled = await run(command(), ["update", "--force"]);
			expect(reinstalled.code, reinstalled.output).toBe(0);
			expect(reinstalled.output).not.toContain("Warning:");
			expect(readlinkSync(command())).not.toBe(originalTarget);
			expect(readlinkSync(command())).toMatch(/\.[A-Za-z0-9]{6}\/prime-agent$/);
			const repaired = await run(command(), ["update"]);
			expect(repaired.code, repaired.output).toBe(0);
			expect(repaired.output).toContain("already up to date");
			const previous = readlinkSync(command());
			const source = mkdtempSync(join(root, "real-release-"));
			execFileSync("tar", ["-xzf", archive, "-C", source]);
			const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { version: string };
			metadata.version = "99.0.0";
			writeFileSync(join(source, "package.json"), JSON.stringify(metadata));
			const nextFile = `prime-agent-99.0.0-${platform}.tar.gz`;
			const nextArchive = join(root, nextFile);
			execFileSync("tar", ["-czf", nextArchive, "-C", source, "."]);
			const bytes = readFileSync(nextArchive);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			feed.set(`/releases/v99.0.0/${nextFile}`, bytes);
			feed.set("/releases/v99.0.0/SHA256SUMS", Buffer.from(`${sha256}  ${nextFile}\n`));
			feed.set(
				"/latest.json",
				Buffer.from(JSON.stringify({ version: "v99.0.0", binaries: [{ platform, file: nextFile, sha256 }] })),
			);
			mkdirSync(join(home, "agent"), { recursive: true });
			writeFileSync(join(home, "agent/auth.json"), "{}\n");
			writeFileSync(
				join(home, "extension.ts"),
				readFileSync(resolve(__dirname, "fixtures/compiled-artifact-extension.ts")),
			);
			const session = await run(command(), [
				"--offline",
				"--no-context-files",
				"--no-extensions",
				"-e",
				join(home, "extension.ts"),
				"--provider",
				"artifact-faux",
				"--model",
				"artifact",
				"--no-tools",
				"-p",
				"test update",
			]);
			expect(session.code, session.output).toBe(0);
			expect(session.output).toContain("artifact-ok:");
			expect(await daemonExecutable()).toBe(realpathSync(command()));
			const updated = await run(command(), ["update"]);
			expect(updated.code, updated.output).toBe(0);
			expect(updated.output).toContain("to v99.0.0");
			expect(updated.output).not.toContain("Warning:");
			expect((await run(command(), ["--version"])).output).toBe("99.0.0\n");
			expect(await daemonExecutable()).toBe(realpathSync(command()));
			expect(readlinkSync(join(dirname(command()), "previous"))).toBe(previous);
			const unchanged = await run(command(), ["update"]);
			expect(unchanged.code, unchanged.output).toBe(0);
			expect(unchanged.output).toContain("already up to date");
			feed.clear();
			const restored = await run(command(), ["update", "--rollback"], { PI_OFFLINE: "1" });
			expect(restored.code, restored.output).toBe(0);
			expect(restored.output).not.toContain("Warning:");
			expect(readlinkSync(command())).toBe(previous);
			expect(await daemonExecutable()).toBe(realpathSync(command()));
			expect((await run(command(), ["--version"])).output).toBe(`${version}\n`);
			expect(readFileSync(join(home, "agent/auth.json"), "utf8")).toBe("{}\n");
		},
		120000,
	);
});
