import type { XgkbPluginSettings, SyncScopeEntry, SyncScopeFingerprint } from "./types";
import { normalizeTargetFolderPath } from "./pathSanitize";

export const DATA_SCHEMA_VERSION = 2;

/** 参与 scopeKey 计算的身份字段（不含 syncDirection / autoSyncInterval） */
export function buildScopeFingerprint(settings: XgkbPluginSettings): SyncScopeFingerprint {
	return {
		serverUrl: (settings.serverUrl || "").trim(),
		projectId: (settings.projectId || "").trim(),
		targetFolderName: normalizeTargetFolderPath(settings.targetFolderName) || "Obsidian",
		syncFolder: (settings.syncFolder || "").trim(),
	};
}

function buildScopeMaterial(settings: XgkbPluginSettings): string {
	const fp = buildScopeFingerprint(settings);
	const appKeyPart = settings.appKey.trim()
		? `appKey:${settings.appKey.trim()}`
		: "appKey:";
	const projectPart = fp.projectId || "__personal__";
	return [fp.serverUrl, appKeyPart, projectPart, fp.targetFolderName, fp.syncFolder].join("\0");
}

/** 根据当前设置计算同步作用域 key（SHA-256 hex） */
export async function computeScopeKey(settings: XgkbPluginSettings): Promise<string> {
	const material = buildScopeMaterial(settings);
	const data = new TextEncoder().encode(material);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function formatScopeLabel(fingerprint?: SyncScopeFingerprint): string {
	if (!fingerprint) return "(未知)";
	const proj = fingerprint.projectId || "个人库";
	const folder = fingerprint.targetFolderName || "Obsidian";
	const local = fingerprint.syncFolder || "(整个 Vault)";
	return `target=${folder} projectId=${proj} syncFolder=${local}`;
}

export function isLegacyPersistedData(raw: Record<string, unknown>): boolean {
	const ver = raw.dataSchemaVersion;
	if (typeof ver === "number" && ver >= DATA_SCHEMA_VERSION) return false;
	if (raw.syncScopes && typeof raw.syncScopes === "object") return false;
	if (typeof raw.lastSyncTime === "number") return true;
	if (typeof ver === "number" && ver < DATA_SCHEMA_VERSION) return true;
	return false;
}
