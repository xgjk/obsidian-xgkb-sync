import type {
	XgkbPluginSettings,
	FileEntry,
	SyncStateRecord,
	SyncStats,
	ProgressCallback,
} from "./types";
import { SyncStateDb } from "./syncStateDb";
import { FsLocal } from "./fsLocal";
import { FsXgkb } from "./fsXgkb";
import { DEFAULT_SETTINGS, MTIME_TOLERANCE_MS, CHANGES_SAFETY_WINDOW_MS } from "./constants";
import { sanitizePathSegment } from "./pathSanitize";

/**
 * 同步引擎（Last-Write-Wins）
 *
 * 决策逻辑：
 * - 无 record（首次）：本地有→上传，云端有→下载，都有→对比 mtime
 * - 有 record（增量）：基于 mtime 变化判断方向
 * - 两端都修改了→LWW：较新覆盖较旧
 * - 一端删除了→另一端也删除
 *
 * 云端扫描策略：
 * - 有 since 水位 → 优先走 listChanges + batchGetMeta 增量路径
 *   - 若有未知新文件（fileId 不在本地状态库）→ 自动降级为全量 listDescendantFiles
 * - 无 since（首次）→ 全量 listDescendantFiles
 */
export class SyncEngine {
	private db: SyncStateDb;
	private fsLocal: FsLocal;
	private fsXgkb: FsXgkb;
	private settings: XgkbPluginSettings;
	private scopeKey: string;
	private stats: SyncStats;
	private progress: ProgressCallback = () => {};

	constructor(
		fsLocal: FsLocal,
		fsXgkb: FsXgkb,
		db: SyncStateDb,
		settings: XgkbPluginSettings,
		scopeKey: string
	) {
		this.fsLocal = fsLocal;
		this.fsXgkb = fsXgkb;
		this.db = db;
		this.settings = { ...DEFAULT_SETTINGS, ...settings };
		this.scopeKey = scopeKey;
		this.stats = this.emptyStats();
	}

	private emptyStats(): SyncStats {
		return { uploaded: 0, downloaded: 0, deleted: 0, skipped: 0, failed: 0, errors: [] };
	}

	/**
	 * @param onProgress 进度回调
	 * @param since      上次同步水位（毫秒时间戳）；首次同步不传
	 */
	async runSync(onProgress?: ProgressCallback, since?: number): Promise<SyncStats> {
		this.stats = this.emptyStats();
		this.progress = onProgress || (() => {});
		const prog = (msg: string) => {
			console.debug(`[XGKB Sync] ${msg}`);
			this.progress(msg);
		};

		// Step 1: 初始化云端
		prog("连接玄关知识库...");
		const initResult = await this.fsXgkb.init();
		if (!initResult.ok) throw new Error(`初始化失败: ${initResult.error}`);

		// Step 2: 扫描本地文件
		prog("扫描本地文件...");
		const localFiles = this.fsLocal.listFiles();
		prog(`本地: ${localFiles.length} 个 .md 文件`);

		// Step 3: 构建云端视图（增量优先，失败降级全量）
		const { map: remoteMap, newSince } = await this.buildRemoteMap(since, prog);
		prog(`云端: ${remoteMap.size} 个 .md 文件（水位 ${newSince}）`);
		this.stats.newSince = newSince;

		// Step 4: 构建本地 Map
		const localMap = new Map<string, FileEntry>();
		for (const f of localFiles) localMap.set(f.path, f);

		// Step 5: 合并所有路径
		const allPaths = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
		prog(`共 ${allPaths.size} 个路径需要处理`);

		// Step 6a: 逐路径决策
		const plans: SyncPlan[] = [];
		let idx = 0;
		for (const path of allPaths) {
			idx++;
			if (idx % 50 === 0 || idx === allPaths.size) prog(`决策中 ${idx}/${allPaths.size}...`);
			const local = localMap.get(path);
			const remote = remoteMap.get(path);
			const record = await this.db.get(this.scopeKey, path);
			const op = this.decide(path, local, remote, record);
			plans.push({ path, local, remote, record, op });
		}

		// Step 6b: 批量预取需要下载的文件正文
		const downloadFileIds: string[] = [];
		for (const p of plans) {
			if (p.op === "download-new" || p.op === "download-update") {
				const id = p.remote?.xgkbFileId;
				if (id) downloadFileIds.push(id);
			}
		}
		if (downloadFileIds.length > 0) prog(`批量拉取正文 ${downloadFileIds.length} 个文件...`);
		const contentCache = await this.fsXgkb.readFilesBatch(downloadFileIds);

		// Step 6c: 按计划执行
		idx = 0;
		for (const plan of plans) {
			idx++;
			if (idx % 50 === 0 || idx === plans.length) prog(`处理中 ${idx}/${plans.length}...`);
			await this.executePlan(plan, contentCache);
		}

		prog(`完成: ↑${this.stats.uploaded} ↓${this.stats.downloaded} ✗${this.stats.deleted} ✗fail:${this.stats.failed} ∅${this.stats.skipped}`);
		return this.stats;
	}

