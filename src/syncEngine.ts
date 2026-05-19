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
import {
	DEFAULT_SETTINGS,
	DOWNLOAD_CONCURRENCY,
	MTIME_TOLERANCE_MS,
	CHANGES_SAFETY_WINDOW_MS,
} from "./constants";
import { sanitizePathSegment } from "./pathSanitize";

type RemoteMapBuild = {
	map: Map<string, FileEntry>;
	/** 增量：listChanges.serverTime；全量：子树内最大 updateTime */
	watermarkCandidate: number;
	scanMode: "incremental" | "full";
};

/**
 * 同步引擎（Last-Write-Wins）
 *
 * 下载：getDownloadInfo → OSS 直链，并发 {@link DOWNLOAD_CONCURRENCY}，拉完即 writeFile。
 * 水位：轮次结束后提交；有失败仍推进，失败项记入 IndexedDB（syncStatus=failed）下轮优先重试。
 */
export class SyncEngine {
	private db: SyncStateDb;
	private fsLocal: FsLocal;
	private fsXgkb: FsXgkb;
	private settings: XgkbPluginSettings;
	private scopeKey: string;
	private stats: SyncStats;
	private progress: ProgressCallback = () => {};
	private successfulRemoteMtimes: number[] = [];

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

	async runSync(onProgress?: ProgressCallback, since?: number): Promise<SyncStats> {
		this.stats = this.emptyStats();
		this.successfulRemoteMtimes = [];
		this.progress = onProgress || (() => {});
		const prog = (msg: string) => {
			console.debug(`[XGKB Sync] ${msg}`);
			this.progress(msg);
		};

		prog("连接玄关知识库...");
		const initResult = await this.fsXgkb.init();
		if (!initResult.ok) throw new Error(`初始化失败: ${initResult.error}`);

		prog("扫描本地文件...");
		const localFiles = this.fsLocal.listFiles();
		prog(`本地: ${localFiles.length} 个 .md 文件`);

		const remoteBuild = await this.buildRemoteMap(since, prog);
		let remoteMap = remoteBuild.map;
		prog(`云端: ${remoteMap.size} 个 .md 文件（候选水位 ${remoteBuild.watermarkCandidate}）`);

		const retried = await this.injectFailedRetries(remoteMap, prog);
		this.stats.retriedFailed = retried;
		if (retried > 0) {
			prog(`失败重试队列: ${retried} 个文件已并入本轮`);
		}

		const localMap = new Map<string, FileEntry>();
		for (const f of localFiles) localMap.set(f.path, f);

		const allPaths = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
		prog(`共 ${allPaths.size} 个路径需要处理`);

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

		const downloadPlans = plans.filter((p) => p.op === "download-new" || p.op === "download-update");
		const otherPlans = plans.filter((p) => p.op !== "download-new" && p.op !== "download-update");

		idx = 0;
		for (const plan of otherPlans) {
			idx++;
			if (idx % 50 === 0 || idx === otherPlans.length) {
				prog(`处理中 ${idx}/${otherPlans.length}（上传/跳过/删除）...`);
			}
			await this.executePlan(plan);
		}

		if (downloadPlans.length > 0) {
			prog(`开始下载 ${downloadPlans.length} 个文件（并发 ${DOWNLOAD_CONCURRENCY}，OSS 直链）...`);
			let done = 0;
			await this.runWithConcurrency(downloadPlans, DOWNLOAD_CONCURRENCY, async (plan) => {
				await this.executePlan(plan);
				done++;
				if (done % 5 === 0 || done === downloadPlans.length) {
					prog(`下载进度 ${done}/${downloadPlans.length}（已完成 ↓${this.stats.downloaded} 失败 ${this.stats.failed}）`);
				}
			});
		}

		this.stats.newSince = this.computeCommittedWatermark(remoteBuild);

		prog(
			`完成: ↑${this.stats.uploaded} ↓${this.stats.downloaded} ✗${this.stats.deleted} fail:${this.stats.failed} ∅${this.stats.skipped} 水位=${this.stats.newSince ?? "-"}`
		);
		return this.stats;
	}

