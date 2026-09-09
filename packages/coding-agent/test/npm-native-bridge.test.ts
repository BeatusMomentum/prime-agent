import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;
let home: string;
let pkg: string;
let entry: string;
let publicCommand: string;

function native(version = "1.0.0", suffix = "", platform = `${process.platform}-${process.arch}`) {
	const install = join(home, "data/prime-agent");
	const digest = "a".repeat(64);
	const name = `${version}-${platform}-${digest}${suffix}`;
	const release = join(install, "releases", name);
	mkdirSync(release, { recursive: true });
	mkdirSync(join(install, "bin"), { recursive: true });
	writeFileSync(join(install, ".managed"), "prime-agent-native-v1\n");
	writeFileSync(join(release, ".archive-sha256"), digest);
	writeFileSync(join(release, ".install-source"), "https://example.com");
	writeFileSync(join(release, "package.json"), JSON.stringify({ version }));
	writeFileSync(
		join(release, "prime-agent"),
		`#!/bin/sh\nif [ "$1" = fail ]; then exit 23; fi\nif [ "$1" = --version ]; then echo ${version}; exit; fi\nprintf "native:%s\\n" "$@"\n`,
		{ mode: 0o755 },
	);
	rmSync(join(install, "bin/prime-agent"), { force: true });
	symlinkSync(`../releases/${name}/prime-agent`, join(install, "bin/prime-agent"));
	return realpathSync(join(install, "bin/prime-agent"));
}

async function run(args: string[] = [], extra: NodeJS.ProcessEnv = {}) {
	const child = spawn(process.execPath, [entry, ...args], {
		env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "data"), ...extra },
		cwd: home,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	return await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
		child.on("error", reject);
		child.on("close", (code) => done({ code, stdout, stderr }));
	});
}

