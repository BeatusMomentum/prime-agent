import { accessSync, constants } from "node:fs";
import { join, relative } from "node:path";
import { APP_NAME, type SelfUpdateCommand } from "../config.js";
import { getNativeInstallation, readNativeInstallation } from "../utils/native-installation.js";
import { getLatestPiRelease, isNewerPackageVersion } from "../utils/version-check.js";

export interface NativeUpdatePlan {
	command?: SelfUpdateCommand;
	targetVersion: string;
}

export async function getNativeUpdatePlan(options: {
	force: boolean;
	rollback: boolean;
	executable?: string;
}): Promise<NativeUpdatePlan> {
	const installation = getNativeInstallation(options.executable);
	if (!installation)
		throw new Error(
			"This compiled application is not owned by the Prime Agent installer. Update it using its original installer.",
		);
	accessSync(installation.root, constants.W_OK);
	accessSync(join(installation.root, "bin"), constants.W_OK);
	let version: string;
	let checksum: string | undefined;
	let previousTarget: string | undefined;
	const baseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL?.trim() || installation.baseUrl;
	if (options.rollback) {
		const previous = readNativeInstallation(installation.root, "previous");
		if (!previous || previous.executable === installation.executable)
			throw new Error("No valid previous compiled release is available.");
		version = previous.version;
		previousTarget = relative(join(installation.root, "bin"), previous.executable);
	} else {
		const release = await getLatestPiRelease(installation.version, { baseUrl });
		if (!release || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version))
			throw new Error("Could not resolve a compiled release. The installed version was kept.");
		if (!options.force && !isNewerPackageVersion(release.version, installation.version))
			return { targetVersion: installation.version };
		const artifact = release.binaries?.find((entry) => entry.platform === installation.platform);
		if (!artifact) throw new Error(`No verified compiled archive is available for ${installation.platform}.`);
		version = release.version;
		checksum = artifact.sha256;
	}
	const environment = {
		PRIME_AGENT_INSTALL_METHOD: "binary",
		PRIME_AGENT_INSTALL_DIR: installation.root,
		PRIME_AGENT_DOWNLOAD_BASE_URL: baseUrl,
		PRIME_AGENT_INSTALL_LINK: "0",
		PRIME_AGENT_INSTALLER_NONINTERACTIVE: "1",
		PRIME_AGENT_INSTALLER_PLAIN: "1",
		PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL: "0",
		PRIME_AGENT_EXPECTED_CURRENT: relative(join(installation.root, "bin"), installation.executable),
		...(previousTarget ? { PRIME_AGENT_EXPECTED_PREVIOUS: previousTarget } : {}),
		...(checksum ? { PRIME_AGENT_EXPECTED_SHA256: checksum } : {}),
	};
	return {
		targetVersion: version,
		command: {
			command: "/usr/bin/env",
			args: [
				...Object.entries(environment).map(([name, value]) => `${name}=${value}`),
				"sh",
				join(installation.releaseDir, "install.sh"),
				options.rollback ? "--rollback" : version,
			],
			display: `${APP_NAME} update${options.rollback ? " --rollback" : options.force ? " --force" : ""}`,
		},
	};
}