	private computeCommittedWatermark(build: RemoteMapBuild): number {
		const catalogMax = this.maxRemoteMtime(build.map);
		const successMax =
			this.successfulRemoteMtimes.length > 0 ? Math.max(...this.successfulRemoteMtimes) : 0;

		if (build.scanMode === "incremental") {
			return Math.max(build.watermarkCandidate, successMax, catalogMax);
		}
		return Math.max(catalogMax, successMax, build.watermarkCandidate);
	}

	private maxRemoteMtime(map: Map<string, FileEntry>): number {
		let max = 0;
		for (const f of map.values()) {
			if (f.mtime > max) max = f.mtime;
		}
		return max;
	}

	/** 将 IndexedDB 中 failed 记录并入 remoteMap，避免水位推进后漏拉 */
	private async injectFailedRetries(
		remoteMap: Map<string, FileEntry>,
		prog: (msg: string) => void
	): Promise<number> {
		const all = await this.db.getAll(this.scopeKey);
		const failed = all.filter((r) => r.syncStatus === "failed");
		if (failed.length === 0) return 0;

		const ids = failed.map((r) => r.xgkbFileId).filter(Boolean);
		const metaMap = await this.fsXgkb.batchGetMetaAll(ids);

		let injected = 0;
		for (const record of failed) {
			const meta = metaMap.get(record.xgkbFileId);
			if (meta?.deleted) {
				await this.db.delete(this.scopeKey, record.localPath);
				prog(`云端已删除，清除失败记录: ${record.localPath}`);
				continue;
			}
			if (remoteMap.has(record.localPath)) continue;
			const mtime = meta?.updateTime ?? record.remoteMtime;
			remoteMap.set(record.localPath, {
				path: record.localPath,
				name: meta?.name || record.localPath.split("/").pop() || record.localPath,
				mtime,
				xgkbFileId: record.xgkbFileId,
				xgkbFolderId:
					meta?.parentId != null ? String(meta.parentId) : record.xgkbFolderId,
			});
			injected++;
		}
		if (injected > 0) {
			prog(`从失败队列恢复 ${injected} 个路径到云端视图`);
		}
		return failed.length;
	}

