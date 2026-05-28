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
	/** 使用物理文件上传（resourceId → saveFileByPath/updateFileVersion） */
	usePhysicalUpload: boolean;
	/** 物理上传失败时降级 uploadContent */
	uploadContentFallback: boolean;
	/** 要同步的文件扩展名（不含点），至少一种 */
	syncFileExtensions: string[];
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

export interface PendingRemoteRenameOp {
	op: "rename-or-move";
	oldPath: string;
	newPath: string;
	setAt: number;
}

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
	/** 本地 rename/move 后待推送到远端的动作（用于 push/bidirectional 的确定性执行） */
	pendingRemoteOp?: "rename-or-move";
	pendingOldPath?: string;
	pendingNewPath?: string;
	pendingSetAt?: number;
	pendingRemoteOps?: PendingRemoteRenameOp[];
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

export interface SyncPlanTraceItem {
	op: string;
	path: string;
	targetPath?: string;
	remoteOldPath?: string;
	isDirectory?: boolean;
}

export interface SyncExecTraceItem {
	op: string;
	path: string;
	status: "ok" | "failed";
	message?: string;
}

export interface SyncStats {
	uploaded: number;
	downloaded: number;
	deleted: number;
	skipped: number;
	failed: number;
	errors: string[];
	newSince?: number;
	retriedFailed?: number;
	renamed?: number;
	moved?: number;
	planTrace?: SyncPlanTraceItem[];
	execTrace?: SyncExecTraceItem[];
}

/** getDownloadInfo（4.1）响应 */
export interface DownloadInfoVO {
	fileId: string | number;
	downloadUrl?: string;
	previewUrl?: string;
	fileName?: string;
	suffix?: string;
	size?: number;
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

export interface SliceCheckResult {
	sliceId?: number | null;
	uploadUrl?: string | null;
	fullPath?: string | null;
	storageType?: string | null;
}

export interface UploadFileSliceParams {
	filePath: string;
	md5: string;
	size: number;
	storageType: string;
}

export interface SaveResourceParams {
	name: string;
	sliceIds: number[];
	suffix?: string;
	size?: number;
}

export interface SaveFileToProjectParams {
	projectId: string;
	parentId?: string;
	path?: string;
	name: string;
	fileType: string;
	suffix?: string;
	size?: number;
	resourceId: number;
	nameConflictStrategy?: number;
}

export interface UpdateFileVersionParams {
	id: string;
	projectId: string;
	resourceId: number;
	name?: string;
	versionRemark?: string;
	suffix?: string;
	size?: number;
}

export interface UpdateFileNameParams {
	fileId: string;
	newName: string;
	projectId?: string;
	nameConflictStrategy?: 0 | 1;
}

export interface UpdateFileNameResult {
	fileId: string;
	name: string;
	parentId?: string;
	updateTime?: number;
	relativePath?: string;
}

export interface MoveFileParams {
	fileId: string;
	targetParentId: string;
	projectId?: string;
	nameConflictStrategy?: 0 | 1 | 2 | 3;
}

export interface MoveFileResult {
	fileId: string | number;
	sourceFileId: string | number;
	idChanged: boolean;
	name: string;
	parentId: string | number;
	updateTime: number;
	relativePath?: string;
	mainSkipped?: boolean;
	idMappings?: Array<{ sourceFileId: string | number; targetFileId: string | number }>;
}
