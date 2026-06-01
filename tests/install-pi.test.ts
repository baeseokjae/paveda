import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installPi, renderPiPolicyExtension, summarizePiInstall } from "../src/install/pi.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Pi installer", () => {
	it("renders a Pi extension that delegates tool calls to Paveda", () => {
		const source = renderPiPolicyExtension("node /opt/paveda/dist/cli.js hook pi");

		expect(source).toContain("BEGIN PAVEDA MANAGED PI POLICY");
		expect(source).toContain('pi.on("tool_call"');
		expect(source).toContain("return { block: true");
		expect(source).toContain("event_name: eventName");
		expect(summarizePiInstall(source).events.every((event) => event.installed)).toBe(true);
	});

	it("writes the managed Pi extension when requested", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-pi-"));
		tempDirs.push(dir);
		const extensionPath = join(dir, ".pi", "extensions", "paveda-policy.ts");

		const result = installPi({
			extensionPath,
			command: "paveda hook pi",
			write: true,
		});

		expect(result.written).toBe(true);
		expect(result.changed).toBe(true);
		expect(readFileSync(extensionPath, "utf8")).toBe(result.extensionSource);
		expect(result.summary).toMatchObject({
			command: "paveda hook pi",
		});
		expect(result.summary.events.every((event) => event.installed)).toBe(true);
	});

	it("refuses to replace an unmanaged Pi extension unless forced", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-pi-existing-"));
		tempDirs.push(dir);
		const extensionPath = join(dir, ".pi", "extensions", "paveda-policy.ts");
		mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
		writeFileSync(extensionPath, "export default function custom() {}\n");

		expect(() => installPi({ extensionPath, write: true })).toThrow(
			"Pi extension already exists without a Paveda managed block",
		);

		const result = installPi({ extensionPath, force: true, write: true });

		expect(readFileSync(extensionPath, "utf8")).toBe(result.extensionSource);
	});

	it("refuses to read or write through symlinked paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-pi-symlink-"));
		tempDirs.push(dir);
		const piDir = join(dir, ".pi", "extensions");
		mkdirSync(piDir, { recursive: true });
		const external = join(dir, "external.ts");
		const linked = join(piDir, "paveda-policy.ts");
		writeFileSync(external, "export default function custom() {}\n");
		symlinkSync(external, linked);

		expect(() => installPi({ extensionPath: linked, write: true })).toThrow(
			"Pi extension path must not use symlinks",
		);
	});
});
