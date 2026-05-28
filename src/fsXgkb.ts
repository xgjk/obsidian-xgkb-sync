import { XgkbApi } from "./xgkbApi";
import { FileUploader } from "./fileUploader";
import type { FileEntry, Result, XgkbChangeItem, XgkbMetaItem, MoveFileResult } from "./types";
import {
	BATCH_GET_META_MAX,
	DEFAULT_MOVE_NAME_CONFLICT_STRATEGY,
	DEFAULT_RENAME_NAME_CONFLICT_STRATEGY,
	MAX_RETRIES,
	RETRY_BASE_DELAY_MS,
	cleanContent,
} from "./constants";
import { normalizeTargetFolderPath, parseTargetFolderSegments, sanitizePathSegment } from "./pathSanitize";
import { pathMatchesSyncExtensions, splitFileNameAndSuffix } from "./syncFileTypes";

/**
 * 云端文件系统操作（XGKB API 封装）
 */
export class FsXgkb {
	private rootId: string | null = null;
	private projectId: string | null = null;
	private readonly targetFolderPath: string;
	private readonly uploader: FileUploader;
	private readonly syncExtensions: readonly string[];

	constructor(
		private api: XgkbApi,
		targetFolderName: string,
		private configuredProjectId?: string,
		private uploadOpts: { usePhysicalUpload: boolean; uploadContentFallback: boolean } = {
			usePhysicalUpload: true,
			uploadContentFallback: true,
		},
		syncExtensions: readonly string[] = ["md"]
	) {
		this.targetFolderPath = normalizeTargetFolderPath(targetFolderName) || "Obsidian";
		this.uploader = new FileUploader(api);
		this.syncExtensions = syncExtensions;
	}

	getRootId(): string | null {
		return this.rootId;
	}

	getProjectId(): string | null {
		return this.projectId;
	}

	/**
	 * 初始化：获取 Obsidian 文件夹 ID
	 * 如果不存在，使用 createFolder 显式创建
	 */
	async init(): Promise<Result<string>> {
		// 1. 获取 projectId（配置优先，否则个人知识库）
		const projectResult = await this.api.resolveProjectId(this.configuredProjectId);
		if (!projectResult.ok) {
			return { ok: false, error: `获取 projectId 失败: ${projectResult.error}` };
		}
		const projectId = projectResult.value;
		this.projectId = projectId;
		const source = this.configuredProjectId?.trim() ? "配置" : "个人知识库";
		console.debug(`[XGKB Sync] init: projectId=${projectId} (${source})`);

		// 2. 解析/创建多级目标目录（如 A/B）
		const resolveResult = await this.resolveFolderIdFromPath(projectId, this.targetFolderPath);
		if (!resolveResult.ok) {
			return { ok: false, error: resolveResult.error };
		}
		this.rootId = resolveResult.value;
		console.debug(`[XGKB Sync] init: 同步根目录 "${this.targetFolderPath}" rootId=${this.rootId}`);
		return { ok: true, value: this.rootId };
	}

	/**
	 * 将逻辑目录路径解析为 folderId；缺失的各级目录会逐级 createFolder。
	 * @param folderPath 如 `Obsidian` 或 `A/B`
	 */
	private async resolveFolderIdFromPath(
		projectId: string,
		folderPath: string
	): Promise<Result<string>> {
		const segments = parseTargetFolderSegments(folderPath);
		if (segments.length === 0) {
			return { ok: false, error: "云端目标目录路径不能为空" };
		}

		const level1Result = await this.api.getLevel1Folders(projectId);
		if (!level1Result.ok) {
			return { ok: false, error: `获取目录列表失败: ${level1Result.error}` };
		}

		const folders = level1Result.value || [];
		const firstSeg = segments[0];
		let firstFolder = folders.find((f) => f.name === firstSeg && f.type === 1);

		if (!firstFolder) {
			console.debug(`[XGKB Sync] 一级目录 "${firstSeg}" 不存在，正在创建...`);
			const createResult = await this.api.createFolder({
				projectId,
				parentId: "0",
				name: firstSeg,
			});
			if (!createResult.ok) {
				return { ok: false, error: `创建目录 "${firstSeg}" 失败: ${createResult.error}` };
			}
			firstFolder = { id: createResult.value, name: firstSeg, type: 1, parentId: "0" };
		}

		let currentId = firstFolder.id;

		for (let i = 1; i < segments.length; i++) {
			const seg = segments[i];
			const childResult = await this.api.getChildFiles(currentId, 1);
			if (!childResult.ok) {
				return {
					ok: false,
					error: `获取子目录失败(parentId=${currentId}): ${childResult.error}`,
				};
			}

			const children = childResult.value || [];
			const found = children.find((f) => f.name === seg && f.type === 1);
			if (!found) {
				const parentPath = segments.slice(0, i).join("/");
				console.debug(`[XGKB Sync] 目录 "${parentPath}" 下无 "${seg}"，正在创建...`);
				const createResult = await this.api.createFolder({
					projectId,
					parentId: currentId,
					name: seg,
				});
				if (!createResult.ok) {
					return {
						ok: false,
						error: `创建目录 "${seg}"（位于 ${parentPath}）失败: ${createResult.error}`,
					};
				}
				currentId = createResult.value;
			} else {
				currentId = found.id;
			}
		}

		return { ok: true, value: currentId };
	}

