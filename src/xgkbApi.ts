import { requestUrl, type RequestUrlParam } from "obsidian";
import type { XgkbFileVO, UploadContentResult, UpdateFileResult, Result } from "./types";
import { API_PATHS, MAX_RETRIES, RETRY_BASE_DELAY_MS } from "./constants";

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
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private async request<T>(
		method: "GET" | "POST",
		apiPath: string,
		params?: Record<string, unknown>
	): Promise<Result<T>> {
		const baseUrl = this.serverUrl + apiPath;
		const options: RequestUrlParam = {
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
				const result = resp.json;
				if (result.resultCode !== 1) {
					// 401 认证失败，不重试
					if (result.resultCode === 401) {
						return { ok: false, error: `认证失败(401): ${result.resultMsg}` };
					}
					return { ok: false, error: `API error ${result.resultCode}: ${result.resultMsg}` };
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

	/** 搜索文件 */
	async searchFile(nameKey: string): Promise<Result<XgkbFileVO[]>> {
		const r = await this.request<{ folders: XgkbFileVO[]; files: XgkbFileVO[] }>(
			"GET", API_PATHS.searchFile, { nameKey }
		);
		if (!r.ok) return r;
		return { ok: true, value: r.value.files || [] };
	}

	// ==================== 文件内容 ====================

	/** 读取文件全文（所写即所读，双写缓存已跑通） */
	async getFullFileContent(fileId: string): Promise<Result<string>> {
		return this.request<string>("GET", API_PATHS.getFullFileContent, { fileId });
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

	/** 获取版本列表（调试用） */
	async getVersionList(fileId: string): Promise<Result<unknown[]>> {
		return this.request<unknown[]>("GET", API_PATHS.getVersionList, { fileId });
	}
}
