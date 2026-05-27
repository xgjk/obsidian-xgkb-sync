/** 插件支持同步的扩展名（不含点） */
export const AVAILABLE_SYNC_EXTENSIONS = ["md", "json", "html"] as const;

export type SyncFileExtension = (typeof AVAILABLE_SYNC_EXTENSIONS)[number];

export function normalizeSyncExtensions(input: unknown): string[] {
	const raw = Array.isArray(input) ? input : ["md"];
	const selected = new Set<string>();
	for (const item of raw) {
		const ext = String(item).trim().toLowerCase().replace(/^\./, "");
		if ((AVAILABLE_SYNC_EXTENSIONS as readonly string[]).includes(ext)) {
			selected.add(ext);
		}
	}
	if (selected.size === 0) return ["md"];
	return AVAILABLE_SYNC_EXTENSIONS.filter((ext) => selected.has(ext));
}

export function extensionOfPath(relativePath: string): string {
	const slash = relativePath.lastIndexOf("/");
	const name = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "";
	return name.slice(dot + 1).toLowerCase();
}

export function pathMatchesSyncExtensions(
	relativePath: string,
	allowed: readonly string[]
): boolean {
	const ext = extensionOfPath(relativePath);
	return ext !== "" && allowed.includes(ext);
}

export function formatSyncExtensionsLabel(allowed: readonly string[]): string {
	return allowed.map((ext) => `.${ext}`).join(", ");
}

export function splitFileNameAndSuffix(fileNameWithExt: string): {
	fileName: string;
	suffix: string;
} {
	const dot = fileNameWithExt.lastIndexOf(".");
	if (dot <= 0 || dot === fileNameWithExt.length - 1) {
		return { fileName: fileNameWithExt, suffix: "md" };
	}
	return {
		fileName: fileNameWithExt.slice(0, dot),
		suffix: fileNameWithExt.slice(dot + 1).toLowerCase(),
	};
}
