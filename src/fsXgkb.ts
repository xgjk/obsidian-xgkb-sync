import { XgkbApi } from "./xgkbApi";
import type { FileEntry, Result, XgkbFileVO } from "./types";
import { BATCH_GET_CONTENT_MAX, cleanContent } from "./constants";
import { sanitizePathSegment } from "./pathSanitize";

/**
 * 云端文件系统操作（XGKB API 封装）
 */
export class FsXgkb {
	private rootId: string | null = null;

	constructor(
		private api: XgkbApi,
		private targetFolderName: string
	) {}

	getRootId(): string | null {
		return this.rootId;
	}

	/**
	 * 初始化：获取 Obsidian 文件夹 ID
	 * 如果不存在，通过 uploadContent 创建占位文件来自动创建 Obsidian 文件夹
	 */
	async init(): Promise<Result<string>> {
		// 1. 获取 projectId
		const projectResult = await this.api.getPersonalProjectId();
		if (!projectResult.ok) {
			return { ok: false, error: `获取 projectId 失败: ${projectResult.error}` };
		}
		const projectId = projectResult.value;

		// 2. 获取一级目录，找 Obsidian 文件夹
		const foldersResult = await this.api.getLevel1Folders(projectId);
		if (!foldersResult.ok) {
			return { ok: false, error: `获取目录列表失败: ${foldersResult.error}` };
		}
		const folders = foldersResult.value || [];
		const target = folders.find((f) => f.name === this.targetFolderName && f.type === 1);

		if (target) {
			this.rootId = target.id;
			return { ok: true, value: target.id };
		}

		// 3. Obsidian 文件夹不存在，创建占位文件来自动创建
		const createResult = await this.api.uploadContent({
			content: "# XGKB Sync\n\n此文件由 XGKB Sync 插件自动创建，用于初始化同步目录。",
			fileName: ".xgkb-sync-init.md",
			fileSuffix: "md",
			folderName: this.targetFolderName,
		});

		if (!createResult.ok) {
			return { ok: false, error: `创建 Obsidian 目录失败: ${createResult.error}` };
		}

		// 4. 重新获取目录列表
		const foldersResult2 = await this.api.getLevel1Folders(projectId);
		if (!foldersResult2.ok) {
			return { ok: false, error: `重新获取目录失败: ${foldersResult2.error}` };
		}
		const target2 = (foldersResult2.value || []).find(
			(f) => f.name === this.targetFolderName && f.type === 1
		);
		if (!target2) {
			return { ok: false, error: "目录创建后仍未找到 Obsidian 文件夹" };
		}

		this.rootId = target2.id;

		// 5. 删除占位文件
		if (createResult.value && "fileId" in createResult.value) {
			await this.api.deleteFile(createResult.value.fileId);
		}

		return { ok: true, value: target2.id };
	}

	/**
	 * 递归列出 Obsidian 文件夹下所有 .md 文件
	 */
	async listFiles(): Promise<Result<FileEntry[]>> {
		if (!this.rootId) return { ok: false, error: "未初始化" };
		const entries: FileEntry[] = [];
		const err = await this.collectMdFiles(this.rootId, "", entries);
		if (err) return { ok: false, error: err };
		return { ok: true, value: entries };
	}

	private async collectMdFiles(
		parentId: string,
		prefix: string,
		entries: FileEntry[]
	): Promise<string | null> {
		const result = await this.api.getChildFiles(parentId);
		if (!result.ok) return result.error;

		for (const item of result.value || []) {
			if (item.type === 2) {
				// 文件：只处理 .md
				if (!item.name.endsWith(".md")) continue;
				if (item.fileType && item.fileType !== "file") continue;
				const seg = sanitizePathSegment(item.name);
				const relativePath = prefix ? `${prefix}/${seg}` : seg;
				entries.push({
					path: relativePath,
					name: item.name,
					mtime: item.updateTime || item.createTime || 0,
					xgkbFileId: item.id,
					xgkbFolderId: item.parentId,
				});
			} else if (item.type === 1 && item.hasChild) {
				// 文件夹：递归（路径键与本地 Vault 合法名一致，与 FsLocal.resolve 规则相同）
				const seg = sanitizePathSegment(item.name);
				const subPrefix = prefix ? `${prefix}/${seg}` : seg;
				const err = await this.collectMdFiles(item.id, subPrefix, entries);
				if (err) return err;
			}
		}
		return null;
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
			console.log(
				`[XGKB Sync] batchGetContent 已返回: 本批 ${chunk.length} 个 fileId，接口响应 ${r.value?.length ?? 0} 条，可用正文 ${mergedThisChunk} 条`
			);
		}
		return out;
	}

	/**
	 * 上传新文件（使用 uploadContent）
	 * @param relativePath 相对路径（如 "日常学习/笔记.md"）
	 * @param content Markdown 内容
	 */
	async createFile(relativePath: string, content: string): Promise<Result<string>> {
		// 从路径提取目录部分
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

		// 新建模式返回 UploadContentResult
		const data = result.value as { fileId: string; fileName: string };
		return { ok: true, value: data.fileId };
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
}