	private async runWithConcurrency<T>(
		items: T[],
		concurrency: number,
		fn: (item: T) => Promise<void>
	): Promise<void> {
		let cursor = 0;
		const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (cursor < items.length) {
				const i = cursor++;
				await fn(items[i]);
			}
		});
		await Promise.all(workers);
	}

	private async buildRemoteMap(
		since: number | undefined,
		prog: (msg: string) => void
	): Promise<RemoteMapBuild> {
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

	private async tryIncrementalRemoteMap(
		since: number,
		prog: (msg: string) => void
	): Promise<RemoteMapBuild | null> {
		const safeSince = since - CHANGES_SAFETY_WINDOW_MS;
		const changesResult = await this.fsXgkb.listAllChanges(safeSince);
		if (!changesResult.ok) {
			console.warn("[XGKB Sync] listChanges 失败，降级全量:", changesResult.error);
			return null;
		}

		const { items, serverTime } = changesResult.value;
		const watermarkCandidate = serverTime || Date.now();
		prog(`增量变更: ${items.length} 条`);

		const upsertById = new Map<string, (typeof items)[0]>();
		const deleteIds = new Set<string>();
		for (const item of items) {
			const id = String(item.fileId);
			if (item.event === "delete") deleteIds.add(id);
			else upsertById.set(id, item);
		}

		const allRecords = await this.db.getAll(this.scopeKey);
		const fileIdToRecord = new Map<string, SyncStateRecord>();
		for (const r of allRecords) fileIdToRecord.set(r.xgkbFileId, r);

		const knownUpsertIds: string[] = [];
		const unknownUpsertIds: string[] = [];
		for (const id of upsertById.keys()) {
			if (fileIdToRecord.has(id)) knownUpsertIds.push(id);
			else unknownUpsertIds.push(id);
		}
		prog(
			`变更分类: upsert已知=${knownUpsertIds.length} upsert新增=${unknownUpsertIds.length} delete=${deleteIds.size}`
		);

		const folderIdToPath = new Map<string, string>();
		const rootId = this.fsXgkb.getRootId();
		if (rootId) folderIdToPath.set(rootId, "");
		for (const record of allRecords) {
			const parts = record.localPath.split("/");
			const folderPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
			folderIdToPath.set(record.xgkbFolderId, folderPath);
		}

		type ResolvedNew = { id: string; path: string; item: (typeof items)[0] };
		const resolvedNewFiles: ResolvedNew[] = [];
		const unresolvedIds: string[] = [];

		for (const id of unknownUpsertIds) {
			const item = upsertById.get(id)!;
			const parentId = item.parentId != null ? String(item.parentId) : "";
			const folderPath = folderIdToPath.get(parentId);
			if (folderPath !== undefined) {
				const safeName = sanitizePathSegment(item.name || id);
				const filePath = folderPath ? `${folderPath}/${safeName}` : safeName;
				resolvedNewFiles.push({ id, path: filePath, item });
			} else {
				unresolvedIds.push(id);
			}
		}

		if (unresolvedIds.length > 0) {
			prog(`发现 ${unresolvedIds.length} 个文件位于全新目录，降级全量对账...`);
			return null;
		}
		if (resolvedNewFiles.length > 0) {
			prog(
				`路径重建成功 ${resolvedNewFiles.length} 个新文件：${resolvedNewFiles.map((f) => f.path).join(", ")}`
			);
		}

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

		if (knownUpsertIds.length > 0) {
			prog(`批量获取 ${knownUpsertIds.length} 个变更文件元数据...`);
			const metaMap = await this.fsXgkb.batchGetMetaAll(knownUpsertIds);
			for (const id of knownUpsertIds) {
				const meta = metaMap.get(id);
				const record = fileIdToRecord.get(id)!;
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

		for (const { id, path, item } of resolvedNewFiles) {
			map.set(path, {
				path,
				name: item.name || path.split("/").pop() || path,
				mtime: item.updateTime || Date.now(),
				xgkbFileId: id,
				xgkbFolderId: item.parentId != null ? String(item.parentId) : "",
			});
		}

		return { map, watermarkCandidate, scanMode: "incremental" };
	}

	private async fullRemoteMap(): Promise<RemoteMapBuild> {
		const remoteResult = await this.fsXgkb.listFiles();
		if (!remoteResult.ok) throw new Error(`扫描云端失败: ${remoteResult.error}`);
		const map = new Map<string, FileEntry>();
		let watermarkCandidate = 0;
		for (const f of remoteResult.value) {
			map.set(f.path, f);
			if (f.mtime > watermarkCandidate) watermarkCandidate = f.mtime;
		}
		if (watermarkCandidate <= 0) watermarkCandidate = Date.now();
		console.debug(
			`[XGKB Sync] 全量扫描完成: ${map.size} 个文件，候选水位=${watermarkCandidate} (${new Date(watermarkCandidate).toLocaleString("zh-CN")})`
		);
		return { map, watermarkCandidate, scanMode: "full" };
	}

	private async executePlan(plan: SyncPlan): Promise<void> {
		const { path, local, remote, record, op } = plan;
		try {
			switch (op) {
				case "upload-new":
					await this.doUploadNew(path, local!);
					break;
				case "upload-update":
					await this.doUploadUpdate(path, local!, remote!, record);
					break;
				case "download-new":
					await this.doDownload(path, remote!, record);
					break;
				case "download-update":
					await this.doDownload(path, remote!, record);
					break;
				case "delete-local":
					await this.doDeleteLocal(path, record!);
					break;
				case "delete-remote":
					await this.doDeleteRemote(record!);
					break;
				case "skip":
					this.stats.skipped++;
					break;
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.stats.failed++;
			this.stats.errors.push(`${path}: ${msg}`);
			console.error(`[XGKB Sync] 同步失败 ${path}:`, msg);
			if ((op === "download-new" || op === "download-update") && remote) {
				await this.recordDownloadFailure(path, remote, record, msg);
			}
		}
	}

	private decide(
		path: string,
		local: FileEntry | undefined,
		remote: FileEntry | undefined,
		record: SyncStateRecord | undefined
	): SyncOp {
		const dir = this.settings.syncDirection;

		if (record?.syncStatus === "failed") {
			if (!remote) return "skip";
			if (dir === "push") return "skip";
			return "download-update";
		}

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
			const localChanged = local.mtime > record.localMtime + MTIME_TOLERANCE_MS;
			const remoteChanged = remote.mtime > record.remoteMtime + MTIME_TOLERANCE_MS;

			if (!localChanged && !remoteChanged) return "skip";
			if (localChanged && !remoteChanged) return dir === "pull" ? "skip" : "upload-update";
			if (!localChanged && remoteChanged) return dir === "push" ? "skip" : "download-update";

			if (dir === "pull") return "download-update";
			if (dir === "push") return "upload-update";
			return local.mtime >= remote.mtime ? "upload-update" : "download-update";
		}

		return "skip";
	}

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

	private async recordDownloadFailure(
		path: string,
		remote: FileEntry,
		record: SyncStateRecord | undefined,
		msg: string
	): Promise<void> {
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: remote.xgkbFileId!,
				xgkbFolderId: record?.xgkbFolderId ?? remote.xgkbFolderId ?? "",
				localMtime: record?.localMtime ?? 0,
				remoteMtime: remote.mtime,
				syncStatus: "failed",
				lastError: msg,
			})
		);
	}

	private async doUploadNew(path: string, local: FileEntry): Promise<void> {
		const content = await this.fsLocal.readFile(path);
		const result = await this.fsXgkb.createFile(path, content);
		if (!result.ok) throw new Error(`上传失败: ${result.error}`);
		const remoteMtime = Date.now();
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: result.value.fileId,
				xgkbFolderId: result.value.folderId,
				localMtime: local.mtime,
				remoteMtime,
			})
		);
		this.successfulRemoteMtimes.push(remoteMtime);
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
		const remoteMtime = Date.now();
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: fileId,
				xgkbFolderId: record?.xgkbFolderId ?? remote.xgkbFolderId ?? "",
				localMtime: local.mtime,
				remoteMtime,
			})
		);
		this.successfulRemoteMtimes.push(remoteMtime);
		this.stats.uploaded++;
		this.progress(`↑ ${path}`);
	}

	private async doDownload(
		path: string,
		remote: FileEntry,
		record: SyncStateRecord | undefined
	): Promise<void> {
		const fid = remote.xgkbFileId!;
		const bodyResult = await this.fsXgkb.readFile(fid);
		if (!bodyResult.ok) throw new Error(`下载失败: ${bodyResult.error}`);

		const actualMtime = await this.fsLocal.writeFile(path, bodyResult.value);
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: fid,
				xgkbFolderId: record?.xgkbFolderId ?? remote.xgkbFolderId ?? "",
				localMtime: actualMtime,
				remoteMtime: remote.mtime,
				syncStatus: "done",
			})
		);
		this.successfulRemoteMtimes.push(remote.mtime);
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

type SyncOp =
	| "upload-new"
	| "upload-update"
	| "download-new"
	| "download-update"
	| "delete-local"
	| "delete-remote"
	| "skip";

type SyncPlan = {
	path: string;
	local: FileEntry | undefined;
	remote: FileEntry | undefined;
	record: SyncStateRecord | undefined;
	op: SyncOp;
};
