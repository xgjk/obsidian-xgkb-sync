export interface XgkbPluginSettings {
	appKey: string;
	serverUrl: string;
	syncFolder: string;
	targetFolderName: string;
	syncDirection: "bidirectional" | "push" | "pull";
}

export type SyncStatus = "done" | "failed";

export interface SyncStateRecord {
	localPath: string;         // 主键：相对路径，如 "日常学习/笔记.md"
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
}

export type ProgressCallback = (msg: string) => void;
