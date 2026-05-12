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