	/**
	 * 通过 4.21 扁平列举同步根目录下已选类型的文件
	 */
	async listFiles(): Promise<Result<FileEntry[]>> {
		if (!this.rootId) return { ok: false, error: "未初始化" };
		const entries: FileEntry[] = [];
		const seen = new Set<string>();

		for (const suffix of this.syncExtensions) {
			let cursor: string | undefined;
			let page = 0;
			do {
				page++;
				const r = await this.api.listDescendantFiles({
					rootFileId: this.rootId,
					projectId: this.projectId || undefined,
					suffix,
					limit: 500,
					cursor,
					includePath: true,
				});
				if (!r.ok) return { ok: false, error: r.error };
				const pageItems = r.value.files || [];
				console.debug(
					`[XGKB Sync] listDescendantFiles(.${suffix}) 第${page}页: 返回 ${pageItems.length} 条，nextCursor=${r.value.nextCursor ?? "null"}`
				);
				for (const item of pageItems) {
					const rawPath = item.relativePath || item.name;
					const safePath = rawPath
						.split("/")
						.filter(Boolean)
						.map((seg) => sanitizePathSegment(seg))
						.join("/");
					if (!pathMatchesSyncExtensions(safePath, this.syncExtensions)) continue;
					if (seen.has(safePath)) continue;
					seen.add(safePath);
					entries.push({
						path: safePath,
						name: item.name,
						mtime: item.updateTime || 0,
						size: item.size,
						xgkbFileId: String(item.fileId),
						xgkbFolderId: item.parentId != null ? String(item.parentId) : "",
					});
				}
				cursor = r.value.nextCursor || undefined;
			} while (cursor);
		}

		console.debug(
			`[XGKB Sync] listDescendantFiles 完成: 共 ${entries.length} 个文件（${this.syncExtensions.map((e) => `.${e}`).join(", ")}）`
		);
		return { ok: true, value: entries };
	}

	private async delay(ms: number): Promise<void> {
		return new Promise((resolve) => window.setTimeout(resolve, ms));
	}

	private isRetriableHttp(status: number): boolean {
		return status === 408 || status === 429 || status >= 500;
	}

