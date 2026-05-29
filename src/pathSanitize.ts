/**
 * Windows / Obsidian 不允许路径片段中出现下列字符（与资源管理器规则一致）
 * 云端目录名可能含冒号（如时间 18:42:55），需在映射到 Vault 相对路径时替换。
 */
const ILLEGAL_IN_SEGMENT = /[*"<>:|?\\]/g;

/** 清理单个路径片段（文件名或文件夹名） */
export function sanitizePathSegment(segment: string): string {
	return segment.replace(ILLEGAL_IN_SEGMENT, "-");
}

/** 清理相对路径中的每一段，保留 `/` 分隔符 */
export function sanitizeRelativePath(relativePath: string): string {
	if (!relativePath) return relativePath;
	return relativePath
		.split("/")
		.map((seg) => sanitizePathSegment(seg))
		.join("/");
}

/** 将云端目标目录配置解析为多级路径片段（支持 `A/B`、`\` 与首尾空白） */
export function parseTargetFolderSegments(folderPath: string): string[] {
	return folderPath
		.replace(/\\/g, "/")
		.split("/")
		.map((seg) => seg.trim())
		.filter(Boolean)
		.map((seg) => sanitizePathSegment(seg));
}

/** 规范化后的目标目录字符串（用于 uploadContent 的 folderName 前缀） */
export function normalizeTargetFolderPath(folderPath: string): string {
	return parseTargetFolderSegments(folderPath).join("/");
}

/** 解析 Cloud target folder 配置 */
export function resolveTargetFolderConfig(folderPath: string): {
	relativePath: string;
	syncAtProjectRoot: boolean;
} {
	const relativePath = normalizeTargetFolderPath(folderPath);
	return {
		relativePath,
		syncAtProjectRoot: relativePath.length === 0,
	};
}

/** 设置页 / 诊断展示用 */
export function formatTargetFolderLabel(folderPath: string): string {
	const { relativePath, syncAtProjectRoot } = resolveTargetFolderConfig(folderPath);
	if (syncAtProjectRoot) return "(整个知识库空间根)";
	return relativePath;
}

/** 知识库 API 中表示空间根（parentId=0） */
export function isKbSpaceParentId(parentId: string | number | null | undefined): boolean {
	if (parentId == null || parentId === "") return true;
	const s = String(parentId);
	return s === "0";
}

/** 将 API 返回的 relativePath 规范为插件内相对路径 */
export function normalizeKbRelativePath(relativePath: string): string {
	return relativePath
		.split("/")
		.filter(Boolean)
		.map((seg) => sanitizePathSegment(seg))
		.join("/");
}