	// ==================== 云端视图构建 ====================

	/**
	 * 构建云端文件 Map，优先走增量路径，降级全量。
	 */
	private async buildRemoteMap(
		since: number | undefined,
		prog: (msg: string) => void
	): Promise<{ map: Map<string, FileEntry>; newSince: number }> {
		if (since !== undefined) {
			const sinceStr = new Date(since).toLocaleString("zh-CN");
			prog(`增量模式：since=${since} (${sinceStr})`);
			const result = await this.tryIncrementalRemoteMap(since, prog);
			if (result) {
				prog(`增量成功：云端视图 ${result.map.size} 个文件`);
				return result;
			}
			prog("增量降级：执行全量扫描...");
		} else {
			prog("首次同步：执行全量扫描...");
		}
		return this.fullRemoteMap();
	}

	/**
	 * 尝试增量路径：listChanges + batchGetMeta。
	 * 遇到未知新文件（无本地记录）返回 null，由调用方降级全量。
	 */
	private async tryIncrementalRemoteMap(
		since: number,
		prog: (msg: string) => void
	): Promise<{ map: Map<string, FileEntry>; newSince: number } | null> {
		const safeSince = since - CHANGES_SAFETY_WINDOW_MS;
		const changesResult = await this.fsXgkb.listAllChanges(safeSince);
		if (!changesResult.ok) {
			console.warn("[XGKB Sync] listChanges 失败，降级全量:", changesResult.error);
			return null;
		}

		const { items, serverTime } = changesResult.value;
		const newSince = serverTime || Date.now();
		prog(`增量变更: ${items.length} 条`);

		// 分类事件，同时保留 item 引用供后续路径重建使用
		const upsertById = new Map<string, typeof items[0]>();
		const deleteIds = new Set<string>();
		for (const item of items) {
			const id = String(item.fileId);
			if (item.event === "delete") deleteIds.add(id);
			else upsertById.set(id, item);
		}

		// 加载全部本地状态，建双向索引
		const allRecords = await this.db.getAll(this.scopeKey);
		const fileIdToRecord = new Map<string, SyncStateRecord>();
		for (const r of allRecords) fileIdToRecord.set(r.xgkbFileId, r);

		// 区分「已知变更（fileId 在状态库）」和「未知新增」
		const knownUpsertIds: string[] = [];
		const unknownUpsertIds: string[] = [];
		for (const id of upsertById.keys()) {
			if (fileIdToRecord.has(id)) knownUpsertIds.push(id);
			else unknownUpsertIds.push(id);
		}
		prog(`变更分类: upsert已知=${knownUpsertIds.length} upsert新增=${unknownUpsertIds.length} delete=${deleteIds.size}`);

		// 对未知新增文件：用状态库中的 xgkbFolderId 反推目录路径，避免全量降级
		// 原理：每条 SyncStateRecord 记录了文件的 parentFolderId，
		//       从 localPath 可推出该 folderId 对应的本地路径前缀
		const folderIdToPath = new Map<string, string>();
		// 根目录本身映射为空串
		const rootId = this.fsXgkb.getRootId();
		if (rootId) folderIdToPath.set(rootId, "");
		for (const record of allRecords) {
			const parts = record.localPath.split("/");
			const folderPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
			folderIdToPath.set(record.xgkbFolderId, folderPath);
		}

		// 尝试为每个未知新增文件重建路径
		type ResolvedNew = { id: string; path: string; item: typeof items[0] };
		const resolvedNewFiles: ResolvedNew[] = [];
		const unresolvedIds: string[] = []; // 父目录也是全新的，才需要降级

		for (const id of unknownUpsertIds) {
			const item = upsertById.get(id)!;
			const parentId = item.parentId != null ? String(item.parentId) : "";
			const folderPath = folderIdToPath.get(parentId);
			if (folderPath !== undefined) {
				// 父目录已知，直接重建路径
				const safeName = sanitizePathSegment(item.name || id);
				const filePath = folderPath ? `${folderPath}/${safeName}` : safeName;
				resolvedNewFiles.push({ id, path: filePath, item });
			} else {
				// 父目录也是全新的，无法推断路径
				unresolvedIds.push(id);
			}
		}

		if (unresolvedIds.length > 0) {
			prog(`发现 ${unresolvedIds.length} 个文件位于全新目录，降级全量对账...`);
			return null;
		}
		if (resolvedNewFiles.length > 0) {
			prog(`路径重建成功 ${resolvedNewFiles.length} 个新文件（无需全量）：${resolvedNewFiles.map((f) => f.path).join(", ")}`);
		}

		// 构建基础 Map：未变更的文件直接复用本地状态里的 remoteMtime
		const map = new Map<string, FileEntry>();
		for (const record of allRecords) {
			const id = record.xgkbFileId;
			if (deleteIds.has(id) || upsertById.has(id)) continue;
			map.set(record.localPath, {
				path: record.localPath,
				name: record.localPath.split("/").pop() || record.localPath,
				mtime: record.remoteMtime,
				xgkbFileId: id,
				xgkbFolderId: record.xgkbFolderId,
			});
		}

		// 用 batchGetMeta 刷新已知变更文件的元数据
		if (knownUpsertIds.length > 0) {
			prog(`批量获取 ${knownUpsertIds.length} 个变更文件元数据...`);
			const metaMap = await this.fsXgkb.batchGetMetaAll(knownUpsertIds);
			for (const id of knownUpsertIds) {
				const meta = metaMap.get(id);
				const record = fileIdToRecord.get(id)!;
				// meta 缺失或已删除：不加入 Map → decide() 会判定为云端删除
				if (!meta || meta.deleted) continue;
				map.set(record.localPath, {
					path: record.localPath,
					name: meta.name || record.localPath.split("/").pop() || record.localPath,
					mtime: meta.updateTime || record.remoteMtime,
					xgkbFileId: id,
					xgkbFolderId: meta.parentId != null ? String(meta.parentId) : record.xgkbFolderId,
				});
			}
		}

		// 路径重建成功的新文件：直接加入 remoteMap，触发 download-new
		for (const { id, path, item } of resolvedNewFiles) {
			map.set(path, {
				path,
				name: item.name || path.split("/").pop() || path,
				mtime: item.updateTime || Date.now(),
				xgkbFileId: id,
				xgkbFolderId: item.parentId != null ? String(item.parentId) : "",
			});
		}

		return { map, newSince };
	}