	private async fetchDownloadUrl(downloadUrl: string): Promise<Result<string>> {
		let lastError = "";
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				await this.delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
			}
			try {
				const resp = await fetch(downloadUrl);
				if (!resp.ok) {
					lastError = `OSS HTTP ${resp.status}: ${resp.statusText}`;
					if (this.isRetriableHttp(resp.status)) continue;
					return { ok: false, error: lastError };
				}
				const text = await resp.text();
				return { ok: true, value: text };
			} catch (e) {
				lastError = e instanceof Error ? e.message : String(e);
			}
		}
		return { ok: false, error: lastError || "OSS 下载失败" };
	}

	/**
	 * 读取云端文件原文：优先 getDownloadInfo → OSS 直链；失败则回退 getFullFileContent。
	 */
	async readFile(fileId: string): Promise<Result<string>> {
		let lastError = "";

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				await this.delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
			}
			const infoResult = await this.api.getDownloadInfo(fileId, true);
			if (infoResult.ok && infoResult.value.downloadUrl) {
				const bodyResult = await this.fetchDownloadUrl(infoResult.value.downloadUrl);
				if (bodyResult.ok) {
					return { ok: true, value: cleanContent(bodyResult.value) };
				}
				lastError = bodyResult.error;
				continue;
			}
			lastError = infoResult.ok ? "无 downloadUrl" : infoResult.error;
		}

		console.warn(
			`[XGKB Sync] getDownloadInfo 多次失败，回退 getFullFileContent (fileId=${fileId}): ${lastError}`
		);
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			if (attempt > 0) {
				await this.delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
			}
			const fallback = await this.api.getFullFileContent(fileId);
			if (fallback.ok && fallback.value != null) {
				return { ok: true, value: cleanContent(fallback.value) };
			}
			lastError = fallback.ok ? "getFullFileContent 返回空内容" : fallback.error;
		}
		return { ok: false, error: lastError || "下载失败" };
	}

	async createFile(relativePath: string, content: string): Promise<Result<{ fileId: string; folderId: string }>> {
		const { folderName, fileName } = this.splitRelativePath(relativePath);
		const { suffix } = splitFileNameAndSuffix(fileName);

		if (this.uploadOpts.usePhysicalUpload && this.projectId) {
			const physical = await this.uploader.create({
				content,
				fileName,
				fileSuffix: suffix,
				folderName,
				projectId: this.projectId,
			});
			if (physical.ok) return physical;
			console.warn("[XGKB Sync] 物理上传新建失败:", physical.error);
			if (!this.uploadOpts.uploadContentFallback) return physical;
		}

		return this.createFileViaUploadContent(relativePath, content, folderName, fileName, suffix);
	}

	async updateFile(fileId: string, fileName: string, content: string): Promise<Result<string>> {
		const { suffix } = splitFileNameAndSuffix(fileName);

		if (this.uploadOpts.usePhysicalUpload && this.projectId) {
			const physical = await this.uploader.update({
				content,
				fileName,
				fileSuffix: suffix,
				updateFileId: fileId,
				projectId: this.projectId,
			});
			if (physical.ok) return physical;
			console.warn("[XGKB Sync] 物理上传更新失败:", physical.error);
			if (!this.uploadOpts.uploadContentFallback) return physical;
		}

		return this.updateFileViaUploadContent(fileId, fileName, content, suffix);
	}

	/** 同目录内改名（远端） */
	async renameRemoteFile(fileId: string, newFileName: string): Promise<Result<void>> {
		if (!this.projectId) return { ok: false, error: "未初始化 projectId" };
		const r = await this.api.updateFileName({
			fileId,
			newName: newFileName,
			projectId: this.projectId,
			nameConflictStrategy: DEFAULT_RENAME_NAME_CONFLICT_STRATEGY,
		});
		if (!r.ok) return { ok: false, error: r.error };
		return { ok: true, value: undefined };
	}

	/** 移动到其他父目录（远端） */
	async moveRemoteFile(fileId: string, targetParentId: string): Promise<Result<MoveFileResult>> {
		if (!this.projectId) return { ok: false, error: "未初始化 projectId" };
		console.debug(
			`[XGKB Sync] moveFile 调用: fileId=${fileId} targetParentId=${targetParentId} projectId=${this.projectId}`
		);
		const r = await this.api.moveFile({
			fileId,
			targetParentId,
			projectId: this.projectId,
			nameConflictStrategy: DEFAULT_MOVE_NAME_CONFLICT_STRATEGY,
		});
		if (!r.ok) return { ok: false, error: r.error };
		if (r.value.mainSkipped) {
			return { ok: false, error: "移动被跳过（目标目录存在同名文件）" };
		}
		return { ok: true, value: r.value };
	}

	/** 解析 syncFolder 相对路径对应的远端父 folderId；缺失子目录时逐级 createFolder */
	async resolveFolderIdForRelativePath(relativeFolderPath: string): Promise<Result<string>> {
		if (!this.projectId || !this.rootId) return { ok: false, error: "未初始化" };
		const segments = relativeFolderPath ? relativeFolderPath.split("/").filter(Boolean) : [];
		let currentId = this.rootId;
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const childResult = await this.api.getChildFiles(currentId, 1);
			if (!childResult.ok) return { ok: false, error: childResult.error };
			const found = (childResult.value || []).find((f) => f.name === seg && f.type === 1);
			if (!found) {
				const parentLabel = i === 0 ? "同步根" : segments.slice(0, i).join("/");
				console.debug(`[XGKB Sync] "${parentLabel}" 下无 "${seg}"，正在创建...`);
				const createResult = await this.api.createFolder({
					projectId: this.projectId,
					parentId: currentId,
					name: seg,
				});
				if (!createResult.ok) {
					return { ok: false, error: `创建目录 "${seg}" 失败: ${createResult.error}` };
				}
				currentId = createResult.value;
				console.debug(`[XGKB Sync] createFolder 成功: name="${seg}" folderId=${currentId}`);
			} else {
				currentId = found.id;
			}
		}
		console.debug(
			`[XGKB Sync] resolveFolderIdForRelativePath: "${relativeFolderPath || "(root)"}" -> ${currentId}`
		);
		return { ok: true, value: currentId };
	}

	private splitRelativePath(relativePath: string): { folderName: string; fileName: string } {
		const lastSlash = relativePath.lastIndexOf("/");
		const folderPath = lastSlash > 0 ? relativePath.substring(0, lastSlash) : "";
		const fileName = lastSlash > 0 ? relativePath.substring(lastSlash + 1) : relativePath;
		const folderName = folderPath
			? `${this.targetFolderPath}/${folderPath}`
			: this.targetFolderPath;
		return { folderName, fileName };
	}

	private async createFileViaUploadContent(
		relativePath: string,
		content: string,
		folderName: string,
		fileName: string,
		fileSuffix: string
	): Promise<Result<{ fileId: string; folderId: string }>> {
		const result = await this.api.uploadContent({
			content,
			fileName,
			fileSuffix,
			folderName,
			projectId: this.projectId || undefined,
		});
		if (!result.ok) return { ok: false, error: `上传失败: ${result.error}` };
		const data = result.value as { fileId: string | number; folderId?: string | number };
		return {
			ok: true,
			value: {
				fileId: String(data.fileId),
				folderId: data.folderId != null ? String(data.folderId) : "",
			},
		};
	}

	private async updateFileViaUploadContent(
		fileId: string,
		fileName: string,
		content: string,
		fileSuffix: string
	): Promise<Result<string>> {
		const result = await this.api.uploadContent({
			content,
			fileName,
			fileSuffix,
			updateFileId: fileId,
			versionRemark: "XGKB Sync plugin update",
		});
		if (!result.ok) return { ok: false, error: `更新失败: ${result.error}` };
		const data = result.value as { fileId: string };
		return { ok: true, value: data.fileId };
	}

	/** 删除云端文件 */
	async deleteFile(fileId: string): Promise<Result<void>> {
		return this.api.deleteFile(fileId).then((r) =>
			r.ok ? { ok: true as const, value: undefined } : r
		);
	}

	/**
	 * 拉取所有增量变更（4.22）自动翻页，直到 nextCursor 为空。
	 * @param since 毫秒时间戳（已含安全回拨）
	 */
	async listAllChanges(since: number): Promise<Result<{ items: XgkbChangeItem[]; serverTime?: number }>> {
		if (!this.rootId || !this.projectId) return { ok: false, error: "未初始化" };
		const sinceStr = new Date(since).toLocaleString("zh-CN");
		console.debug(`[XGKB Sync] listChanges: since=${since} (${sinceStr}), rootId=${this.rootId}`);
		const allItems: XgkbChangeItem[] = [];
		let cursor: string | undefined;
		let serverTime: number | undefined;
		let page = 0;
		do {
			page++;
			const r = await this.api.listChanges({
				projectId: this.projectId,
				rootFileId: this.rootId,
				since: cursor ? undefined : since,
				cursor,
				limit: 200,
			});
			if (!r.ok) return { ok: false, error: r.error };
			const pageItems = r.value.items || [];
			console.debug(`[XGKB Sync] listChanges 第${page}页: ${pageItems.length} 条，nextCursor=${r.value.nextCursor ?? "null"}，serverTime=${r.value.serverTime ?? "-"}`);
			allItems.push(...pageItems);
			serverTime = r.value.serverTime ?? serverTime;
			cursor = r.value.nextCursor || undefined;
		} while (cursor);
		const upsertCount = allItems.filter((i) => i.event !== "delete").length;
		const deleteCount  = allItems.filter((i) => i.event === "delete").length;
		console.debug(`[XGKB Sync] listChanges 完成: 共 ${allItems.length} 条 (upsert:${upsertCount} delete:${deleteCount})，serverTime=${serverTime}`);
		return { ok: true, value: { items: allItems, serverTime } };
	}

	/**
	 * 分批调用 batchGetMeta（4.23），返回 fileId → 元数据的 Map。
	 * 未返回的 fileId（不存在/无权限）不在 Map 中，调用方按删除处理。
	 */
	async batchGetMetaAll(fileIds: string[]): Promise<Map<string, XgkbMetaItem>> {
		const out = new Map<string, XgkbMetaItem>();
		const unique = [...new Set(fileIds.filter(Boolean))];
		console.debug(`[XGKB Sync] batchGetMeta: 请求 ${unique.length} 个 fileId，分 ${Math.ceil(unique.length / BATCH_GET_META_MAX)} 批`);
		for (let i = 0; i < unique.length; i += BATCH_GET_META_MAX) {
			const chunk = unique.slice(i, i + BATCH_GET_META_MAX);
			const r = await this.api.batchGetMeta(chunk, this.projectId || undefined);
			if (!r.ok) {
				console.warn("[XGKB Sync] batchGetMeta 失败:", r.error);
				continue;
			}
			let deletedCount = 0;
			for (const item of r.value || []) {
				out.set(String(item.fileId), item);
				if (item.deleted) deletedCount++;
			}
			console.debug(`[XGKB Sync] batchGetMeta 批次[${Math.floor(i / BATCH_GET_META_MAX) + 1}]: 请求 ${chunk.length} 个，返回 ${r.value?.length ?? 0} 条（其中 deleted:${deletedCount}）`);
		}
		const missingCount = unique.length - out.size;
		console.debug(`[XGKB Sync] batchGetMeta 完成: 命中 ${out.size} 个，未返回/无权限 ${missingCount} 个（将视为远端删除）`);
		return out;
	}
}
