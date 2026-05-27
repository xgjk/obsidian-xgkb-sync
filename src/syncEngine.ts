import type {
	XgkbPluginSettings,
	FileEntry,
	SyncStateRecord,
	SyncStats,
	ProgressCallback,
	MoveFileResult,
	XgkbMetaItem,
	XgkbChangeItem,
} from "./types";
import { SyncStateDb } from "./syncStateDb";
import { FsLocal } from "./fsLocal";
import { FsXgkb } from "./fsXgkb";
import {
	DEFAULT_SETTINGS,
	DOWNLOAD_CONCURRENCY,
	UPLOAD_CONCURRENCY,
	EXECUTE_BATCH_PAUSE_MS,
	MTIME_TOLERANCE_MS,
	CHANGES_SAFETY_WINDOW_MS,
	DIR_RENAME_COVERAGE_RATIO,
	DIR_RENAME_MIN_FILES,
	XGKB_NODE_FOLDER,
} from "./constants";
import {
	formatSyncExtensionsLabel,
	normalizeSyncExtensions,
	pathMatchesSyncExtensions,
} from "./syncFileTypes";
import { sanitizePathSegment } from "./pathSanitize";
import {
	syncDiag,
	syncDiagFolderMapSnapshot,
	syncDiagHydrate,
	syncDiagKnownUpsert,
	syncDiagListChangesItems,
	syncDiagPathResolve,
	syncDiagReconcile,
	syncDiagFolderUpsertApply,
} from "./syncDiagnostics";

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
	/** 上传/rename-remote 完成后批量刷新远端 mtime（fileId → localPath） */
	private mtimeRefreshQueue = new Map<string, string>();

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

	private get syncExtensions(): readonly string[] {
		return normalizeSyncExtensions(this.settings.syncFileExtensions);
	}

	private emptyStats(): SyncStats {
		return {
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			skipped: 0,
			failed: 0,
			errors: [],
			renamed: 0,
			moved: 0,
		};
	}

	async runSync(onProgress?: ProgressCallback, since?: number): Promise<SyncStats> {
		this.stats = this.emptyStats();
		this.successfulRemoteMtimes = [];
		this.mtimeRefreshQueue.clear();
		this.progress = onProgress || (() => {});
		const prog = (msg: string) => {
			console.debug(`[XGKB Sync] ${msg}`);
			this.progress(msg);
		};

		prog("连接玄关知识库...");
		const initResult = await this.fsXgkb.init();
		if (!initResult.ok) throw new Error(`初始化失败: ${initResult.error}`);

		prog("扫描本地文件...");
		const localFiles = await this.fsLocal.listFiles();
		prog(`本地: ${localFiles.length} 个文件（${formatSyncExtensionsLabel(normalizeSyncExtensions(this.settings.syncFileExtensions))}）`);

		const remoteBuild = await this.buildRemoteMap(since, prog);
		let remoteMap = remoteBuild.map;
		prog(`云端: ${remoteMap.size} 个文件（${formatSyncExtensionsLabel(normalizeSyncExtensions(this.settings.syncFileExtensions))}，候选水位 ${remoteBuild.watermarkCandidate}）`);

		const retried = await this.injectFailedRetries(remoteMap, prog);
		this.stats.retriedFailed = retried;
		if (retried > 0) {
			prog(`失败重试队列: ${retried} 个文件已并入本轮`);
		}

		const localMap = new Map<string, FileEntry>();
		for (const f of localFiles) localMap.set(f.path, f);

		const allRecords = await this.db.getAll(this.scopeKey);
		const recordMap = new Map<string, SyncStateRecord>();
		for (const r of allRecords) recordMap.set(r.localPath, r);

		const consumedPaths = new Set<string>();
		const rawReconcilePlans = this.buildPathReconcilePlans(
			localMap,
			remoteMap,
			recordMap,
			prog,
			consumedPaths
		);
		const reconcilePlans = await this.collapseDirectoryReconcilePlans(
			rawReconcilePlans,
			allRecords,
			prog
		);
		// collapse 可能新增 consume 路径
		for (const plan of reconcilePlans) {
			if (!plan.isDirectory) continue;
			for (const p of plan.consumedPaths ?? []) consumedPaths.add(p);
		}

		const allPaths = new Set<string>([
			...localMap.keys(),
			...remoteMap.keys(),
			...recordMap.keys(),
		]);
		prog(`共 ${allPaths.size} 个路径需要处理（含 rename ${reconcilePlans.length}）`);

		const plans: SyncPlan[] = [...reconcilePlans];
		let idx = 0;
		const pathCount = allPaths.size;
		for (const path of allPaths) {
			if (consumedPaths.has(path)) continue;
			idx++;
			if (idx % 50 === 0 || idx === pathCount) prog(`决策中 ${idx}/${pathCount}...`);
			const local = localMap.get(path);
			const remote = remoteMap.get(path);
			const record = recordMap.get(path);
			const op = this.decide(path, local, remote, record);
			plans.push({ path, local, remote, record, op });
		}

		const renameLocalPlans = plans.filter((p) => p.op === "rename-local");
		const renameRemotePlans = plans.filter((p) => p.op === "rename-remote");
		const deletePlans = plans.filter((p) => p.op === "delete-local" || p.op === "delete-remote");
		const downloadPlans = plans.filter((p) => p.op === "download-new" || p.op === "download-update");
		const uploadPlans = plans.filter((p) => p.op === "upload-new" || p.op === "upload-update");
		const skipCount = plans.filter((p) => p.op === "skip").length;
		this.stats.skipped += skipCount;

		for (const plan of renameLocalPlans) {
			await this.executePlan(plan);
		}
		for (const plan of deletePlans) {
			await this.executePlan(plan);
		}

		if (downloadPlans.length > 0) {
			prog(`开始下载 ${downloadPlans.length} 个文件（并发 ${DOWNLOAD_CONCURRENCY}）...`);
			let done = 0;
			await this.runWithConcurrency(downloadPlans, DOWNLOAD_CONCURRENCY, async (plan) => {
				await this.executePlan(plan);
				done++;
				if (done % 5 === 0 || done === downloadPlans.length) {
					prog(`下载进度 ${done}/${downloadPlans.length}（↓${this.stats.downloaded} 失败 ${this.stats.failed}）`);
				}
			});
		}

		for (const plan of renameRemotePlans) {
			await this.executePlan(plan);
		}

		if (uploadPlans.length > 0) {
			prog(`开始上传 ${uploadPlans.length} 个文件（并发 ${UPLOAD_CONCURRENCY}）...`);
			let done = 0;
			await this.runWithConcurrency(uploadPlans, UPLOAD_CONCURRENCY, async (plan) => {
				await this.executePlan(plan);
				done++;
				if (done % 3 === 0 || done === uploadPlans.length) {
					prog(`上传进度 ${done}/${uploadPlans.length}（↑${this.stats.uploaded} 失败 ${this.stats.failed}）`);
				}
				if (done % UPLOAD_CONCURRENCY === 0) {
					await this.delay(EXECUTE_BATCH_PAUSE_MS);
				}
			});
		}

		await this.flushMtimeRefreshQueue();

		this.stats.newSince = this.computeCommittedWatermark(remoteBuild);

		prog(
			`完成: ↑${this.stats.uploaded} ↓${this.stats.downloaded} ↻${this.stats.renamed ?? 0} ✗${this.stats.deleted} fail:${this.stats.failed} ∅${this.stats.skipped} 水位=${this.stats.newSince ?? "-"}`
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

		const folderIdToPath = this.buildFolderIdToPathFromRecords(all);
		const parentIds: string[] = [];
		for (const meta of metaMap.values()) {
			if (meta.parentId != null) parentIds.push(String(meta.parentId));
		}
		await this.hydrateFolderIdToPath(folderIdToPath, parentIds, prog);

		let injected = 0;
		for (const record of failed) {
			const meta = metaMap.get(record.xgkbFileId);
			if (meta?.deleted) {
				await this.db.delete(this.scopeKey, record.localPath);
				prog(`云端已删除，清除失败记录: ${record.localPath}`);
				continue;
			}
			const remotePath = meta
				? this.remotePathFromMeta(meta, folderIdToPath, record.localPath)
				: record.localPath;
			if (!pathMatchesSyncExtensions(remotePath, this.syncExtensions)) continue;
			if (remoteMap.has(remotePath)) continue;
			const mtime = meta?.updateTime ?? record.remoteMtime;
			remoteMap.set(remotePath, {
				path: remotePath,
				name: meta?.name || remotePath.split("/").pop() || remotePath,
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
		return injected;
	}

	private async delay(ms: number): Promise<void> {
		return new Promise((resolve) => window.setTimeout(resolve, ms));
	}

	/** 同 fileId 路径不一致 → rename 计划（零额外 KB list 调用） */
	private buildPathReconcilePlans(
		localMap: Map<string, FileEntry>,
		remoteMap: Map<string, FileEntry>,
		recordMap: Map<string, SyncStateRecord>,
		prog: (msg: string) => void,
		consumed: Set<string>
	): SyncPlan[] {
		const plans: SyncPlan[] = [];
		const dir = this.settings.syncDirection;
		const fileIdToRemote = new Map<string, FileEntry>();
		for (const remote of remoteMap.values()) {
			if (remote.xgkbFileId) fileIdToRemote.set(remote.xgkbFileId, remote);
		}

		for (const record of recordMap.values()) {
			const remote = fileIdToRemote.get(record.xgkbFileId);
			if (!remote) {
				syncDiagReconcile("skip", record.xgkbFileId, {
					reason: "remoteMap 中无此 fileId",
					recordPath: record.localPath,
					syncStatus: record.syncStatus,
				});
				continue;
			}
			if (remote.path === record.localPath) continue;

			const localAtRecord = localMap.get(record.localPath);
			const localAtRemote = localMap.get(remote.path);
			syncDiagReconcile("match", record.xgkbFileId, {
				recordPath: record.localPath,
				remotePath: remote.path,
				localAtRecord: Boolean(localAtRecord),
				localAtRemote: Boolean(localAtRemote),
			});

			// 本地已在目标路径、IDB 仍指向旧路径 → 仅对齐路径（含 failed 记录）
			if (localAtRemote && !localAtRecord && remote.path !== record.localPath) {
				let op: "rename-local" | "rename-remote";
				if (dir === "pull") {
					op = "rename-local";
				} else if (dir === "push") {
					op = "rename-remote";
				} else {
					op =
						localAtRemote.mtime >= remote.mtime ? "rename-remote" : "rename-local";
				}
				if (op === "rename-local") {
					plans.push({
						path: record.localPath,
						targetPath: remote.path,
						local: localAtRemote,
						remote,
						record,
						op: "rename-local",
					});
				} else {
					plans.push({
						path: remote.path,
						remoteOldPath: record.localPath,
						local: localAtRemote,
						remote,
						record,
						op: "rename-remote",
					});
				}
				consumed.add(record.localPath);
				consumed.add(remote.path);
				continue;
			}

			if (!localAtRecord || localAtRemote) {
				syncDiagReconcile("skip", record.xgkbFileId, {
					reason: !localAtRecord
						? "本地无 record.localPath 文件"
						: "remote.path 已被其他本地文件占用",
					recordPath: record.localPath,
					remotePath: remote.path,
					localAtRecord: Boolean(localAtRecord),
					localAtRemote: Boolean(localAtRemote),
				});
				continue;
			}

			let op: "rename-local" | "rename-remote" | null = null;
			if (dir === "pull") {
				op = "rename-local";
			} else if (dir === "push") {
				op = "rename-remote";
			} else {
				// 双向：mtime 较新的一侧为权威，避免同时生成两种 rename
				op =
					localAtRecord.mtime >= remote.mtime
						? "rename-remote"
						: "rename-local";
			}

			if (op === "rename-local") {
				syncDiagReconcile("plan", record.xgkbFileId, {
					op: "rename-local",
					from: record.localPath,
					to: remote.path,
				});
				plans.push({
					path: record.localPath,
					targetPath: remote.path,
					local: localAtRecord,
					remote,
					record,
					op: "rename-local",
				});
			} else {
				plans.push({
					path: record.localPath,
					remoteOldPath: remote.path,
					local: localAtRecord,
					remote,
					record,
					op: "rename-remote",
				});
			}
			consumed.add(record.localPath);
			consumed.add(remote.path);
		}

		if (plans.length > 0) {
			prog(`fileId 路径对账: ${plans.length} 个 rename/move`);
		} else {
			syncDiag("reconcile 未生成计划（所有 fileId 的 remote.path === record.localPath 或已 skip）");
		}
		return plans;
	}

	/** 将同前缀变更的多文件 rename 聚合为目录级计划（1 次 folder API） */
	private async collapseDirectoryReconcilePlans(
		plans: SyncPlan[],
		allRecords: SyncStateRecord[],
		prog: (msg: string) => void
	): Promise<SyncPlan[]> {
		const renamePlans = plans.filter((p) => p.op === "rename-local" || p.op === "rename-remote");
		const others = plans.filter((p) => p.op !== "rename-local" && p.op !== "rename-remote");
		if (renamePlans.length === 0) return plans;

		type Group = { op: "rename-local" | "rename-remote"; oldPrefix: string; newPrefix: string; items: SyncPlan[] };
		const groups = new Map<string, Group>();

		for (const plan of renamePlans) {
			const op = plan.op as "rename-local" | "rename-remote";
			const oldPath = op === "rename-local" ? plan.path : plan.remoteOldPath || plan.remote?.path;
			const newPath = op === "rename-local" ? plan.targetPath : plan.path;
			if (!oldPath || !newPath) continue;
			const prefix = deriveDirPrefixChange(oldPath, newPath);
			if (!prefix) continue;
			const key = `${op}\0${prefix.oldPrefix}\0${prefix.newPrefix}`;
			if (!groups.has(key)) {
				groups.set(key, { op, ...prefix, items: [] });
			}
			groups.get(key)!.items.push(plan);
		}

		const collapsed: SyncPlan[] = [...others];
		const consumed = new Set<SyncPlan>();

		for (const group of groups.values()) {
			const countPrefix = group.op === "rename-local" ? group.oldPrefix : group.newPrefix;
			const totalUnderPrefix = allRecords.filter(
				(r) =>
					r.syncStatus !== "failed" &&
					(r.localPath === countPrefix || r.localPath.startsWith(`${countPrefix}/`))
			).length;
			const meetsThreshold =
				group.items.length >= DIR_RENAME_MIN_FILES &&
				totalUnderPrefix > 0 &&
				group.items.length >= totalUnderPrefix * DIR_RENAME_COVERAGE_RATIO;

			if (!meetsThreshold) {
				for (const item of group.items) collapsed.push(item);
				continue;
			}

			for (const item of group.items) consumed.add(item);

			const affectedRecords = group.items
				.map((p) => p.record)
				.filter((r): r is SyncStateRecord => r != null);
			const consumedPaths = new Set<string>();
			for (const item of group.items) {
				consumedPaths.add(item.path);
				if (item.targetPath) consumedPaths.add(item.targetPath);
				if (item.remoteOldPath) consumedPaths.add(item.remoteOldPath);
				if (item.remote?.path) consumedPaths.add(item.remote.path);
			}

			let remoteFolderFileId = pickDirectChildFolderId(affectedRecords, group.oldPrefix);
			if (!remoteFolderFileId) {
				const resolved = await this.fsXgkb.resolveFolderIdForRelativePath(group.oldPrefix);
				if (resolved.ok) remoteFolderFileId = resolved.value;
			}

			const newFolderName = group.newPrefix.split("/").pop() || group.newPrefix;
			collapsed.push({
				op: group.op,
				isDirectory: true,
				path: group.oldPrefix,
				directoryOldPath: group.oldPrefix,
				directoryNewPath: group.newPrefix,
				newFolderName,
				remoteFolderFileId,
				affectedRecords,
				consumedPaths: [...consumedPaths],
				local: group.items[0]?.local,
				remote: group.items[0]?.remote,
				record: group.items[0]?.record,
			});
		}

		for (const plan of renamePlans) {
			if (!consumed.has(plan)) collapsed.push(plan);
		}

		const dirCount = collapsed.filter((p) => p.isDirectory).length;
		if (dirCount > 0) prog(`目录级 rename/move: ${dirCount} 组（由 ${renamePlans.length} 个文件计划聚合）`);
		return collapsed;
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
		const folderUpsertIds: string[] = [];
		for (const [id, item] of upsertById) {
			if (item.type === XGKB_NODE_FOLDER) {
				folderUpsertIds.push(id);
				continue;
			}
			if (fileIdToRecord.has(id)) knownUpsertIds.push(id);
			else unknownUpsertIds.push(id);
		}
		prog(
			`变更分类: upsert已知=${knownUpsertIds.length} upsert新增=${unknownUpsertIds.length} delete=${deleteIds.size} 目录=${folderUpsertIds.length}`
		);
		if (items.length > 0 && items.length <= 30) {
			syncDiagListChangesItems(items);
		}

		const folderIdToPath = this.buildFolderIdToPathFromRecords(allRecords);

		// 目录 upsert 需先补齐父目录链，否则 applyFolderUpserts 会因 parentPath===undefined 静默跳过
		const folderUpsertParentIds: string[] = [];
		for (const id of folderUpsertIds) {
			const item = upsertById.get(id)!;
			if (item.parentId != null) folderUpsertParentIds.push(String(item.parentId));
		}
		if (folderUpsertParentIds.length > 0) {
			syncDiagHydrate("目录 upsert 前先补齐父目录", {
				folderUpsertIds,
				parentIds: [...new Set(folderUpsertParentIds)],
			});
			if (!(await this.hydrateFolderIdToPath(folderIdToPath, folderUpsertParentIds, prog))) {
				return null;
			}
		}

		const folderUpsertResults = this.applyFolderUpsertsToPathMap(upsertById, folderIdToPath);
		if (folderUpsertResults.length > 0) {
			syncDiagFolderUpsertApply(folderUpsertResults);
			const skipped = folderUpsertResults.filter((r) => r.status === "skipped_parent_unknown");
			if (skipped.length > 0) {
				prog(`目录 upsert 无法解析父路径 (${skipped.length} 条)，降级全量对账...`);
				return null;
			}
		}

		if (knownUpsertIds.length > 0 || folderUpsertIds.length > 0) {
			const seedIds = new Set<string>([...folderUpsertIds, ...folderUpsertParentIds]);
			for (const id of knownUpsertIds) {
				const r = fileIdToRecord.get(id)!;
				seedIds.add(r.xgkbFolderId);
				const item = upsertById.get(id)!;
				if (item.parentId != null) seedIds.add(String(item.parentId));
			}
			syncDiagFolderMapSnapshot("applyFolderUpserts 后 folderIdToPath（相关 id）", folderIdToPath, seedIds);
		}

		let knownMetaMap = new Map<string, XgkbMetaItem>();
		if (knownUpsertIds.length > 0) {
			prog(`批量获取 ${knownUpsertIds.length} 个变更文件元数据...`);
			knownMetaMap = await this.fsXgkb.batchGetMetaAll(knownUpsertIds);
		}

		const folderIdsToHydrate: string[] = [];
		for (const id of knownUpsertIds) {
			const item = upsertById.get(id)!;
			const meta = knownMetaMap.get(id);
			const record = fileIdToRecord.get(id)!;
			const parentId = this.effectiveParentId(item, meta);
			if (!parentId) continue;
			// parent 变更或未知目录 → 补齐路径链
			if (parentId !== record.xgkbFolderId || !folderIdToPath.has(parentId)) {
				folderIdsToHydrate.push(parentId);
			}
		}
		for (const id of unknownUpsertIds) {
			const item = upsertById.get(id)!;
			if (item.parentId != null) folderIdsToHydrate.push(String(item.parentId));
		}
		if (folderIdsToHydrate.length > 0) {
			syncDiagHydrate("待补齐目录链", {
				seedFolderIds: [...new Set(folderIdsToHydrate.map(String))],
			});
		}
		if (!(await this.hydrateFolderIdToPath(folderIdToPath, folderIdsToHydrate, prog))) {
			return null;
		}
		if (knownUpsertIds.length > 0) {
			const afterHydrate = new Set<string>();
			for (const id of knownUpsertIds) {
				const r = fileIdToRecord.get(id)!;
				const item = upsertById.get(id)!;
				const meta = knownMetaMap.get(id);
				afterHydrate.add(r.xgkbFolderId);
				if (item.parentId != null) afterHydrate.add(String(item.parentId));
				if (meta?.parentId != null) afterHydrate.add(String(meta.parentId));
			}
			syncDiagFolderMapSnapshot("hydrate 后 folderIdToPath（相关 id）", folderIdToPath, afterHydrate);
		}

		type ResolvedNew = { id: string; path: string; item: (typeof items)[0] };
		const resolvedNewFiles: ResolvedNew[] = [];
		const unresolvedIds: string[] = [];

		for (const id of unknownUpsertIds) {
			const item = upsertById.get(id)!;
			if (item.type === XGKB_NODE_FOLDER) continue;
			const parentId = item.parentId != null ? String(item.parentId) : "";
			const folderPath = folderIdToPath.get(parentId);
			if (folderPath !== undefined) {
				const safeName = sanitizePathSegment(item.name || id);
				const filePath = folderPath ? `${folderPath}/${safeName}` : safeName;
				if (!pathMatchesSyncExtensions(filePath, this.syncExtensions)) continue;
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
			const remotePath = this.remotePathForRecord(record, folderIdToPath);
			map.set(remotePath, {
				path: remotePath,
				name: remotePath.split("/").pop() || remotePath,
				mtime: record.remoteMtime,
				xgkbFileId: id,
				xgkbFolderId: record.xgkbFolderId,
			});
		}

		if (knownUpsertIds.length > 0) {
			for (const id of knownUpsertIds) {
				const item = upsertById.get(id)!;
				const meta = knownMetaMap.get(id);
				const record = fileIdToRecord.get(id)!;
				if (!meta) {
					prog(`变更文件 meta 缺失 fileId=${id}，降级全量对账...`);
					return null;
				}
				if (meta.deleted) {
					syncDiag("knownUpsert 跳过: meta.deleted", { fileId: id });
					continue;
				}
				syncDiagKnownUpsert(id, record, item, meta, folderIdToPath);

				const newParentId = this.effectiveParentId(item, meta);
				const fileNameUsed = item.name ?? meta.name;
				const folderPathFromMap = newParentId ? folderIdToPath.get(newParentId) : undefined;
				const remotePath = this.remotePathFromParent(
					newParentId,
					fileNameUsed,
					folderIdToPath,
					record.localPath
				);
				const usedFallback =
					remotePath === record.localPath && (!newParentId || folderPathFromMap === undefined);
				syncDiagPathResolve(id, record.localPath, remotePath, {
					parentIdUsed: newParentId,
					fileNameUsed: fileNameUsed || record.localPath.split("/").pop() || "",
					folderPathFromMap,
					usedFallback,
				});

				if (newParentId && newParentId !== record.xgkbFolderId && remotePath === record.localPath) {
					syncDiag("parentId 已变但路径未变 → 降级全量", {
						fileId: id,
						oldParentId: record.xgkbFolderId,
						newParentId,
						folderPathFromMap: folderPathFromMap ?? null,
					});
					prog(`移动后路径无法从增量重建，降级全量对账...`);
					return null;
				}
				if (!pathMatchesSyncExtensions(remotePath, this.syncExtensions)) continue;
				map.set(remotePath, {
					path: remotePath,
					name: item.name || meta.name || remotePath.split("/").pop() || remotePath,
					mtime: item.updateTime || meta.updateTime || record.remoteMtime,
					xgkbFileId: id,
					xgkbFolderId: newParentId || record.xgkbFolderId,
				});
			}
		}

		for (const { id, path, item } of resolvedNewFiles) {
			if (!pathMatchesSyncExtensions(path, this.syncExtensions)) continue;
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

	private buildFolderIdToPathFromRecords(records: SyncStateRecord[]): Map<string, string> {
		const folderIdToPath = new Map<string, string>();
		const rootId = this.fsXgkb.getRootId();
		if (rootId) folderIdToPath.set(rootId, "");
		for (const record of records) {
			const parts = record.localPath.split("/");
			const folderPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
			folderIdToPath.set(record.xgkbFolderId, folderPath);
		}
		return folderIdToPath;
	}

	/** listChanges 中的目录 upsert → 更新 folderId 对应路径（远端目录改名/新建） */
	private applyFolderUpsertsToPathMap(
		upsertById: Map<string, { type?: number; fileId: string | number; parentId?: string | number; name?: string }>,
		folderIdToPath: Map<string, string>
	): Array<{
		folderId: string;
		name: string;
		parentId: string;
		oldPath: string | null;
		newPath: string | null;
		status: "applied" | "skipped_parent_unknown" | "unchanged";
	}> {
		const results: Array<{
			folderId: string;
			name: string;
			parentId: string;
			oldPath: string | null;
			newPath: string | null;
			status: "applied" | "skipped_parent_unknown" | "unchanged";
		}> = [];
		let changed = true;
		let pass = 0;
		const maxPasses = upsertById.size + 1;
		while (changed && pass < maxPasses) {
			pass++;
			changed = false;
			for (const item of upsertById.values()) {
				if (item.type !== XGKB_NODE_FOLDER) continue;
				const folderId = String(item.fileId);
				const parentId = item.parentId != null ? String(item.parentId) : "";
				const oldPath = folderIdToPath.get(folderId) ?? null;
				const parentPath = folderIdToPath.get(parentId);
				if (parentPath === undefined) {
					if (pass === 1) {
						results.push({
							folderId,
							name: item.name || folderId,
							parentId,
							oldPath,
							newPath: null,
							status: "skipped_parent_unknown",
						});
					}
					continue;
				}
				const seg = sanitizePathSegment(item.name || folderId);
				const nextPath = parentPath ? `${parentPath}/${seg}` : seg;
				if (folderIdToPath.get(folderId) !== nextPath) {
					folderIdToPath.set(folderId, nextPath);
					changed = true;
					const existing = results.find((r) => r.folderId === folderId);
					if (existing) {
						existing.newPath = nextPath;
						existing.status = "applied";
					} else {
						results.push({
							folderId,
							name: item.name || folderId,
							parentId,
							oldPath,
							newPath: nextPath,
							status: "applied",
						});
					}
				} else if (pass === 1 && !results.some((r) => r.folderId === folderId)) {
					results.push({
						folderId,
						name: item.name || folderId,
						parentId,
						oldPath,
						newPath: nextPath,
						status: "unchanged",
					});
				}
			}
		}
		return results;
	}

	/**
	 * 通过 batchGetMeta 向上补齐缺失的 folderId→路径（跨目录 move 时中间目录可能不在本地 IDB 中）。
	 */
	private async hydrateFolderIdToPath(
		folderIdToPath: Map<string, string>,
		seedFolderIds: Iterable<string>,
		prog: (msg: string) => void
	): Promise<boolean> {
		const rootId = this.fsXgkb.getRootId();
		if (rootId) folderIdToPath.set(rootId, "");

		const pending = new Set<string>();
		for (const id of seedFolderIds) {
			const sid = String(id);
			if (sid && sid !== rootId && !folderIdToPath.has(sid)) pending.add(sid);
		}
		if (pending.size === 0) {
			syncDiagHydrate("无需请求（seed 均已在 folderIdToPath 中）", {
				seedCount: [...seedFolderIds].length,
			});
			return true;
		}

		syncDiagHydrate("开始请求目录 meta", { pendingIds: [...pending] });

		const metaById = new Map<string, XgkbMetaItem>();
		const maxFetchRounds = 32;
		let fetchRound = 0;

		while (pending.size > 0 && fetchRound < maxFetchRounds) {
			fetchRound++;
			const batch = [...pending];
			pending.clear();
			const fetched = await this.fsXgkb.batchGetMetaAll(batch);
			for (const id of batch) {
				const meta = fetched.get(id);
				if (!meta || meta.deleted) {
					prog(`目录元数据缺失 fileId=${id}，降级全量对账...`);
					return false;
				}
				metaById.set(id, meta);
				syncDiagHydrate("目录 meta", {
					folderId: id,
					name: meta.name,
					parentId: meta.parentId != null ? String(meta.parentId) : null,
				});
				const parentId = meta.parentId != null ? String(meta.parentId) : "";
				if (parentId && parentId !== id && parentId !== rootId && !folderIdToPath.has(parentId)) {
					pending.add(parentId);
				}
			}
		}
		if (pending.size > 0) {
			prog("目录链路过深或未解析，降级全量对账...");
			return false;
		}

		let changed = true;
		let assignPass = 0;
		while (changed && assignPass < metaById.size + 1) {
			assignPass++;
			changed = false;
			for (const [folderId, meta] of metaById) {
				const parentId = meta.parentId != null ? String(meta.parentId) : "";
				const parentPath =
					parentId === rootId || parentId === "" || parentId === "0"
						? folderIdToPath.has(rootId || "") || parentId === rootId
							? ""
							: undefined
						: folderIdToPath.get(parentId);
				if (parentPath === undefined) continue;
				const seg = sanitizePathSegment(meta.name || folderId);
				const nextPath = parentPath ? `${parentPath}/${seg}` : seg;
				if (folderIdToPath.get(folderId) !== nextPath) {
					folderIdToPath.set(folderId, nextPath);
					changed = true;
				}
			}
		}

		for (const folderId of metaById.keys()) {
			if (!folderIdToPath.has(folderId)) {
				prog(`无法解析目录路径 folderId=${folderId}，降级全量对账...`);
				return false;
			}
		}

		if (metaById.size > 0) {
			prog(`补充解析 ${metaById.size} 个目录路径`);
		}
		return true;
	}

	private remotePathForRecord(record: SyncStateRecord, folderIdToPath: Map<string, string>): string {
		const fileName = record.localPath.split("/").pop() || record.localPath;
		const folderPath = folderIdToPath.get(record.xgkbFolderId);
		if (folderPath === undefined) return record.localPath;
		return folderPath ? `${folderPath}/${fileName}` : fileName;
	}

	private effectiveParentId(item?: XgkbChangeItem, meta?: XgkbMetaItem): string {
		// 优先 listChanges item，其次 batchGetMeta（具体以 [diag] 日志对比为准）
		if (item?.parentId != null) return String(item.parentId);
		if (meta?.parentId != null) return String(meta.parentId);
		return "";
	}

	private remotePathFromParent(
		parentId: string,
		fileName: string | undefined,
		folderIdToPath: Map<string, string>,
		fallback: string
	): string {
		if (!parentId) return fallback;
		const folderPath = folderIdToPath.get(parentId);
		if (folderPath === undefined) return fallback;
		const name = sanitizePathSegment(fileName || fallback.split("/").pop() || fallback);
		return folderPath ? `${folderPath}/${name}` : name;
	}

	private remotePathFromMeta(
		meta: XgkbMetaItem,
		folderIdToPath: Map<string, string>,
		fallback: string
	): string {
		return this.remotePathFromParent(
			meta.parentId != null ? String(meta.parentId) : "",
			meta.name,
			folderIdToPath,
			fallback
		);
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
					await this.doUploadUpdate(path, local!, remote, record);
					break;
				case "download-new":
				case "download-update":
					await this.doDownload(path, remote!, record);
					break;
				case "rename-local":
					if (plan.isDirectory) await this.doRenameLocalDirectory(plan);
					else await this.doRenameLocal(plan);
					break;
				case "rename-remote":
					if (plan.isDirectory) {
						const oldParent = parentPathOf(plan.directoryOldPath ?? "");
						const newParent = parentPathOf(plan.directoryNewPath ?? "");
						if (oldParent === newParent) await this.doRenameRemoteDirectory(plan);
						else await this.doMoveRemoteDirectory(plan);
					} else {
						await this.doRenameRemote(plan);
					}
					break;
				case "delete-local":
					await this.doDeleteLocal(path, record!);
					break;
				case "delete-remote":
					await this.doDeleteRemote(record!);
					break;
				case "skip":
					break;
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.stats.failed++;
			this.stats.errors.push(`${path}: ${msg}`);
			console.error(`[XGKB Sync] 同步失败 ${path}:`, msg);
			if (op !== "skip" && op !== "delete-local" && op !== "delete-remote") {
				const failRecords =
					plan.isDirectory && plan.affectedRecords?.length
						? plan.affectedRecords
						: record
							? [record]
							: [];
				for (const r of failRecords) {
					await this.recordFailure(r.localPath, remote, r, msg);
				}
				if (failRecords.length === 0) {
					await this.recordFailure(path, remote, record, msg);
				}
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
			if (!remote) {
				return local && dir !== "pull" ? "upload-new" : "skip";
			}
			if (dir === "pull") return "download-update";
			if (dir === "push") return local ? "upload-update" : "skip";
			if (!local) return "download-update";
			return local.mtime >= remote.mtime ? "upload-update" : "download-update";
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
			if (localChanged) return "upload-new";
			// 有 fileId 时远端可能只是增量 map 漏报，避免误删本地
			if (record.xgkbFileId) return "skip";
			return "delete-local";
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

	private async recordFailure(
		path: string,
		remote: FileEntry | undefined,
		record: SyncStateRecord | undefined,
		msg: string
	): Promise<void> {
		const fileId = remote?.xgkbFileId ?? record?.xgkbFileId;
		if (!fileId) return;
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: fileId,
				xgkbFolderId: record?.xgkbFolderId ?? remote?.xgkbFolderId ?? "",
				localMtime: record?.localMtime ?? 0,
				remoteMtime: remote?.mtime ?? record?.remoteMtime ?? 0,
				syncStatus: "failed",
				lastError: msg,
			})
		);
	}

	private queueMtimeRefresh(fileId: string, localPath: string): void {
		this.mtimeRefreshQueue.set(fileId, localPath);
	}

	/** 批次结束后一次 batchGetMeta，避免上传/rename 逐文件查 meta */
	private async flushMtimeRefreshQueue(): Promise<void> {
		if (this.mtimeRefreshQueue.size === 0) return;
		const pending = [...this.mtimeRefreshQueue.entries()];
		this.mtimeRefreshQueue.clear();

		const metaMap = await this.fsXgkb.batchGetMetaAll(pending.map(([id]) => id));
		for (const [fileId, localPath] of pending) {
			const meta = metaMap.get(fileId);
			if (meta?.updateTime == null) continue;
			const record = await this.db.get(this.scopeKey, localPath);
			if (!record) continue;
			await this.db.put({ ...record, remoteMtime: meta.updateTime, lastSyncAt: Date.now() });
			this.successfulRemoteMtimes.push(meta.updateTime);
		}
	}

	private async doUploadNew(path: string, local: FileEntry): Promise<void> {
		const content = await this.fsLocal.readFile(path);
		const result = await this.fsXgkb.createFile(path, content);
		if (!result.ok) throw new Error(`上传失败: ${result.error}`);
		const fileId = result.value.fileId;
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: fileId,
				xgkbFolderId: result.value.folderId,
				localMtime: local.mtime,
				remoteMtime: Date.now(),
				syncStatus: "done",
			})
		);
		this.queueMtimeRefresh(fileId, path);
		this.stats.uploaded++;
		this.progress(`↑ ${path}`);
	}

	private async doUploadUpdate(
		path: string,
		local: FileEntry,
		remote: FileEntry | undefined,
		record: SyncStateRecord | undefined
	): Promise<void> {
		const fileId = remote?.xgkbFileId ?? record?.xgkbFileId;
		if (!fileId) throw new Error("缺少云端文件 ID，无法更新");
		const content = await this.fsLocal.readFile(path);
		const fileName = path.split("/").pop() || path;
		const result = await this.fsXgkb.updateFile(fileId, fileName, content);
		if (!result.ok) throw new Error(`更新失败: ${result.error}`);
		const interimMtime = remote?.mtime ?? record?.remoteMtime ?? Date.now();
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: fileId,
				xgkbFolderId: record?.xgkbFolderId ?? remote?.xgkbFolderId ?? "",
				localMtime: local.mtime,
				remoteMtime: interimMtime,
				syncStatus: "done",
			})
		);
		this.queueMtimeRefresh(fileId, path);
		this.stats.uploaded++;
		this.progress(`↑ ${path}`);
	}

	private async doRenameLocal(plan: SyncPlan): Promise<void> {
		const { record, local, targetPath } = plan;
		if (!record || !local || !targetPath) throw new Error("rename-local 参数不完整");

		let actualMtime = local.mtime;
		if (record.localPath !== targetPath) {
			try {
				actualMtime = await this.fsLocal.renameFile(record.localPath, targetPath);
			} catch (e) {
				// IDB 路径滞后：文件已在目标位置，仅迁键
				const atTarget = await this.fsLocal.getMtime(targetPath);
				if (atTarget == null) throw e;
				actualMtime = atTarget;
			}
		}

		await this.db.delete(this.scopeKey, record.localPath);
		await this.db.put(
			this.buildDbRecord(targetPath, {
				xgkbFileId: record.xgkbFileId,
				xgkbFolderId: plan.remote?.xgkbFolderId ?? record.xgkbFolderId,
				localMtime: actualMtime,
				remoteMtime: plan.remote?.mtime ?? record.remoteMtime,
				syncStatus: "done",
			})
		);
		this.stats.renamed = (this.stats.renamed ?? 0) + 1;
		this.progress(`↻ 本地 ${record.localPath} → ${targetPath}`);
	}

	private async doRenameRemote(plan: SyncPlan): Promise<void> {
		const { local, path, remote, remoteOldPath } = plan;
		let { record } = plan;
		if (!record || !local || !remote) throw new Error("rename-remote 参数不完整");
		const fileId = record.xgkbFileId;
		const oldRemotePath = remoteOldPath || remote.path;
		const newFileName = path.split("/").pop() || path;
		const oldParent = parentPathOf(oldRemotePath);
		const newParent = parentPathOf(path);

		if (oldParent === newParent) {
			const r = await this.fsXgkb.renameRemoteFile(fileId, newFileName);
			if (!r.ok) throw new Error(r.error);
			this.stats.renamed = (this.stats.renamed ?? 0) + 1;
		} else {
			const folderResult = await this.fsXgkb.resolveFolderIdForRelativePath(newParent);
			if (!folderResult.ok) throw new Error(folderResult.error);
			const targetFolderId = folderResult.value;
			const moveResult = await this.fsXgkb.moveRemoteFile(fileId, targetFolderId);
			if (!moveResult.ok) throw new Error(moveResult.error);
			const oldName = oldRemotePath.split("/").pop() || "";
			if (oldName !== newFileName) {
				const renameResult = await this.fsXgkb.renameRemoteFile(fileId, newFileName);
				if (!renameResult.ok) throw new Error(renameResult.error);
			}
			this.stats.moved = (this.stats.moved ?? 0) + 1;
			record = { ...record, xgkbFolderId: targetFolderId };
		}

		const interimMtime = plan.remote?.mtime ?? record.remoteMtime;
		await this.db.put(
			this.buildDbRecord(path, {
				xgkbFileId: fileId,
				xgkbFolderId: record.xgkbFolderId,
				localMtime: local.mtime,
				remoteMtime: interimMtime,
				syncStatus: "done",
			})
		);
		this.queueMtimeRefresh(fileId, path);
		this.progress(`↻ 远端 → ${path}`);
	}

	private async doRenameLocalDirectory(plan: SyncPlan): Promise<void> {
		const oldPrefix = plan.directoryOldPath;
		const newPrefix = plan.directoryNewPath;
		if (!oldPrefix || !newPrefix) throw new Error("rename-local(目录) 参数不完整");

		await this.fsLocal.renameFolder(oldPrefix, newPrefix);
		const moved = await this.db.relocateRecordsByPrefix(this.scopeKey, oldPrefix, newPrefix);
		this.stats.renamed = (this.stats.renamed ?? 0) + 1;
		this.progress(`↻ 本地目录 ${oldPrefix} → ${newPrefix}（${moved} 个文件）`);
	}

	private async doRenameRemoteDirectory(plan: SyncPlan): Promise<void> {
		const {
			directoryOldPath: oldPrefix,
			directoryNewPath: newPrefix,
			remoteFolderFileId,
			newFolderName,
			affectedRecords = [],
		} = plan;
		if (!oldPrefix || !newPrefix || !remoteFolderFileId || !newFolderName) {
			throw new Error("rename-remote(目录) 缺少 remoteFolderFileId 或目录路径");
		}

		const r = await this.fsXgkb.renameRemoteFile(remoteFolderFileId, newFolderName);
		if (!r.ok) throw new Error(r.error);

		await this.db.relocateRecordsByPrefix(this.scopeKey, oldPrefix, newPrefix);
		for (const rec of affectedRecords) {
			const suffix = rec.localPath.slice(oldPrefix.length);
			const newPath = `${newPrefix}${suffix}`;
			if (rec.xgkbFileId) this.queueMtimeRefresh(rec.xgkbFileId, newPath);
		}

		this.stats.renamed = (this.stats.renamed ?? 0) + 1;
		this.progress(
			`↻ 远端目录 ${oldPrefix} → ${newPrefix}（${affectedRecords.length} 个文件，1 次 updateFileName）`
		);
	}

	private async doMoveRemoteDirectory(plan: SyncPlan): Promise<void> {
		const {
			directoryOldPath: oldPrefix,
			directoryNewPath: newPrefix,
			remoteFolderFileId,
			newFolderName,
			affectedRecords = [],
		} = plan;
		if (!oldPrefix || !newPrefix || !remoteFolderFileId) {
			throw new Error("move-remote(目录) 缺少 remoteFolderFileId 或目录路径");
		}

		const newParent = parentPathOf(newPrefix);
		const folderResult = await this.fsXgkb.resolveFolderIdForRelativePath(newParent);
		if (!folderResult.ok) throw new Error(folderResult.error);

		const moveResult = await this.fsXgkb.moveRemoteFile(remoteFolderFileId, folderResult.value);
		if (!moveResult.ok) throw new Error(moveResult.error);

		let folderFileId = String(moveResult.value.fileId);
		const oldFolderName = oldPrefix.split("/").pop() || oldPrefix;
		if (newFolderName && newFolderName !== oldFolderName) {
			const renameResult = await this.fsXgkb.renameRemoteFile(folderFileId, newFolderName);
			if (!renameResult.ok) throw new Error(renameResult.error);
		}

		const idMappings = collectMoveIdMappings(moveResult.value);
		if (idMappings.length > 0) {
			await this.db.applyFileIdMappings(this.scopeKey, idMappings);
		}

		await this.db.relocateRecordsByPrefix(this.scopeKey, oldPrefix, newPrefix);

		// 直接子文件的 parent folderId 随目录 move 变化
		const all = await this.db.getAll(this.scopeKey);
		for (const rec of all) {
			if (!rec.localPath.startsWith(`${newPrefix}/`) && rec.localPath !== newPrefix) continue;
			const rest = rec.localPath.slice(newPrefix.length + 1);
			if (rest.includes("/")) continue;
			if (rec.xgkbFolderId === remoteFolderFileId) {
				await this.db.put({ ...rec, xgkbFolderId: folderFileId, lastSyncAt: Date.now() });
			}
			this.queueMtimeRefresh(rec.xgkbFileId, rec.localPath);
		}

		this.stats.moved = (this.stats.moved ?? 0) + 1;
		this.progress(
			`→ 远端目录 ${oldPrefix} → ${newPrefix}（${affectedRecords.length} 个文件，1 次 moveFile）`
		);
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
	| "rename-local"
	| "rename-remote"
	| "delete-local"
	| "delete-remote"
	| "skip";

type SyncPlan = {
	path: string;
	targetPath?: string;
	remoteOldPath?: string;
	local: FileEntry | undefined;
	remote: FileEntry | undefined;
	record: SyncStateRecord | undefined;
	op: SyncOp;
	isDirectory?: boolean;
	directoryOldPath?: string;
	directoryNewPath?: string;
	newFolderName?: string;
	remoteFolderFileId?: string;
	affectedRecords?: SyncStateRecord[];
	consumedPaths?: string[];
};

function parentPathOf(relativePath: string): string {
	const i = relativePath.lastIndexOf("/");
	return i > 0 ? relativePath.substring(0, i) : "";
}

/** 从单文件路径变化推导目录前缀变更（仅一个路径段不同且文件名不变） */
function deriveDirPrefixChange(
	oldPath: string,
	newPath: string
): { oldPrefix: string; newPrefix: string } | null {
	const oldSlash = oldPath.lastIndexOf("/");
	const newSlash = newPath.lastIndexOf("/");
	if (oldSlash !== newSlash) return null;
	const fileName = oldSlash >= 0 ? oldPath.slice(oldSlash + 1) : oldPath;
	if ((newSlash >= 0 ? newPath.slice(newSlash + 1) : newPath) !== fileName) return null;

	const oldDir = oldSlash >= 0 ? oldPath.slice(0, oldSlash) : "";
	const newDir = newSlash >= 0 ? newPath.slice(0, newSlash) : "";
	if (oldDir === newDir) return null;

	const oldParts = oldDir ? oldDir.split("/") : [];
	const newParts = newDir ? newDir.split("/") : [];
	if (oldParts.length !== newParts.length) return null;

	let diffIdx = -1;
	for (let i = 0; i < oldParts.length; i++) {
		if (oldParts[i] !== newParts[i]) {
			if (diffIdx >= 0) return null;
			diffIdx = i;
		}
	}
	if (diffIdx < 0) return null;

	return {
		oldPrefix: oldParts.slice(0, diffIdx + 1).join("/"),
		newPrefix: newParts.slice(0, diffIdx + 1).join("/"),
	};
}

function pickDirectChildFolderId(records: SyncStateRecord[], oldPrefix: string): string | undefined {
	for (const rec of records) {
		if (!rec.localPath.startsWith(`${oldPrefix}/`)) continue;
		const rest = rec.localPath.slice(oldPrefix.length + 1);
		if (!rest.includes("/") && rec.xgkbFolderId) return rec.xgkbFolderId;
	}
	return undefined;
}

function collectMoveIdMappings(
	result: MoveFileResult
): Array<{ sourceFileId: string; targetFileId: string }> {
	if (!result.idChanged || !result.idMappings?.length) return [];
	return result.idMappings.map((m) => ({
		sourceFileId: String(m.sourceFileId),
		targetFileId: String(m.targetFileId),
	}));
}
