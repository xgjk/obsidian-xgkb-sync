import { XgkbApi } from "./xgkbApi";
import type { FileEntry, Result, XgkbChangeItem, XgkbMetaItem } from "./types";
import { BATCH_GET_CONTENT_MAX, BATCH_GET_META_MAX, cleanContent } from "./constants";
import { sanitizePathSegment } from "./pathSanitize";

/**
 * 云端文件系统操作（XGKB API 封装）
 */
export class FsXgkb {
	private rootId: string | null = null;
	private projectId: string | null = null;

	constructor(
		private api: XgkbApi,
		private targetFolderName: string
	) {}

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
		// 1. 获取 projectId
		const projectResult = await this.api.getPersonalProjectId();
		if (!projectResult.ok) {
			return { ok: false, error: `获取 projectId 失败: ${projectResult.error}` };
		}
		const projectId = projectResult.value;
		this.projectId = projectId;
		console.debug(`[XGKB Sync] init: projectId=${projectId}`);

		// 2. 获取一级目录，找 Obsidian 文件夹
		const foldersResult = await this.api.getLevel1Folders(projectId);
		if (!foldersResult.ok) {
			return { ok: false, error: `获取目录列表失败: ${foldersResult.error}` };
		}
		const folders = foldersResult.value || [];
		const target = folders.find((f) => f.name === this.targetFolderName && f.type === 1);

		if (target) {
			this.rootId = target.id;
			console.debug(`[XGKB Sync] init: 找到同步根目录 "${this.targetFolderName}" rootId=${target.id}`);
			return { ok: true, value: target.id };
		}

		// 3. Obsidian 文件夹不存在，显式创建；createFolder 直接返回新目录的 fileId
		console.debug(`[XGKB Sync] init: 未找到 "${this.targetFolderName}"，调用 createFolder 新建...`);
		const createResult = await this.api.createFolder({
			projectId,
			parentId: "0",
			name: this.targetFolderName,
		});

		if (!createResult.ok) {
			return { ok: false, error: `创建 Obsidian 目录失败: ${createResult.error}` };
		}

		// createFolder 返回值即新目录 fileId，无需再 getLevel1Folders
		this.rootId = createResult.value;
		console.debug(`[XGKB Sync] init: 新建同步根目录 "${this.targetFolderName}" rootId=${createResult.value}`);
		return { ok: true, value: createResult.value };
	}

	/**
	 * 通过 4.21 扁平列举同步根目录下所有 .md 文件
	 */
	async listFiles(): Promise<Result<FileEntry[]>> {
		if (!this.rootId) return { ok: false, error: "未初始化" };
		const entries: FileEntry[] = [];
		let cursor: string | undefined;
		let page = 0;
		do {
			page++;
			const r = await this.api.listDescendantFiles({
				rootFileId: this.rootId,
				projectId: this.projectId || undefined,
				suffix: "md",
				limit: 500,
				cursor,
				includePath: true,
			});
			if (!r.ok) return { ok: false, error: r.error };
			const pageItems = r.value.files || [];
			console.debug(`[XGKB Sync] listDescendantFiles 第${page}页: 返回 ${pageItems.length} 条，nextCursor=${r.value.nextCursor ?? "null"}`);
			for (const item of pageItems) {
				const rawPath = item.relativePath || item.name;
				const safePath = rawPath
					.split("/")
					.filter(Boolean)
					.map((seg) => sanitizePathSegment(seg))
					.join("/");
				if (!safePath.endsWith(".md")) continue;
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
		console.debug(`[XGKB Sync] listDescendantFiles 完成: 共 ${entries.length} 个 .md 文件，${page} 页`);
		return { ok: true, value: entries };
	}

	/**
	 * 读取云端文件内容（使用 getFullFileContent，所写即所读）
	 */
	async readFile(fileId: string): Promise<Result<string>> {
		const result = await this.api.getFullFileContent(fileId);
		if (!result.ok) return result;
		// 清理尾部 "Page X of Y" 标记
		return { ok: true, value: cleanContent(result.value) };
	}

	/**
	 * 批量预取全文（4.15 `batchGetContent`）。
	 * 不限个人空间，凭 fileId 与 appKey 权限拉取；建议每批不超过 {@link BATCH_GET_CONTENT_MAX} 个。
	 * 若某项未命中或非 success，调用方应回退 {@link readFile}。
	 */
	async readFilesBatch(fileIds: string[]): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		const unique = [...new Set(fileIds.filter(Boolean))];
		for (let i = 0; i < unique.length; i += BATCH_GET_CONTENT_MAX) {
			const chunk = unique.slice(i, i + BATCH_GET_CONTENT_MAX);
			const r = await this.api.batchGetContent(chunk.map((fileId) => ({ fileId })));
			if (!r.ok) {
				console.warn("[XGKB Sync] batchGetContent 失败，未命中项将回退单文件拉取:", r.error);
				continue;
			}
			let mergedThisChunk = 0;
			for (const row of r.value || []) {
				const id = String(row.fileId);
				if (row.status === "success" && row.content != null) {
					out.set(id, cleanContent(row.content));
					mergedThisChunk++;
				}
			}
			// Obsidian 的 requestUrl 通常不会出现在侧边栏开发者工具 Network 里，用本日志确认请求已发出并已返回
			console.debug(
				`[XGKB Sync] batchGetContent 已返回: 本批 ${chunk.length} 个 fileId，接口响应 ${r.value?.length ?? 0} 条，可用正文 ${mergedThisChunk} 条`
			);
		}
		return out;
	}

	/**
	 * 上传新文件（使用 uploadContent）
	 * @param relativePath 相对路径（如 "日常学习/笔记.md"）
	 * @param content Markdown 内容
	 * @returns fileId 与 folderId（folderId 用于状态库，支撑增量同步路径缓存）
	 */
	async createFile(relativePath: string, content: string): Promise<Result<{ fileId: string; folderId: string }>> {
		const lastSlash = relativePath.lastIndexOf("/");
		const folderPath = lastSlash > 0 ? relativePath.substring(0, lastSlash) : "";
		const fileName = lastSlash > 0 ? relativePath.substring(lastSlash + 1) : relativePath;

		const folderName = folderPath
			? `${this.targetFolderName}/${folderPath}`
			: this.targetFolderName;

		const result = await this.api.uploadContent({
			content,
			fileName,
			fileSuffix: "md",
			folderName,
		});

		if (!result.ok) return { ok: false, error: `上传失败: ${result.error}` };

		// 新建模式返回 UploadContentResult，含 fileId 与 folderId
		const data = result.value as { fileId: string | number; folderId?: string | number };
		return {
			ok: true,
			value: {
				fileId: String(data.fileId),
				folderId: data.folderId != null ? String(data.folderId) : "",
			},
		};
	}

	/**
	 * 更新已有文件（使用 uploadContent + updateFileId）
	 */
	async updateFile(fileId: string, fileName: string, content: string): Promise<Result<string>> {
		const result = await this.api.uploadContent({
			content,
			fileName,
			fileSuffix: "md",
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