describe.skipIf(process.platform === "win32")("npm release bridge", () => {
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "native-bridge-")));
		home = join(root, "home with spaces");
		pkg = join(home, "prefix/lib/node_modules/prime-agent");
		entry = join(pkg, "dist/bundle/cli.js");
		publicCommand = join(home, "prefix/bin/prime-agent");
		mkdirSync(dirname(entry), { recursive: true });
		mkdirSync(dirname(publicCommand), { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({ type: "module", version: "1.0.0", bin: { "prime-agent": "dist/bundle/cli.js" } }),
		);
		for (const [source, target] of [
			["cli/npm-native-bridge", "bundle/cli"],
			["utils/native-installation", "utils/native-installation"],
			["utils/version-check", "utils/version-check"],
			["utils/pi-user-agent", "utils/pi-user-agent"],
		]) {
			const destination = join(pkg, "dist", `${target}.js`);
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(
				destination,
				transformSync(readFileSync(resolve(__dirname, "../src", `${source}.ts`), "utf8"), {
					loader: "ts",
					format: "esm",
				}).code,
			);
		}
		writeFileSync(join(pkg, "dist/bundle/cli-node.js"), 'console.log("node:" + process.argv.slice(2).join("|"));\n');
		writeFileSync(join(pkg, "dist/native-release.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:1" }));
		copyFileSync(resolve(__dirname, "../../../install.sh"), join(pkg, "dist/install.sh"));
		symlinkSync(entry, publicCommand);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("switches the owned command and keeps the historical JS entrypoint on native for restart coordinators", async () => {
		const executable = native();
		expect(await run(["argument with spaces", "--rpc"])).toMatchObject({
			code: 0,
			stdout: "native:argument with spaces\nnative:--rpc\n",
		});
		expect(realpathSync(publicCommand)).toBe(executable);
		expect(await run(["update", "--internal-update-restart-coordinator"])).toMatchObject({
			code: 0,
			stdout: "native:update\nnative:--internal-update-restart-coordinator\n",
		});
		expect(execFileSync(publicCommand, ["--version"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" })).toBe(
			"1.0.0\n",
		);
	});
	it("does not downgrade a newer managed release", async () => {
		native("1.0.1");
		expect(await run(["--version"])).toMatchObject({ code: 0, stdout: "1.0.1\n" });
	});
	it.each(["platform", "unsupported", "broken", "wrong version"])(
		"keeps Node for an incompatible native release: %s",
		async (failure) => {
			const executable = native(
				"1.0.0",
				"",
				failure === "platform"
					? `${process.platform}-${process.arch === "arm64" ? "x64" : "arm64"}`
					: `${process.platform}-${process.arch}`,
			);
			if (failure === "unsupported") writeFileSync(join(pkg, "dist/install.sh"), "#!/bin/sh\nexit 1\n");
			if (failure === "broken") writeFileSync(executable, "#!/bin/sh\nexit 1\n");
			if (failure === "wrong version") writeFileSync(executable, "#!/bin/sh\necho 0.8.0\n");
			expect(await run(["--version"])).toMatchObject({ code: 0, stdout: "node:--version\n" });
			expect(realpathSync(publicCommand)).toBe(entry);
		},
	);

	it.each([
		{ label: "coordinator", args: ["update", "--internal-update-restart-coordinator"], env: {}, previous: undefined },
		{
			label: "coordinator with older native",
			args: ["update", "--internal-update-restart-coordinator"],
			env: {},
			previous: "0.9.0",
		},
		{ label: "daemon", args: ["--mode", "daemon"], env: {}, previous: undefined },
		{ label: "worker", args: [], env: { PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1" }, previous: undefined },
		{ label: "catalog", args: [], env: { PRIME_AGENT_INTERNAL_DAEMON_CATALOG: "1" }, previous: undefined },
	])("does not start migration before $label liveness", async ({ args, env, previous }) => {
		if (previous) native(previous);
		expect(await run(args, env)).toEqual({ code: 0, stdout: `node:${args.join("|")}\n`, stderr: "" });
		expect(existsSync(join(pkg, "dist/.native-migration-attempt"))).toBe(false);
		expect(realpathSync(publicCommand)).toBe(entry);
	});

	it.each(["capture", "create", "package"])(
		"preserves a competing npm installation during command %s",
		async (phase) => {
			native();
			const replacement = join(root, "new-command.js");
			writeFileSync(replacement, "new package command\n");
			const hook = join(root, "race-hook.mjs");
			writeFileSync(
				hook,
				`
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const command = ${JSON.stringify(publicCommand)};
const entry = ${JSON.stringify(entry)};
const replacement = ${JSON.stringify(replacement)};
const phase = ${JSON.stringify(phase)};
const rename = fs.renameSync;
const symlink = fs.symlinkSync;
fs.renameSync = (source, destination) => {
  if (phase !== "create" && (source === command || destination === command)) {
    if (phase === "package") {
      fs.copyFileSync(entry, entry + ".new");
      rename(entry + ".new", entry);
    } else {
      fs.rmSync(command);
      symlink(replacement, command);
    }
  }
  return rename(source, destination);
};
fs.symlinkSync = (target, path) => {
  if (phase === "create" && path === command) symlink(replacement, command);
  return symlink(target, path);
};
syncBuiltinESMExports();
`,
			);
			expect(await run(["--version"], { NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` })).toMatchObject({
				code: 0,
				stdout: "node:--version\n",
			});
			expect(realpathSync(publicCommand)).toBe(phase === "package" ? entry : replacement);
		},
	);
	it.each([undefined, "0.9.0"])("preserves a competing newer install while migrating from %s", async (previous) => {
		await withReleaseFeed(async () => {
			if (previous) native(previous);
			const ready = join(root, "ready");
			const proceed = join(root, "proceed");
			const shim = join(root, "shim");
			mkdirSync(shim);
			writeFileSync(
				join(shim, "sh"),
				'#!/bin/sh\ntouch "$BRIDGE_READY"\nwhile [ ! -e "$BRIDGE_PROCEED" ]; do sleep 0.02; done\nexec /bin/sh "$@"\n',
				{ mode: 0o755 },
			);
			const pending = run(["--version"], {
				PATH: `${shim}:/usr/bin:/bin`,
				BRIDGE_READY: ready,
				BRIDGE_PROCEED: proceed,
			});
			let newer: string | undefined;
			try {
				await expect.poll(() => existsSync(ready), { timeout: 5000 }).toBe(true);
				newer = native("1.0.1");
			} finally {
				writeFileSync(proceed, "");
			}
			expect(await pending).toMatchObject({ code: 0, stdout: "node:--version\n" });
			expect(realpathSync(join(home, "data/prime-agent/bin/prime-agent"))).toBe(newer);
			expect(realpathSync(publicCommand)).toBe(entry);
			expect(await run(["--version"])).toMatchObject({ code: 0, stdout: "1.0.1\n" });
		});
	});

	it("recognizes a fresh reinstall directory", async () => {
		const executable = native("1.0.0", ".AbC123");
		expect(await run(["--version"])).toMatchObject({ code: 0, stdout: "1.0.0\n" });
		expect(realpathSync(publicCommand)).toBe(executable);
	});

	it("downloads and activates through the shipped installer without npm lifecycle scripts", async () => {
		await withReleaseFeed(async (checksum) => {
			expect(await run(["--version"])).toMatchObject({ code: 0, stdout: "1.0.0\n", stderr: "" });
			expect(realpathSync(publicCommand)).toContain(
				`/releases/1.0.0-${process.platform}-${process.arch}-${checksum}/`,
			);
		});
	});

	async function withReleaseFeed(test: (checksum: string) => Promise<void>) {
		const executable = native();
		const release = dirname(executable);
		for (const asset of [
			"install.sh",
			"prime-agent-runtime/pyproject.toml",
			"prime-agent-runtime/src/rlm/repl.py",
			"theme/prime.json",
			"export-html/template.html",
			"photon_rs_bg.wasm",
		]) {
			mkdirSync(dirname(join(release, asset)), { recursive: true });
			writeFileSync(join(release, asset), "fixture");
		}
		const archive = join(root, "archive.tar.gz");
		execFileSync("tar", ["-czf", archive, "-C", release, "."]);
		const bytes = readFileSync(archive);
		const checksum = createHash("sha256").update(bytes).digest("hex");
		const filename = `prime-agent-1.0.0-${process.platform}-${process.arch}.tar.gz`;
		rmSync(join(home, "data"), { recursive: true, force: true });
		const server = createServer((request, response) =>
			response.end(request.url?.endsWith("SHA256SUMS") ? `${checksum}  ${filename}\n` : bytes),
		);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("missing address");
			writeFileSync(
				join(pkg, "dist/native-release.json"),
				JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}` }),
			);
			await test(checksum);
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
		}
	}
	it("preserves the native exit status", async () => {
		native();
		expect((await run(["fail"])).code).toBe(23);
	});
	it.each(["offline", "opt-out", "failed-download"])("keeps Node usable for %s", async (reason) => {
		const result = await run(
			["--version"],
			reason === "offline"
				? { PI_OFFLINE: "1" }
				: reason === "opt-out"
					? { PRIME_AGENT_INSTALL_METHOD: "node" }
					: {},
		);
		expect(result).toMatchObject({ code: 0, stdout: "node:--version\n" });
		expect(realpathSync(publicCommand)).toBe(entry);
		if (reason === "failed-download") {
			expect(result.stderr).toContain("migration deferred");
			expect((await run(["--version"])).stderr).toBe("");
		}
	});
	it("does not replace another command owner", async () => {
		native();
		rmSync(publicCommand);
		writeFileSync(publicCommand, "unrelated");
		expect(await run(["--version"])).toMatchObject({ code: 0, stdout: "node:--version\n" });
		expect(readFileSync(publicCommand, "utf8")).toBe("unrelated");
	});
});
