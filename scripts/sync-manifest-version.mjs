import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, "package.json");
const manifestPath = path.join(rootDir, "manifest.json");

const packageJsonRaw = await readFile(packageJsonPath, "utf8");
const manifestRaw = await readFile(manifestPath, "utf8");

const packageJson = JSON.parse(packageJsonRaw);
const manifest = JSON.parse(manifestRaw);

if (!packageJson.version) {
	throw new Error("package.json is missing version field");
}

manifest.version = packageJson.version;

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Synced manifest version to ${manifest.version}`);
