import type { XgkbPluginSettings } from "./types";

export const DEFAULT_SETTINGS: XgkbPluginSettings = {
	appKey: "",
	serverUrl: "https://sg-al-cwork-web.mediportal.com.cn/open-api/",
	projectId: "",
	syncFolder: "",   // 空=同步整个 Vault
	targetFolderName: "Obsidian",
	syncDirection: "bidirectional",
	autoSyncInterval: 0,
	usePhysicalUpload: true,
	uploadContentFallback: true,
	syncFileExtensions: ["md"],
	/** Pull/双向：默认仅「云端已确认删除」才删本地 */
	protectLocalDelete: true,
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
	updateFileName: "document-database/file/updateFileName",
	moveFile: "document-database/file/moveFile",
	getSliceIdByMd5V2: "document-database/file/getSliceIdByMd5V2",
	uploadFileSliceV2: "document-database/file/uploadFileSliceV2",
	saveResource: "document-database/file/saveResource",
	saveFileByPath: "document-database/file/saveFileByPath",
	updateFileVersion: "document-database/file/updateFileVersion",
	searchFile: "document-database/file/searchFile",
	getLevel1Folders: "document-database/file/getLevel1Folders",
	deleteFile: "document-database/file/deleteFile",
	getVersionList: "document-database/file/getVersionList",
	getPersonalProjectId: "document-database/project/personal/getProjectId",
	getProjectList: "document-database/project/list",
	/** 见《03-AI与纯文本高速通道》4.15，建议单次不超过 10 个文件 */
	batchGetContent: "document-database/ai/batchGetContent",
} as const;

/** batchGetContent 单次请求最大文件数（与官方文档一致，已弃用为主下载路径） */
export const BATCH_GET_CONTENT_MAX = 10;

/** OSS 直链下载并发数 */
export const DOWNLOAD_CONCURRENCY = 3;

/** 物理上传并发数（Obsidian 保守默认） */
export const UPLOAD_CONCURRENCY = 2;

/** 上传/下载批间 pause（毫秒） */
export const EXECUTE_BATCH_PAUSE_MS = 200;

/** 分片大小 5MB（与 MinIO 要求一致） */
export const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;

export const VERSION_REMARK = "XGKB Sync plugin update";

/** updateFileName 冲突：1=抛异常 */
export const DEFAULT_RENAME_NAME_CONFLICT_STRATEGY = 1;

/** moveFile 冲突：0=自动重命名（跨目录移动时比 SKIP 更可预期） */
export const DEFAULT_MOVE_NAME_CONFLICT_STRATEGY = 0;

/** 目录级 rename/move 聚合：同前缀变更覆盖率阈值 */
export const DIR_RENAME_COVERAGE_RATIO = 0.8;

/** 目录级 rename/move 最少文件数（低于此仍逐文件处理） */
export const DIR_RENAME_MIN_FILES = 2;

/** batchGetMeta 单次请求最大文件数 */
export const BATCH_GET_META_MAX = 50;

/** listChanges 安全回拨窗口（毫秒）：since 往前多看 5 秒，防时钟偏差漏变更 */
export const CHANGES_SAFETY_WINDOW_MS = 5000;

export const DB_NAME = "xgkb-sync-state";
export const DB_VERSION = 2;
export const DB_STORE_NAME = "syncState";

export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1000;
export const REQUEST_DELAY_MS = 200;
export const MTIME_TOLERANCE_MS = 1000;

/** 清理 getFullFileContent 返回的尾部 "Page X of Y" 标记 */
export function cleanContent(raw: string | null | undefined): string {
	if (raw == null) return "";
	return raw.replace(/\n*Page \d+ of \d+\s*$/, "").trimEnd() + "\n";
}

/** 知识库节点 type：1=目录 2=文件 */
export const XGKB_NODE_FOLDER = 1;
export const XGKB_NODE_FILE = 2;

/** 云端映射根 = 知识库空间根（parentId=0）时 listDescendantFiles / listChanges 的 rootFileId */
export const KB_PROJECT_ROOT_FILE_ID = "0";
