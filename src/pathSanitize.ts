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
