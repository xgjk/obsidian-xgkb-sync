import type { XgkbPluginSettings } from "./types";

export const DEFAULT_SETTINGS: XgkbPluginSettings = {
	appKey: "",
	serverUrl: "https://sg-al-cwork-web.mediportal.com.cn/open-api/",
	projectId: "",
	syncFolder: "",   // 空=同步整个 Vault
	targetFolderName: "Obsidian",
	syncDirection: "bidirectional",
	autoSyncInterval: 0, // 默认关闭
};

export const API_PATHS = {
	getChildFiles: "document-database/file/getChildFiles",
	listDescendantFiles: "document-database/file/listDescendantFiles",
	listChanges: "document-database/file/listChanges",
	batchGetMeta: "document-database/file/batchGetMeta",
	createFolder: "document-database/file/createFolder",
	getDownloadInfo: "document-database/file/getDownloadInfo",
	getFileContent: "document-database/file/getFileContent",
	getFullFileContent: "document-database/file/getFullFileContent",
	uploadContent: "document-database/file/uploadContent",
	searchFile: "document-database/file/searchFile",
	getLevel1Folders: "document-database/file/getLevel1Folders",
	deleteFile: "document-database/file/deleteFile",
	getVersionList: "document-database/file/getVersionList",
	getPersonalProjectId: "document-database/project/personal/getProjectId",
	getProjectList: "document-database/project/list",
	/** 见《03-AI与纯文本高速通道》4.15，建议单次不超过 10 个文件 */
	batchGetContent: "document-database/ai/batchGetContent",
} as const;

/** batchGetContent 单次请求最大文件数（与官方文档一致） */
export const BATCH_GET_CONTENT_MAX = 10;

/** batchGetMeta 单次请求最大文件数 */
export const BATCH_GET_META_MAX = 50;

/** listChanges 安全回拨窗口（毫秒）：since 往前多看 5 秒，防时钟偏差漏变更 */
export const CHANGES_SAFETY_WINDOW_MS = 5000;

export const DB_NAME = "xgkb-sync-state";
export const DB_VERSION = 1;
export const DB_STORE_NAME = "syncState";

export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1000;
export const REQUEST_DELAY_MS = 200;
export const MTIME_TOLERANCE_MS = 1000;

/** 清理 getFullFileContent 返回的尾部 "Page X of Y" 标记 */
export function cleanContent(raw: string): string {
	return raw.replace(/\n*Page \d+ of \d+\s*$/, "").trimEnd() + "\n";
}
