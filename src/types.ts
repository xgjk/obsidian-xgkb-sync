export interface XgkbPluginSettings {
	appKey: string;
	serverUrl: string;
	/** 知识库空间 ID；不填则使用当前用户的个人知识库 */
	projectId: string;
	syncFolder: string;
	targetFolderName: string;
	syncDirection: "bidirectional" | "push" | "pull";
	/** 自动同步间隔（分钟），0 = 关闭 */
	autoSyncInterval: number;
}

/** 同步作用域身份快照（用于展示与持久化） */
export interface SyncScopeFingerprint {
	serverUrl: string;
	projectId: string;
	targetFolderName: string;
	syncFolder: string;
}

/** 单个同步作用域的运行时状态（按 scopeKey 隔离水位） */
export interface SyncScopeEntry {
	lastSyncTime?: number;
	rootFileId?: string;
	lastSuccessAt?: number;
	fingerprint?: SyncScopeFingerprint;
}

export type SyncStatus = "done" | "failed";

export interface SyncStateRecord {
	scopeKey: string;          // 复合主键之一：同步作用域
	localPath: string;         // 复合主键之一：相对路径，如 "日常学习/笔记.md"
	xgkbFileId: string;        // 玄关文件 ID（统一 string）
	xgkbFolderId: string;      // 玄关父文件夹 ID
	localMtime: number;        // 上次同步后的本地 mtime（毫秒）
	remoteMtime: number;       // 上次同步后的云端 mtime（毫秒）
	syncStatus: SyncStatus;
	lastSyncAt: number;        // 上次同步时间戳
	lastError?: string;
}

/** 本地文件条目 */
export interface FileEntry {
	path: string;              // 相对路径（如 "日常学习/笔记.md"）
	name: string;              // 文件名（如 "笔记.md"）
	mtime: number;             // 修改时间（毫秒）
	size?: number;
	xgkbFileId?: string;       // 云端文件 ID（有则表示已同步过）
	xgkbFolderId?: string;
}

/** 云端文件/文件夹对象
 * type: 1 = folder, 2 = file
 * id/parentId 统一为 string */
export interface XgkbFileVO {
	id: string;
	name: string;
	type: number;              // 1=folder, 2=file
	parentId: string;
	suffix?: string | null;
	size?: number | null;
	hasChild?: boolean;
	createTime?: number;
	updateTime?: number;
	fileType?: string;
	relativePath?: string;
}

export interface XgkbListDescendantFileItem {
	fileId: string | number;
	parentId: string | number;
	name: string;
	updateTime?: number;
	size?: number;
	relativePath?: string;
}

export interface XgkbListDescendantFilesData {
	files: XgkbListDescendantFileItem[];
	nextCursor?: string | null;
}

export interface XgkbChangeItem {
	fileId: string | number;
	parentId?: string | number;
	type?: number;
	name?: string;
	updateTime?: number;
	event: "upsert" | "delete" | (string & Record<never, never>);
}

export interface XgkbListChangesData {
	items: XgkbChangeItem[];
	nextCursor?: string | null;
	serverTime?: number;
}

export interface XgkbMetaItem {
	fileId: string | number;
	parentId?: string | number;
	name?: string;
	updateTime?: number;
	size?: number;
	deleted?: boolean;
}

/** uploadContent 新建模式返回 */
export interface UploadContentResult {
	projectId: string;
	projectName: string;
	folderId: string;
	folderName: string;
	fileId: string;
	fileName: string;
	downloadUrl?: string;
}

/** uploadContent 更新模式返回 */
export interface UpdateFileResult {
	fileId: string;
	fileName: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SyncStats {
	uploaded: number;
	downloaded: number;
	deleted: number;
	skipped: number;
	failed: number;
	errors: string[];
	/** 本轮同步结束后推荐的下次 since 水位（毫秒时间戳），由引擎写入，main 持久化 */
	newSince?: number;
}

export type ProgressCallback = (msg: string) => void;

/** batchGetContent（4.15）请求项 */
export interface BatchGetContentFileRef {
	fileId: string;
	relationId?: string;
	fileType?: string;
}

/** batchGetContent 单项响应（文档 FileContentVO） */
export interface FileContentVO {
	fileId: string | number;
	content: string | null;
	status: string;
	message?: string | null;
}