	/** 全量扫描（listDescendantFiles 分页） */
	private async fullRemoteMap(): Promise<{ map: Map<string, FileEntry>; newSince: number }> {
		const remoteResult = await this.fsXgkb.listFiles();
		if (!remoteResult.ok) throw new Error(`扫描云端失败: ${remoteResult.error}`);
		const map = new Map<string, FileEntry>();
		for (const f of remoteResult.value) map.set(f.path, f);
		const newSince = Date.now();
		console.debug(`[XGKB Sync] 全量扫描完成: ${map.size} 个文件，新水位=${newSince} (${new Date(newSince).toLocaleString("zh-CN")})`);
		return { map, newSince };
	}

	// ==================== 计划执行 ====================

	private async executePlan(plan: SyncPlan, contentCache: Map<string, string>): Promise<void> {
		const { path, local, remote, record, op } = plan;
		try {
			switch (op) {
				case "upload-new":    await this.doUploadNew(path, local!); break;
				case "upload-update": await this.doUploadUpdate(path, local!, remote!, record); break;
				case "download-new":  await this.doDownloadNew(path, remote!, contentCache); break;
				case "download-update": await this.doDownloadUpdate(path, remote!, record, contentCache); break;
				case "delete-local":  await this.doDeleteLocal(path, record!); break;
				case "delete-remote": await this.doDeleteRemote(record!); break;
				case "skip":          this.stats.skipped++; break;
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.stats.failed++;
			this.stats.errors.push(`${path}: ${msg}`);
			console.error(`[XGKB Sync] 同步失败 ${path}:`, msg);
		}
	}

	// ==================== 决策逻辑 ====================

	private decide(
		path: string,
		local: FileEntry | undefined,
		remote: FileEntry | undefined,
		record: SyncStateRecord | undefined
	): SyncOp {
		const dir = this.settings.syncDirection;

		// 情况 A：无 record（首次同步该路径）
		if (!record) {
			if (local && !remote) return dir === "pull" ? "skip" : "upload-new";
			if (!local && remote) return dir === "push" ? "skip" : "download-new";
			if (local && remote) {
				if (dir === "pull") return "download-update";
				if (dir === "push") return "upload-update";
				return local.mtime >= remote.mtime ? "upload-update" : "download-update";
			}
			return "skip";
		}

		// 情况 B：有 record（增量同步）
		if (!local && !remote) return "skip";

		if (!local && remote) {
			if (dir === "push") return "skip";
			const remoteChanged = remote.mtime > record.remoteMtime + MTIME_TOLERANCE_MS;
			return remoteChanged ? "download-update" : "delete-remote";
		}

		if (local && !remote) {
			if (dir === "pull") return "skip";
			const localChanged = local.mtime > record.localMtime + MTIME_TOLERANCE_MS;
			return localChanged ? "upload-new" : "delete-local";
		}

		if (local && remote) {
			const localChanged  = local.mtime  > record.localMtime  + MTIME_TOLERANCE_MS;
			const remoteChanged = remote.mtime > record.remoteMtime + MTIME_TOLERANCE_MS;

			if (!localChanged && !remoteChanged) return "skip";
			if (localChanged  && !remoteChanged) return dir === "pull"  ? "skip" : "upload-update";
			if (!localChanged && remoteChanged)  return dir === "push"  ? "skip" : "download-update";

			// 两端都变 → LWW
			if (dir === "pull") return "download-update";
			if (dir === "push") return "upload-update";
			return local.mtime >= remote.mtime ? "upload-update" : "download-update";
		}

		return "skip";
	}

	// ==================== 操作执行 ====================

	/** 保证 IndexedDB 复合主键 scopeKey + localPath 始终存在 */
	private buildDbRecord(
		path: string,
		partial: Pick<SyncStateRecord, "xgkbFileId" | "xgkbFolderId" | "localMtime" | "remoteMtime"> &
			Partial<Pick<SyncStateRecord, "syncStatus" | "lastError">>
	): SyncStateRecord {
		return {
			scopeKey: this.scopeKey,
			localPath: path,
			xgkbFileId: partial.xgkbFileId,
			xgkbFolderId: partial.xgkbFolderId,
			localMtime: partial.localMtime,
			remoteMtime: partial.remoteMtime,
			syncStatus: partial.syncStatus ?? "done",
			lastSyncAt: Date.now(),
			...(partial.lastError !== undefined ? { lastError: partial.lastError } : {}),
		};
	}

	private async doUploadNew(path: string, local: FileEntry): Promise<void> {
		const content = await this.fsLocal.readFile(path);
		const result = await this.fsXgkb.createFile(path, content);
		if (!result.ok) throw new Error(`上传失败: ${result.error}`);
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: result.value.fileId,
				xgkbFolderId: result.value.folderId,
				localMtime: local.mtime,
				remoteMtime: Date.now(),
			})
		);
		this.stats.uploaded++;
		this.progress(`↑ ${path}`);
	}

	private async doUploadUpdate(
		path: string,
		local: FileEntry,
		remote: FileEntry,
		record: SyncStateRecord | undefined
	): Promise<void> {
		const fileId = record?.xgkbFileId ?? remote.xgkbFileId;
		if (!fileId) throw new Error("缺少云端文件 ID，无法更新");
		const content = await this.fsLocal.readFile(path);
		const fileName = path.split("/").pop() || path;
		const result = await this.fsXgkb.updateFile(fileId, fileName, content);
		if (!result.ok) throw new Error(`更新失败: ${result.error}`);
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: fileId,
				xgkbFolderId: record?.xgkbFolderId ?? remote.xgkbFolderId ?? "",
				localMtime: local.mtime,
				remoteMtime: Date.now(),
			})
		);
		this.stats.uploaded++;
		this.progress(`↑ ${path}`);
	}

	private async doDownloadNew(path: string, remote: FileEntry, contentCache: Map<string, string>): Promise<void> {
		const fid = remote.xgkbFileId!;
		const body = contentCache.has(fid)
			? contentCache.get(fid)!
			: await this.fsXgkb.readFile(fid).then((r) => {
				if (!r.ok) throw new Error(`下载失败: ${r.error}`);
				return r.value;
			  });
		const actualMtime = await this.fsLocal.writeFile(path, body);
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: remote.xgkbFileId!,
				xgkbFolderId: remote.xgkbFolderId || "",
				localMtime: actualMtime,
				remoteMtime: remote.mtime,
			})
		);
		this.stats.downloaded++;
		this.progress(`↓ ${path}`);
	}

	private async doDownloadUpdate(
		path: string,
		remote: FileEntry,
		record: SyncStateRecord | undefined,
		contentCache: Map<string, string>
	): Promise<void> {
		const fid = remote.xgkbFileId!;
		const body = contentCache.has(fid)
			? contentCache.get(fid)!
			: await this.fsXgkb.readFile(fid).then((r) => {
				if (!r.ok) throw new Error(`下载失败: ${r.error}`);
				return r.value;
			  });
		const actualMtime = await this.fsLocal.writeFile(path, body);
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: fid,
				xgkbFolderId: record?.xgkbFolderId ?? remote.xgkbFolderId ?? "",
				localMtime: actualMtime,
				remoteMtime: remote.mtime,
			})
		);
		this.stats.downloaded++;
		this.progress(`↓ ${path}`);
	}

	private async doDeleteLocal(path: string, record: SyncStateRecord): Promise<void> {
		await this.fsLocal.trashFile(path);
		await this.db.delete(this.scopeKey, path);
		this.stats.deleted++;
		this.progress(`✗ 本地删除 ${path}`);
	}

	private async doDeleteRemote(record: SyncStateRecord): Promise<void> {
		const result = await this.fsXgkb.deleteFile(record.xgkbFileId);
		if (!result.ok) throw new Error(`删除云端失败: ${result.error}`);
		await this.db.delete(this.scopeKey, record.localPath);
		this.stats.deleted++;
		this.progress(`✗ 云端删除 ${record.localPath}`);
	}
}

type SyncOp = "upload-new" | "upload-update" | "download-new" | "download-update" | "delete-local" | "delete-remote" | "skip";

type SyncPlan = {
	path: string;
	local: FileEntry | undefined;
	remote: FileEntry | undefined;
	record: SyncStateRecord | undefined;
	op: SyncOp;
};
