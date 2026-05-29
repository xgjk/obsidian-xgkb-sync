import { requestUrl, type RequestUrlParam } from "obsidian";
import type {
	XgkbFileVO,
	UploadContentResult,
	UpdateFileResult,
	Result,
	FileContentVO,
	BatchGetContentFileRef,
	DownloadInfoVO,
	MoveFileParams,
	MoveFileResult,
	SaveFileToProjectParams,
	SaveResourceParams,
	SliceCheckResult,
	UpdateFileNameParams,
	UpdateFileNameResult,
	UpdateFileVersionParams,
	UploadFileSliceParams,
	XgkbListDescendantFilesData,
	XgkbListChangesData,
	XgkbMetaItem,
} from "./types";
import { API_PATHS, MAX_RETRIES, RETRY_BASE_DELAY_MS } from "./constants";

interface XgkbApiResponse<T> {
	resultCode: number;
	resultMsg?: string;
	data: T;
}

/**
 * XGKB API 客户端
 *
 * 核心策略（官方最佳实践 2026-05-03）：
 * - 纯文本新建/更新：一律使用 uploadContent 轻量高速通道
 * - 更新已有文件：uploadContent + updateFileId
 * - 读取内容：getFullFileContent（双写缓存已跑通，所写即所读）
 */
export class XgkbApi {
	private serverUrl: string;
	private appKey: string;

	constructor(serverUrl: string, appKey: string) {
		this.serverUrl = serverUrl.endsWith("/") ? serverUrl : serverUrl + "/";
		this.appKey = appKey;
	}

	private async delay(ms: number): Promise<void> {
		return new Promise((resolve) => window.setTimeout(resolve, ms));
	}

