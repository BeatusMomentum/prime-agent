#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readNativeInstallation } from "../utils/native-installation.js";
import { comparePackageVersions } from "../utils/version-check.js";

const entrypoint = fileURLToPath(import.meta.url);
const packageDir = resolve(dirname(entrypoint), "../..");
const args = process.argv.slice(2);

function migrationTarget(): string | undefined {
	if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
	if (process.env.PRIME_AGENT_INSTALL_METHOD === "node") return undefined;
	// Only the public release package in a conventional global npm prefix owns this command.
	const modules = dirname(packageDir);
	if (
		basename(modules) !== "node_modules" ||
		basename(dirname(modules)) !== "lib" ||
		/[/\\]Cellar[/\\]/.test(packageDir)
	)
		return undefined;
	const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
		version: string;
		bin: Record<string, string>;
	};
	const commandName = Object.keys(metadata.bin)[0];
	if (!commandName || basename(commandName) !== commandName) return undefined;
	const publicCommand = join(dirname(dirname(modules)), "bin", commandName);
	const commandIdentity = lstatSync(publicCommand);
	const entryIdentity = statSync(entrypoint);
	const root =
		process.env.PRIME_AGENT_INSTALL_DIR ||
		join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "prime-agent");
	let native = readNativeInstallation(root);
	const ownsPackageLink = realpathSync(publicCommand) === realpathSync(entrypoint);
	if (!ownsPackageLink && (!native || realpathSync(publicCommand) !== native.executable)) return undefined;
	if (!native || (comparePackageVersions(native.version, metadata.version) ?? -1) < 0) {
		if (
			args.includes("--internal-update-restart-coordinator") ||
			args.some((arg, index) => arg === "--mode" && args[index + 1] === "daemon") ||
			process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER ||
			process.env.PRIME_AGENT_INTERNAL_DAEMON_CATALOG
		)
			return undefined;
		if (process.env.PI_OFFLINE || args.includes("--offline")) return undefined;
		const retryFile = join(packageDir, "dist/.native-migration-attempt");
		if (
			existsSync(retryFile) &&
			process.env.PRIME_AGENT_MIGRATE_RETRY !== "1" &&
			Date.now() - Number(readFileSync(retryFile, "utf8")) < 86400000
		)
			return undefined;
		writeFileSync(retryFile, String(Date.now()));
		const release = JSON.parse(readFileSync(join(packageDir, "dist/native-release.json"), "utf8")) as {
			baseUrl: string;
		};
		const result = spawnSync("sh", [join(packageDir, "dist/install.sh"), metadata.version], {
			env: {
				...process.env,
				PRIME_AGENT_INSTALL_METHOD: "binary",
				PRIME_AGENT_INSTALL_DIR: root,
				PRIME_AGENT_EXPECTED_CURRENT: native ? relative(join(native.root, "bin"), native.executable) : "",
				PRIME_AGENT_DOWNLOAD_BASE_URL: release.baseUrl,
				PRIME_AGENT_INSTALL_LINK: "0",
				PRIME_AGENT_INSTALLER_NONINTERACTIVE: "1",
				PRIME_AGENT_INSTALLER_PLAIN: "1",
				PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL: "0",
			},
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 450000,
		});
		if (result.status !== 0) {
			console.error("prime-agent: compiled migration deferred; continuing with the installed Node application.");
			return undefined;
		}
		native = readNativeInstallation(root);
		if (!native || native.version !== metadata.version) return undefined;
	}
	const platform = spawnSync("sh", [join(packageDir, "dist/install.sh"), "--native-platform"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 3000,
	});
	if (platform.status !== 0 || platform.stdout.trim() !== native.platform) return undefined;
	const probe = spawnSync(native.executable, ["--version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 3000,
	});
	if (probe.status !== 0 || probe.stdout.trim() !== native.version) return undefined;
	if (!ownsPackageLink) return native.launcher;
	// Capture the link, then create exclusively so a concurrent npm install cannot be overwritten.
	const staging = mkdtempSync(join(dirname(publicCommand), ".prime-agent-link-"));
	const captured = join(staging, "command");
	let needsRestore = false;
	let capturedOwned = false;
	try {
		renameSync(publicCommand, captured);
		needsRestore = true;
		const capturedIdentity = lstatSync(captured);
		capturedOwned = capturedIdentity.dev === commandIdentity.dev && capturedIdentity.ino === commandIdentity.ino;
		const currentEntry = statSync(entrypoint);
		if (
			!capturedOwned ||
			currentEntry.dev !== entryIdentity.dev ||
			currentEntry.ino !== entryIdentity.ino ||
			currentEntry.mtimeMs !== entryIdentity.mtimeMs ||
			currentEntry.size !== entryIdentity.size
		)
			return undefined;
		symlinkSync(native.launcher, publicCommand);
		needsRestore = false;
		return native.launcher;
	} finally {
		if (needsRestore) {
			try {
				if (lstatSync(captured).isSymbolicLink()) symlinkSync(readlinkSync(captured), publicCommand);
				else linkSync(captured, publicCommand);
				needsRestore = false;
			} catch (error) {
				if (capturedOwned && error instanceof Error && "code" in error && error.code === "EEXIST")
					needsRestore = false;
			}
		}
		if (needsRestore)
			console.error(`prime-agent: command handoff deferred; the displaced command is preserved at ${captured}`);
		else rmSync(staging, { recursive: true, force: true });
	}
}

let target: string | undefined;
try {
	target = migrationTarget();
} catch {
	// Read-only prefixes and package-manager wrappers keep the bundled Node route.
}
const fallback = join(dirname(entrypoint), "cli-node.js");
if (!target && !existsSync(fallback)) throw new Error("Missing Node fallback entrypoint");
const child = spawn(target ?? process.execPath, target ? args : [...process.execArgv, fallback, ...args], {
	stdio: "inherit",
});
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const handlers = signals.map((signal) => {
	const handler = () => {
		child.kill(signal);
	};
	process.on(signal, handler);
	return handler;
});
child.on("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
});
child.on("exit", (code, signal) => {
	for (const [index, name] of signals.entries()) process.removeListener(name, handlers[index]);
	if (signal) process.kill(process.pid, signal);
	else process.exitCode = code ?? 1;
});