	private async request<T>(
		method: "GET" | "POST",
		apiPath: string,
		params?: Record<string, unknown>
	): Promise<Result<T>> {
		const baseUrl = this.serverUrl + apiPath;
		const options: RequestUrlParam = {
			url: baseUrl,
			method,
			headers: {
				"Content-Type": "application/json",
				appKey: this.appKey,
			},
		};

		if (method === "GET" && params) {
			const qs = Object.entries(params)
				.filter(([, v]) => v !== undefined && v !== null)
				.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
				.join("&");
			options.url = qs ? `${baseUrl}?${qs}` : baseUrl;
		} else if (method === "POST" && params) {
			options.url = baseUrl;
			options.body = JSON.stringify(params);
		} else {
			options.url = baseUrl;
		}

		let lastError = "";
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				if (attempt > 0) await this.delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
				const resp = await requestUrl(options);
				const result = resp.json as unknown as XgkbApiResponse<T>;
				if (result.resultCode !== 1) {
					// 401 认证失败，不重试
					if (result.resultCode === 401) {
						return { ok: false, error: `认证失败(401): ${result.resultMsg ?? "Unknown error"}` };
					}
					return { ok: false, error: `API error ${result.resultCode}: ${result.resultMsg ?? "Unknown error"}` };
				}
				return { ok: true, value: result.data };
			} catch (e: unknown) {
				lastError = e instanceof Error ? e.message : String(e);
			}
		}
		return { ok: false, error: `请求失败(重试${MAX_RETRIES}次): ${lastError}` };
	}

	// ==================== 空间/目录 ====================

	/** 获取个人知识库空间 ID */
	async getPersonalProjectId(): Promise<Result<string>> {
		const r = await this.request<number>("GET", API_PATHS.getPersonalProjectId);
		if (!r.ok) return r;
		return { ok: true, value: String(r.value) };
	}

	/** 配置的空间 ID 优先，否则回退个人知识库 */
	async resolveProjectId(configured?: string): Promise<Result<string>> {
		const trimmed = configured?.trim();
		if (trimmed) return { ok: true, value: trimmed };
		return this.getPersonalProjectId();
	}

	/** 获取一级目录 */
	async getLevel1Folders(projectId: string): Promise<Result<XgkbFileVO[]>> {
		return this.request<XgkbFileVO[]>("GET", API_PATHS.getLevel1Folders, { projectId });
	}

	/** 浏览子目录/文件 */
	async getChildFiles(parentId: string, type?: number): Promise<Result<XgkbFileVO[]>> {
		const params: Record<string, unknown> = { parentId };
		if (type !== undefined) params.type = type;
		return this.request<XgkbFileVO[]>("GET", API_PATHS.getChildFiles, params);
	}

	/** 子树扁平列举（4.21） */
	async listDescendantFiles(params: {
		rootFileId: string;
		projectId?: string;
		suffix?: string;
		cursor?: string;
		limit?: number;
		includePath?: boolean;
	}): Promise<Result<XgkbListDescendantFilesData>> {
		return this.request<XgkbListDescendantFilesData>("GET", API_PATHS.listDescendantFiles, params);
	}

	/** 增量变更列表（4.22） */
	async listChanges(params: {
		projectId?: string;
		rootFileId?: string;
		since?: number;
		cursor?: string;
		limit?: number;
		includePath?: boolean;
	}): Promise<Result<XgkbListChangesData>> {
		return this.request<XgkbListChangesData>("GET", API_PATHS.listChanges, params);
	}

	/** 搜索文件 */
	async searchFile(nameKey: string): Promise<Result<XgkbFileVO[]>> {
		const r = await this.request<{ folders: XgkbFileVO[]; files: XgkbFileVO[] }>(
			"GET", API_PATHS.searchFile, { nameKey }
		);
		if (!r.ok) return r;
		return { ok: true, value: r.value.files || [] };
	}

	// ==================== 文件内容 ====================

	/**
	 * 获取下载凭据（4.1）。forceDownload=true 时返回 OSS downloadUrl，客户端直链拉原文。
	 * @see https://github.com/xgjk/dev-guide/blob/main/02.%E4%BA%A7%E5%93%81%E4%B8%9A%E5%8A%A1AI%E6%96%87%E6%A1%A3/%E7%9F%A5%E8%AF%86%E5%BA%93/API%E6%8E%A5%E5%8F%A3%E6%98%8E%E7%BB%86_v2/04-UI%E7%BB%88%E7%AB%AF%E9%A2%84%E8%A7%88%E4%B8%8E%E9%98%85%E8%AF%BB.md
	 */
	async getDownloadInfo(fileId: string, forceDownload = true): Promise<Result<DownloadInfoVO>> {
		return this.request<DownloadInfoVO>("GET", API_PATHS.getDownloadInfo, {
			fileId,
			forceDownload,
		});
	}

	/** 读取文件全文（所写即所读，双写缓存已跑通） */
	async getFullFileContent(fileId: string): Promise<Result<string>> {
		return this.request<string>("GET", API_PATHS.getFullFileContent, { fileId });
	}

	/**
	 * 批量获取多个文件的提纯全文（4.15）
	 * 不限于个人空间，凭 fileId 与 appKey 权限拉取；建议单次 ≤10 个文件。
	 */
	async batchGetContent(files: BatchGetContentFileRef[]): Promise<Result<FileContentVO[]>> {
		return this.request<FileContentVO[]>("POST", API_PATHS.batchGetContent, { files });
	}

	/** 批量元数据（4.23） */
	async batchGetMeta(
		fileIds: string[],
		projectId?: string,
		opts?: { includePath?: boolean; rootFileId?: string }
	): Promise<Result<XgkbMetaItem[]>> {
		return this.request<XgkbMetaItem[]>("POST", API_PATHS.batchGetMeta, {
			fileIds,
			projectId,
			...(opts?.includePath !== undefined && { includePath: opts.includePath }),
			...(opts?.rootFileId !== undefined && { rootFileId: opts.rootFileId }),
		});
	}

	/**
	 * 上传/更新文件（轻量高速通道）
	 *
	 * 新建模式：不传 updateFileId
	 * 更新模式：传 updateFileId → 自动创建新版本
	 */
	async uploadContent(params: {
		content: string;
		fileName: string;
		fileSuffix?: string;
		folderName?: string;
		projectId?: string;
		updateFileId?: string;
		versionRemark?: string;
	}): Promise<Result<UploadContentResult | UpdateFileResult>> {
		return this.request<UploadContentResult | UpdateFileResult>(
			"POST", API_PATHS.uploadContent, params
		);
	}

	/** 删除文件 */
	async deleteFile(fileId: string): Promise<Result<boolean>> {
		const r = await this.request<boolean>("POST", API_PATHS.deleteFile, { fileId });
		if (!r.ok) return r;
		return { ok: true, value: true };
	}

	// ==================== 分片上传 ====================

	async getSliceIdByMd5V2(md5: string, size: number, suffix?: string): Promise<Result<SliceCheckResult>> {
		const params: Record<string, unknown> = { md5, size };
		if (suffix) params.suffix = suffix;
		return this.request<SliceCheckResult>("GET", API_PATHS.getSliceIdByMd5V2, params);
	}

	async uploadFileSliceV2(params: UploadFileSliceParams): Promise<Result<number>> {
		return this.request<number>("POST", API_PATHS.uploadFileSliceV2, { ...params });
	}

	async saveResource(params: SaveResourceParams): Promise<Result<number>> {
		return this.request<number>("POST", API_PATHS.saveResource, { ...params });
	}

	// ==================== 物理文件入库 ====================

	async saveFileByPath(params: SaveFileToProjectParams): Promise<Result<number>> {
		return this.request<number>("POST", API_PATHS.saveFileByPath, { ...params });
	}

	async updateFileVersion(params: UpdateFileVersionParams): Promise<Result<number>> {
		return this.request<number>("POST", API_PATHS.updateFileVersion, { ...params });
	}

	async updateFileName(params: UpdateFileNameParams): Promise<Result<UpdateFileNameResult>> {
		return this.request<UpdateFileNameResult>("POST", API_PATHS.updateFileName, {
			fileId: params.fileId,
			newName: params.newName,
			...(params.projectId !== undefined && { projectId: params.projectId }),
			...(params.nameConflictStrategy !== undefined && {
				nameConflictStrategy: params.nameConflictStrategy,
			}),
			...(params.rootFileId !== undefined && { rootFileId: params.rootFileId }),
		});
	}

	async moveFile(params: MoveFileParams): Promise<Result<MoveFileResult>> {
		return this.request<MoveFileResult>("POST", API_PATHS.moveFile, {
			fileId: params.fileId,
			targetParentId: params.targetParentId,
			...(params.projectId !== undefined && { projectId: params.projectId }),
			...(params.nameConflictStrategy !== undefined && {
				nameConflictStrategy: params.nameConflictStrategy,
			}),
			...(params.rootFileId !== undefined && { rootFileId: params.rootFileId }),
		});
	}

	/** 显式创建空目录（4.24） */
	async createFolder(params: {
		projectId: string;
		parentId: string;
		name: string;
		cover?: boolean;
		autoRename?: boolean;
	}): Promise<Result<string>> {
		const r = await this.request<string | number>("POST", API_PATHS.createFolder, params);
		if (!r.ok) return r;
		return { ok: true, value: String(r.value) };
	}

	/** 获取版本列表（调试用） */
	async getVersionList(fileId: string): Promise<Result<unknown[]>> {
		return this.request<unknown[]>("GET", API_PATHS.getVersionList, { fileId });
	}
}
