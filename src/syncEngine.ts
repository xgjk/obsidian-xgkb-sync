import type {
	XgkbPluginSettings,
	FileEntry,
	PendingRemoteRenameOp,
	SyncStateRecord,
	SyncStats,
	SyncPlanTraceItem,
	SyncExecTraceItem,
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
	XGKB_NODE_FOLDER,
} from "./constants";
import {
	formatSyncExtensionsLabel,
	normalizeSyncExtensions,
	pathMatchesSyncExtensions,
} from "./syncFileTypes";
import {
	isKbSpaceParentId,
	normalizeKbRelativePath,
	sanitizePathSegment,
} from "./pathSanitize";
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
	/** 本轮 listChanges 明确 delete 的文件/目录 fileId */
	deletedFileIds: Set<string>;
	deletedFolderIds: Set<string>;
};
const TRACE_LIMIT = 300;

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
	/** 本轮增量 listChanges 确认的远端删除（用于 pull 本地删除，避免误删） */
	private remoteDeletedFileIds = new Set<string>();
	private remoteDeletedFolderIds = new Set<string>();
	private remoteDeletedLocalPaths = new Set<string>();

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
			planTrace: [],
			execTrace: [],
		};
	}

	async runSync(onProgress?: ProgressCallback, since?: number): Promise<SyncStats> {
		this.stats = this.emptyStats();
		this.successfulRemoteMtimes = [];
		this.mtimeRefreshQueue.clear();
		this.remoteDeletedFileIds = new Set();
		this.remoteDeletedFolderIds = new Set();
		this.remoteDeletedLocalPaths = new Set();
		this.progress = onProgress || (() => {});
		const prog = (msg: string) => {
			console.debug(`[XGKB Sync] ${msg}`);
			this.progress(msg);
		};

		prog("连接玄关知识库...");
		const initResult = await this.fsXgkb.init();
		if (!initResult.ok) throw new Error(`初始化失败: ${initResult.error}`);
		if (this.fsXgkb.isSyncAtProjectRoot()) {
			prog("云端映射根：整个知识库空间（将同步该空间内所有匹配类型的文件）");
		}

		prog("扫描本地文件...");
		const localFiles = await this.fsLocal.listFiles();
		prog(`本地: ${localFiles.length} 个文件（${formatSyncExtensionsLabel(normalizeSyncExtensions(this.settings.syncFileExtensions))}）`);

		const remoteBuild = await this.buildRemoteMap(since, prog);
		let remoteMap = remoteBuild.map;
		this.remoteDeletedFileIds = remoteBuild.deletedFileIds;
		this.remoteDeletedFolderIds = remoteBuild.deletedFolderIds;
		prog(`云端: ${remoteMap.size} 个文件（${formatSyncExtensionsLabel(normalizeSyncExtensions(this.settings.syncFileExtensions))}，候选水位 ${remoteBuild.watermarkCandidate}）`);

		const retried = await this.injectFailedRetries(remoteMap, prog);
		this.stats.retriedFailed = retried;
		if (retried > 0) {
			prog(`失败重试队列: ${retried} 个文件已并入本轮`);
		}

		const localMap = new Map<string, FileEntry>();
		for (const f of localFiles) localMap.set(f.path, f);
		const executionPlan = await this.planSync(localMap, remoteMap, prog);
		await this.applyPlannedOps(executionPlan, prog);
		this.emitTraceSnapshot(prog);

		await this.flushMtimeRefreshQueue();

		this.stats.newSince = this.computeCommittedWatermark(remoteBuild);

		prog(
			`完成: ↑${this.stats.uploaded} ↓${this.stats.downloaded} ↻${this.stats.renamed ?? 0} ✗${this.stats.deleted} fail:${this.stats.failed} ∅${this.stats.skipped} 水位=${this.stats.newSince ?? "-"}`
		);
		return this.stats;
	}

	private async planSync(
		localMap: Map<string, FileEntry>,
		remoteMap: Map<string, FileEntry>,
		prog: (msg: string) => void
	): Promise<SyncExecutionPlan> {
		const allRecords = await this.db.getAll(this.scopeKey);
		const recordMap = new Map<string, SyncStateRecord>();
		for (const r of allRecords) recordMap.set(r.localPath, r);

		this.remoteDeletedLocalPaths = this.collectRemoteDeletedLocalPaths(
			allRecords,
			this.remoteDeletedFileIds,
			this.remoteDeletedFolderIds
		);
		if (this.remoteDeletedLocalPaths.size > 0) {
			prog(
				`远端已删除 ${this.remoteDeletedFileIds.size} 个文件、${this.remoteDeletedFolderIds.size} 个目录，计划本地清理 ${this.remoteDeletedLocalPaths.size} 个路径`
			);
		}

		const consumedPaths = new Set<string>();
		const rawReconcilePlans = await this.buildPathReconcilePlans(
			localMap,
			remoteMap,
			recordMap,
			prog,
			consumedPaths
		);
		const reconcilePlans = await this.collapseDirectoryReconcilePlans(
			rawReconcilePlans,
			localMap,
			remoteMap,
			prog
		);
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

		const skipCount = plans.filter((p) => p.op === "skip").length;
		this.stats.skipped += skipCount;
		this.capturePlanTrace(plans);

		return {
			plans,
			renameLocalPlans: plans.filter((p) => p.op === "rename-local"),
			renameRemotePlans: plans.filter((p) => p.op === "rename-remote"),
			deletePlans: plans.filter((p) => p.op === "delete-local" || p.op === "delete-remote"),
			downloadPlans: plans.filter((p) => p.op === "download-new" || p.op === "download-update"),
			uploadPlans: plans.filter((p) => p.op === "upload-new" || p.op === "upload-update"),
		};
	}

	private capturePlanTrace(plans: SyncPlan[]): void {
		const compact: SyncPlanTraceItem[] = plans.slice(0, TRACE_LIMIT).map((plan) => ({
			op: plan.op,
			path: plan.path,
			targetPath: plan.targetPath,
			remoteOldPath: plan.remoteOldPath,
			isDirectory: plan.isDirectory,
		}));
		this.stats.planTrace = compact;
	}

	private appendExecTrace(plan: SyncPlan, status: "ok" | "failed", message?: string): void {
		if (!this.stats.execTrace) this.stats.execTrace = [];
		if (this.stats.execTrace.length >= TRACE_LIMIT) return;
		const item: SyncExecTraceItem = { op: plan.op, path: plan.path, status };
		if (message) item.message = message;
		this.stats.execTrace.push(item);
	}

	private emitTraceSnapshot(prog: (msg: string) => void): void {
		const planCount = this.stats.planTrace?.length ?? 0;
		const execCount = this.stats.execTrace?.length ?? 0;
		prog(`trace: plan=${planCount} exec=${execCount} (limit=${TRACE_LIMIT})`);
		console.debug("[XGKB Sync][trace] plan", this.stats.planTrace);
		console.debug("[XGKB Sync][trace] exec", this.stats.execTrace);
	}

	private async applyPlannedOps(
		execution: SyncExecutionPlan,
		prog: (msg: string) => void
	): Promise<void> {
		for (const plan of execution.renameLocalPlans) {
			await this.executePlan(plan);
		}
		for (const plan of execution.deletePlans) {
			await this.executePlan(plan);
		}

		if (execution.downloadPlans.length > 0) {
			prog(`开始下载 ${execution.downloadPlans.length} 个文件（并发 ${DOWNLOAD_CONCURRENCY}）...`);
			let done = 0;
			await this.runWithConcurrency(execution.downloadPlans, DOWNLOAD_CONCURRENCY, async (plan) => {
				await this.executePlan(plan);
				done++;
				if (done % 5 === 0 || done === execution.downloadPlans.length) {
					prog(`下载进度 ${done}/${execution.downloadPlans.length}（↓${this.stats.downloaded} 失败 ${this.stats.failed}）`);
				}
			});
		}

		for (const plan of execution.renameRemotePlans) {
			await this.executePlan(plan);
		}

		if (execution.uploadPlans.length > 0) {
			prog(`开始上传 ${execution.uploadPlans.length} 个文件（并发 ${UPLOAD_CONCURRENCY}）...`);
			let done = 0;
			await this.runWithConcurrency(execution.uploadPlans, UPLOAD_CONCURRENCY, async (plan) => {
				await this.executePlan(plan);
				done++;
				if (done % 3 === 0 || done === execution.uploadPlans.length) {
					prog(`上传进度 ${done}/${execution.uploadPlans.length}（↑${this.stats.uploaded} 失败 ${this.stats.failed}）`);
				}
				if (done % UPLOAD_CONCURRENCY === 0) {
					await this.delay(EXECUTE_BATCH_PAUSE_MS);
				}
			});
		}
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
	private async buildPathReconcilePlans(
		localMap: Map<string, FileEntry>,
		remoteMap: Map<string, FileEntry>,
		recordMap: Map<string, SyncStateRecord>,
		prog: (msg: string) => void,
		consumed: Set<string>
	): Promise<SyncPlan[]> {
		const plans: SyncPlan[] = [];
		const dir = this.settings.syncDirection;
		const fileIdToRemote = new Map<string, FileEntry>();
		for (const remote of remoteMap.values()) {
			if (remote.xgkbFileId) fileIdToRemote.set(remote.xgkbFileId, remote);
		}

		for (const record of recordMap.values()) {
			const pendingPlan = await this.buildPendingRemotePlan(record, localMap, fileIdToRemote);
			if (pendingPlan) {
				plans.push(pendingPlan);
				consumed.add(record.localPath);
				if (pendingPlan.remoteOldPath) consumed.add(pendingPlan.remoteOldPath);
				syncDiagReconcile("plan", record.xgkbFileId, {
					op: "rename-remote",
					reason: "consume pendingRemoteOp",
					from: pendingPlan.remoteOldPath ?? record.localPath,
					to: pendingPlan.path,
					pendingSetAt: pendingPlan.pendingSetAt ?? null,
				});
				continue;
			}

			const remote = fileIdToRemote.get(record.xgkbFileId);
			if (!remote) {
				if (this.isRemoteConfirmedDeleted(record)) {
					syncDiagReconcile("match", record.xgkbFileId, {
						recordPath: record.localPath,
						remotePath: "(deleted)",
						localAtRecord: Boolean(localMap.get(record.localPath)),
						localAtRemote: false,
						op: "delete-local",
					});
				} else {
					syncDiagReconcile("skip", record.xgkbFileId, {
						reason: "remoteMap 中无此 fileId",
						recordPath: record.localPath,
						syncStatus: record.syncStatus,
					});
				}
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

	private async buildPendingRemotePlan(
		record: SyncStateRecord,
		localMap: Map<string, FileEntry>,
		fileIdToRemote?: Map<string, FileEntry>
	): Promise<SyncPlan | null> {
		if (this.settings.syncDirection === "pull") return null;
		const pendingOps = this.getPendingRemoteRenameOps(record);
		if (pendingOps.length === 0) return null;
		const pending = this.getEffectivePendingRemoteRename(pendingOps);
		if (!pending) return null;
		const expectedNewPath = pending.newPath;
		if (expectedNewPath !== record.localPath) return null;
		const local = localMap.get(record.localPath);
		if (!local) return null;
		// 优先使用远端实际路径（来自增量扫描），避免多次连续 rename 后
		// pendingOldPath 指向中间路径导致目录聚合错误。
		const actualRemote = fileIdToRemote?.get(record.xgkbFileId);
		const remoteOldPath = actualRemote?.path || pending.oldPath || record.localPath;
		// 远端已在目标路径：不再生成 rename 计划，避免 no-op 干扰目录聚合。
		if (remoteOldPath === record.localPath) {
			await this.db.clearPendingRemoteOps(this.scopeKey, record.localPath);
			syncDiagReconcile("skip", record.xgkbFileId, {
				reason: "pending no-op（远端路径已对齐），已清理 pending",
				recordPath: record.localPath,
			});
			return null;
		}
		return {
			path: record.localPath,
			remoteOldPath,
			pendingSetAt: pending.setAt,
			local,
			remote: actualRemote,
			record,
			op: "rename-remote",
		};
	}

	private getPendingRemoteRenameOps(record: SyncStateRecord): PendingRemoteRenameOp[] {
		if (record.pendingRemoteOps?.length) return record.pendingRemoteOps;
		if (
			record.pendingRemoteOp === "rename-or-move" &&
			record.pendingOldPath &&
			record.pendingNewPath
		) {
			return [
				{
					op: "rename-or-move",
					oldPath: record.pendingOldPath,
					newPath: record.pendingNewPath,
					setAt: record.pendingSetAt ?? record.lastSyncAt,
				},
			];
		}
		return [];
	}

	private getEffectivePendingRemoteRename(
		ops: PendingRemoteRenameOp[]
	): { oldPath: string; newPath: string; setAt: number } | null {
		if (ops.length === 0) return null;
		const first = ops[0];
		const last = ops[ops.length - 1];
		if (!first.oldPath || !last.newPath) return null;
		return {
			oldPath: first.oldPath,
			newPath: last.newPath,
			setAt: last.setAt,
		};
	}

	/** 将同前缀变更的多文件 rename 聚合为目录级计划（1 次 folder API） */
	private async collapseDirectoryReconcilePlans(
		plans: SyncPlan[],
		localMap: Map<string, FileEntry>,
		remoteMap: Map<string, FileEntry>,
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
			// 单文件计划不做目录聚合：优先走文件级 rename/move，避免误把“文件跨目录移动”
			// 升级为“整目录移动”导致目标目录冲突（如 sub4 已存在）。
			if (group.items.length < 2) {
				for (const item of group.items) collapsed.push(item);
				continue;
			}

			// 仅在“可证明整目录搬迁”时才做目录聚合：
			// - rename-local：group 覆盖 oldPrefix 下全部本地文件
			// - rename-remote：group 覆盖 oldPrefix 下全部远端文件
			// 否则保留文件级计划，避免误把单文件 move 升级成目录 move。
			let totalUnderPrefix = 0;
			let meetsThreshold = false;
			if (group.op === "rename-local") {
				const localOldPaths = [...localMap.keys()].filter((p) =>
					pathUnderPrefix(p, group.oldPrefix)
				);
				totalUnderPrefix = localOldPaths.length;
				const groupedOldPaths = new Set(group.items.map((item) => item.path));
				meetsThreshold =
					totalUnderPrefix > 0 &&
					group.items.length === totalUnderPrefix &&
					localOldPaths.every((p) => groupedOldPaths.has(p));
			} else {
				const remoteEntriesUnderOldPrefix = [...remoteMap.values()].filter((entry) =>
					pathUnderPrefix(entry.path, group.oldPrefix)
				);
				totalUnderPrefix = remoteEntriesUnderOldPrefix.length;
				const groupedRemoteIds = new Set(
					group.items.map((item) => item.record?.xgkbFileId || item.remote?.xgkbFileId).filter(Boolean)
				);
				const groupedRemoteOldPaths = new Set(
					group.items
						.map((item) => item.remoteOldPath || item.remote?.path)
						.filter((p): p is string => Boolean(p))
				);
				const allRemoteCovered = remoteEntriesUnderOldPrefix.every((entry) =>
					entry.xgkbFileId
						? groupedRemoteIds.has(entry.xgkbFileId)
						: groupedRemoteOldPaths.has(entry.path)
				);
				meetsThreshold =
					totalUnderPrefix > 0 &&
					group.items.length === totalUnderPrefix &&
					allRemoteCovered;
			}

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
			// 远端目录聚合必须拿到目录 fileId，否则回退文件级计划。
			if (group.op === "rename-remote" && !remoteFolderFileId) {
				prog(`目录聚合回退: 无法解析远端目录 ID，改用文件级计划 (${group.oldPrefix} -> ${group.newPrefix})`);
				for (const item of group.items) collapsed.push(item);
				continue;
			}
			// 远端目标前缀下已存在文件时，不执行目录级 rename/move，避免 API 400001 冲突。
			if (
				group.op === "rename-remote" &&
				group.oldPrefix !== group.newPrefix &&
				[...remoteMap.values()].some((entry) => pathUnderPrefix(entry.path, group.newPrefix))
			) {
				prog(
					`目录聚合回退: 目标目录已存在内容，改用文件级计划 (${group.oldPrefix} -> ${group.newPrefix})`
				);
				for (const item of group.items) collapsed.push(item);
				continue;
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

		// 父目录 rename/move 已覆盖子目录时，丢弃子目录计划，避免执行顺序导致“目录不存在”。
		const dirPlans = collapsed.filter((p) => p.isDirectory);
		const dedupedDirPlans: SyncPlan[] = [];
		let droppedNestedDirPlans = 0;
		const sortedDirPlans = [...dirPlans].sort(
			(a, b) => (a.directoryOldPath?.length ?? 0) - (b.directoryOldPath?.length ?? 0)
		);
		for (const plan of sortedDirPlans) {
			const covered = dedupedDirPlans.some((parent) => isNestedDirectoryPlanCovered(parent, plan));
			if (covered) {
				droppedNestedDirPlans++;
				continue;
			}
			dedupedDirPlans.push(plan);
		}
		if (droppedNestedDirPlans > 0) {
			prog(`目录计划去重: 跳过 ${droppedNestedDirPlans} 个被父目录覆盖的子目录计划`);
		}

		const nonDirPlans = collapsed.filter((p) => !p.isDirectory);
		const finalPlans = [...nonDirPlans, ...dedupedDirPlans];
		const dirCount = dedupedDirPlans.length;
		if (dirCount > 0) prog(`目录级 rename/move: ${dirCount} 组（由 ${renamePlans.length} 个文件计划聚合）`);
		return finalPlans;
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
		const deletedFileIds = new Set<string>();
		const deletedFolderIds = new Set<string>();
		for (const item of items) {
			const id = String(item.fileId);
			if (item.event === "delete") {
				deleteIds.add(id);
				if (item.type === XGKB_NODE_FOLDER) deletedFolderIds.add(id);
				else deletedFileIds.add(id);
			} else {
				upsertById.set(id, item);
			}
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
		for (const id of folderUpsertIds) {
			const item = upsertById.get(id)!;
			if (item.relativePath) {
				folderIdToPath.set(id, normalizeKbRelativePath(item.relativePath));
			}
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
			let filePath: string | undefined;
			if (item.relativePath) {
				filePath = normalizeKbRelativePath(item.relativePath);
			} else {
				const parentId = item.parentId != null ? String(item.parentId) : "";
				const folderPath = this.resolveParentFolderPath(parentId, folderIdToPath);
				if (folderPath !== undefined) {
					const safeName = sanitizePathSegment(item.name || id);
					filePath = folderPath ? `${folderPath}/${safeName}` : safeName;
				}
			}
			if (filePath !== undefined) {
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
				const folderPathFromMap = newParentId
					? this.resolveParentFolderPath(newParentId, folderIdToPath)
					: undefined;
				const remotePath =
					meta.relativePath != null && meta.relativePath !== ""
						? normalizeKbRelativePath(meta.relativePath)
						: item.relativePath
							? normalizeKbRelativePath(item.relativePath)
							: this.remotePathFromParent(
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

		return {
			map,
			watermarkCandidate,
			scanMode: "incremental",
			deletedFileIds,
			deletedFolderIds,
		};
	}

	private buildFolderIdToPathFromRecords(records: SyncStateRecord[]): Map<string, string> {
		const folderIdToPath = new Map<string, string>();
		const rootId = this.fsXgkb.getRootId();
		if (rootId) folderIdToPath.set(rootId, "");
		for (const record of records) {
			// pending rename/move 时，localPath 已是“本地新路径”，而 xgkbFolderId 仍指向“远端旧父目录”。
			// 这里必须用 pending.oldPath 的父目录作为远端目录映射，避免增量路径重建被本地状态污染。
			const pending = this.getEffectivePendingRemoteRename(this.getPendingRemoteRenameOps(record));
			const pathForRemoteFolderMap = pending?.oldPath || record.localPath;
			const parts = pathForRemoteFolderMap.split("/");
			const folderPath = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
			folderIdToPath.set(record.xgkbFolderId, folderPath);
		}
		return folderIdToPath;
	}

	/** listChanges 中的目录 upsert → 更新 folderId 对应路径（远端目录改名/新建） */
	private applyFolderUpsertsToPathMap(
		upsertById: Map<
			string,
			{
				type?: number;
				fileId: string | number;
				parentId?: string | number;
				name?: string;
				relativePath?: string;
			}
		>,
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
				if (item.relativePath) {
					const nextPath = normalizeKbRelativePath(item.relativePath);
					if (folderIdToPath.get(folderId) !== nextPath) {
						folderIdToPath.set(folderId, nextPath);
						changed = true;
					}
					continue;
				}
				const parentPath = this.resolveParentFolderPath(parentId, folderIdToPath);
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
				if (meta.relativePath != null && meta.relativePath !== "") {
					folderIdToPath.set(id, normalizeKbRelativePath(meta.relativePath));
					continue;
				}
				const parentId = meta.parentId != null ? String(meta.parentId) : "";
				if (parentId && parentId !== id && parentId !== rootId && !folderIdToPath.has(parentId)) {
					if (isKbSpaceParentId(parentId) && !this.fsXgkb.isSyncAtProjectRoot()) {
						continue;
					}
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
				if (folderIdToPath.has(folderId)) continue;
				const parentId = meta.parentId != null ? String(meta.parentId) : "";
				const parentPath = this.resolveParentFolderPath(parentId, folderIdToPath);
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

	private resolveParentFolderPath(
		parentId: string,
		folderIdToPath: Map<string, string>
	): string | undefined {
		const rootId = this.fsXgkb.getRootId();
		if (isKbSpaceParentId(parentId)) {
			if (!this.fsXgkb.isSyncAtProjectRoot()) return undefined;
			return rootId != null && folderIdToPath.has(rootId) ? "" : undefined;
		}
		if (rootId && parentId === rootId) return "";
		return folderIdToPath.get(parentId);
	}

	private remotePathForRecord(record: SyncStateRecord, folderIdToPath: Map<string, string>): string {
		const fileName = record.localPath.split("/").pop() || record.localPath;
		const folderPath = this.resolveParentFolderPath(record.xgkbFolderId, folderIdToPath);
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
		const folderPath = this.resolveParentFolderPath(parentId, folderIdToPath);
		if (folderPath === undefined) return fallback;
		const name = sanitizePathSegment(fileName || fallback.split("/").pop() || fallback);
		return folderPath ? `${folderPath}/${name}` : name;
	}

	private remotePathFromMeta(
		meta: XgkbMetaItem,
		folderIdToPath: Map<string, string>,
		fallback: string
	): string {
		if (meta.relativePath != null && meta.relativePath !== "") {
			return normalizeKbRelativePath(meta.relativePath);
		}
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
		return {
			map,
			watermarkCandidate,
			scanMode: "full",
			deletedFileIds: new Set(),
			deletedFolderIds: new Set(),
		};
	}

	/** listChanges delete 事件 → 需要本地删除的相对路径 */
	private collectRemoteDeletedLocalPaths(
		allRecords: SyncStateRecord[],
		deletedFileIds: Set<string>,
		deletedFolderIds: Set<string>
	): Set<string> {
		const paths = new Set<string>();
		if (deletedFileIds.size === 0 && deletedFolderIds.size === 0) return paths;

		const folderPrefixes = new Set<string>();
		for (const folderId of deletedFolderIds) {
			for (const record of allRecords) {
				if (record.xgkbFolderId !== folderId) continue;
				const prefix = parentPathOf(record.localPath);
				if (prefix) folderPrefixes.add(prefix);
			}
		}

		for (const record of allRecords) {
			if (deletedFileIds.has(record.xgkbFileId)) {
				paths.add(record.localPath);
				continue;
			}
			for (const prefix of folderPrefixes) {
				if (
					record.localPath === prefix ||
					record.localPath.startsWith(`${prefix}/`)
				) {
					paths.add(record.localPath);
					break;
				}
			}
		}
		return paths;
	}

	private isRemoteConfirmedDeleted(record?: SyncStateRecord): boolean {
		if (!record) return false;
		if (this.remoteDeletedFileIds.has(record.xgkbFileId)) return true;
		return this.remoteDeletedLocalPaths.has(record.localPath);
	}

	/** Pull/双向且开启保护时，禁止仅凭「远端 map 缺项」启发式删本地 */
	private allowsHeuristicLocalDelete(): boolean {
		const dir = this.settings.syncDirection;
		if (dir === "push") return true;
		return this.settings.protectLocalDelete === false;
	}

	private shouldDeleteLocal(record: SyncStateRecord): boolean {
		if (this.isRemoteConfirmedDeleted(record)) return true;
		return this.allowsHeuristicLocalDelete();
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
			this.appendExecTrace(plan, "ok");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.stats.failed++;
			this.stats.errors.push(`${path}: ${msg}`);
			this.appendExecTrace(plan, "failed", msg);
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
				if (local && this.isRemoteConfirmedDeleted(record)) {
					if (dir === "push") return "skip";
					return this.shouldDeleteLocal(record) ? "delete-local" : "skip";
				}
				return local && dir !== "pull" ? "upload-new" : "skip";
			}
			if (dir === "pull") return "download-update";
			if (dir === "push") return local ? "upload-update" : "delete-remote";
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
			if (dir === "push") return "delete-remote";
			const remoteChanged = remote.mtime > record.remoteMtime + MTIME_TOLERANCE_MS;
			return remoteChanged ? "download-update" : "delete-remote";
		}

		if (local && !remote) {
			if (this.isRemoteConfirmedDeleted(record)) {
				if (dir === "push") return "skip";
				return this.shouldDeleteLocal(record) ? "delete-local" : "skip";
			}
			if (dir === "pull") return "skip";
			const localChanged = local.mtime > record.localMtime + MTIME_TOLERANCE_MS;
			if (localChanged) return "upload-new";
			// 有 fileId 时远端可能只是增量 map 漏报，避免误删本地
			if (record.xgkbFileId) return "skip";
			return this.allowsHeuristicLocalDelete() ? "delete-local" : "skip";
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
		if (!record || !local) throw new Error("rename-remote 参数不完整");
		const fileId = record.xgkbFileId;
		const pending = this.getEffectivePendingRemoteRename(this.getPendingRemoteRenameOps(record));
		const oldRemotePath =
			remoteOldPath || remote?.path || pending?.oldPath || record.localPath;
		const newFileName = path.split("/").pop() || path;
		const oldParent = parentPathOf(oldRemotePath);
		const newParent = parentPathOf(path);
		console.debug(
			`[XGKB Sync] rename-remote 计划: fileId=${fileId} oldPath="${oldRemotePath}" newPath="${path}" oldParent="${oldParent}" newParent="${newParent}"`
		);

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

		// rename/move 完成后检查内容是否在此次操作前已被修改（先 move 再上传，顺序不能颠倒）
		const localChanged = local.mtime > record.localMtime + MTIME_TOLERANCE_MS;
		if (localChanged) {
			const content = await this.fsLocal.readFile(path);
			const fileName = path.split("/").pop() || path;
			const updateResult = await this.fsXgkb.updateFile(fileId, fileName, content);
			if (!updateResult.ok) throw new Error(`rename-remote 后内容更新失败: ${updateResult.error}`);
			this.stats.uploaded++;
			this.progress(`↻↑ 远端移动并更新内容 → ${path}`);
		} else {
			this.progress(`↻ 远端 → ${path}`);
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
	}

	private async doRenameLocalDirectory(plan: SyncPlan): Promise<void> {
		const oldPrefix = plan.directoryOldPath;
		const newPrefix = plan.directoryNewPath;
		if (!oldPrefix || !newPrefix) throw new Error("rename-local(目录) 参数不完整");

		// 幂等防护：父目录计划已执行时，子目录旧路径可能已不存在。
		// 若新目录已存在则视为成功，避免“目录不存在”导致整轮 fail。
		const oldExists = await this.fsLocal.folderExists(oldPrefix);
		if (!oldExists) {
			const newExists = await this.fsLocal.folderExists(newPrefix);
			if (newExists) {
				const moved = await this.db.relocateRecordsByPrefix(this.scopeKey, oldPrefix, newPrefix);
				this.progress(`↻ 本地目录 ${oldPrefix} → ${newPrefix}（已存在目标目录，跳过重复执行，${moved} 个文件）`);
				return;
			}
			throw new Error(`目录不存在: ${oldPrefix}`);
		}

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
		await this.db.clearPendingRemoteOpsByPrefix(this.scopeKey, newPrefix);

		// 目录 rename 完成后，检查各文件内容是否在此次操作前已被修改
		for (const rec of affectedRecords) {
			const suffix = rec.localPath.slice(oldPrefix.length);
			const newPath = `${newPrefix}${suffix}`;
			const currentMtime = await this.fsLocal.getMtime(newPath);
			if (
				currentMtime != null &&
				rec.xgkbFileId &&
				currentMtime > rec.localMtime + MTIME_TOLERANCE_MS
			) {
				const content = await this.fsLocal.readFile(newPath);
				const fileName = newPath.split("/").pop() || newPath;
				const upd = await this.fsXgkb.updateFile(rec.xgkbFileId, fileName, content);
				if (!upd.ok) throw new Error(`目录 rename 后内容更新失败 ${newPath}: ${upd.error}`);
				this.stats.uploaded++;
				this.progress(`↻↑ 目录 rename 后更新内容 → ${newPath}`);
			}
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
		await this.db.clearPendingRemoteOpsByPrefix(this.scopeKey, newPrefix);

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

		// 目录 move 完成后，检查各文件内容是否在此次操作前已被修改
		for (const rec of affectedRecords) {
			const suffix = rec.localPath.slice(oldPrefix.length);
			const newPath = `${newPrefix}${suffix}`;
			const currentMtime = await this.fsLocal.getMtime(newPath);
			if (
				currentMtime != null &&
				rec.xgkbFileId &&
				currentMtime > rec.localMtime + MTIME_TOLERANCE_MS
			) {
				const content = await this.fsLocal.readFile(newPath);
				const fileName = newPath.split("/").pop() || newPath;
				const upd = await this.fsXgkb.updateFile(rec.xgkbFileId, fileName, content);
				if (!upd.ok) throw new Error(`目录 move 后内容更新失败 ${newPath}: ${upd.error}`);
				this.stats.uploaded++;
				this.progress(`↻↑ 目录 move 后更新内容 → ${newPath}`);
			}
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
		if (!this.shouldDeleteLocal(record)) {
			console.debug(`[XGKB Sync] 保护本地文件，跳过删除: ${path}`);
			this.progress(`⊘ 保护本地 ${path}（未确认云端删除）`);
			return;
		}
		await this.fsLocal.trashFile(path);
		await this.db.delete(this.scopeKey, path);
		this.stats.deleted++;
		this.progress(`✗ 本地移至回收站 ${path}`);
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
	pendingSetAt?: number;
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

type SyncExecutionPlan = {
	plans: SyncPlan[];
	renameLocalPlans: SyncPlan[];
	renameRemotePlans: SyncPlan[];
	deletePlans: SyncPlan[];
	downloadPlans: SyncPlan[];
	uploadPlans: SyncPlan[];
};

function parentPathOf(relativePath: string): string {
	const i = relativePath.lastIndexOf("/");
	return i > 0 ? relativePath.substring(0, i) : "";
}

/** 从单文件路径变化推导目录前缀变更（同级 rename 或整夹 move，文件名不变） */
function deriveDirPrefixChange(
	oldPath: string,
	newPath: string
): { oldPrefix: string; newPrefix: string } | null {
	const oldParts = oldPath.split("/");
	const newParts = newPath.split("/");
	if (oldParts.length === 0 || newParts.length === 0) return null;

	const fileName = oldParts[oldParts.length - 1];
	if (fileName !== newParts[newParts.length - 1]) return null;

	const oldDirs = oldParts.slice(0, -1);
	const newDirs = newParts.slice(0, -1);
	if (oldDirs.join("/") === newDirs.join("/")) return null;
	// 通过「公共前缀 + 公共后缀」切分目录段，得到被 rename/move 的最小目录块。
	let prefixLen = 0;
	while (
		prefixLen < oldDirs.length &&
		prefixLen < newDirs.length &&
		oldDirs[prefixLen] === newDirs[prefixLen]
	) {
		prefixLen++;
	}

	let suffixLen = 0;
	while (
		suffixLen < oldDirs.length - prefixLen &&
		suffixLen < newDirs.length - prefixLen &&
		oldDirs[oldDirs.length - 1 - suffixLen] === newDirs[newDirs.length - 1 - suffixLen]
	) {
		suffixLen++;
	}

	let oldMid = oldDirs.slice(prefixLen, oldDirs.length - suffixLen);
	let newMid = newDirs.slice(prefixLen, newDirs.length - suffixLen);
	// 处理“整夹挂到新父目录下 / 从父目录提出来”的情况：
	// 这两类变化会表现为一侧中段为空，需要把公共后缀中的首段纳入被移动目录。
	if (oldMid.length === 0 && newMid.length > 0 && prefixLen < oldDirs.length) {
		oldMid = [oldDirs[prefixLen]];
		newMid = [...newMid, oldDirs[prefixLen]];
	} else if (newMid.length === 0 && oldMid.length > 0 && prefixLen < newDirs.length) {
		oldMid = [...oldMid, newDirs[prefixLen]];
		newMid = [newDirs[prefixLen]];
	}
	if (oldMid.length === 0 || newMid.length === 0) return null;

	const oldPrefix = oldDirs.slice(0, prefixLen + oldMid.length).join("/");
	const newPrefix = newDirs.slice(0, prefixLen + newMid.length).join("/");

	if (!oldPrefix || oldPrefix === newPrefix) return null;

	const suffix = oldPath.slice(oldPrefix.length);
	const expected =
		suffix.startsWith("/") || suffix.length === 0
			? `${newPrefix}${suffix}`
			: `${newPrefix}/${suffix}`;
	if (newPath !== expected) return null;

	return { oldPrefix, newPrefix };
}

function pickDirectChildFolderId(records: SyncStateRecord[], oldPrefix: string): string | undefined {
	for (const rec of records) {
		if (!rec.localPath.startsWith(`${oldPrefix}/`)) continue;
		const rest = rec.localPath.slice(oldPrefix.length + 1);
		if (!rest.includes("/") && rec.xgkbFolderId) return rec.xgkbFolderId;
	}
	return undefined;
}

function isNestedDirectoryPlanCovered(parent: SyncPlan, child: SyncPlan): boolean {
	if (!parent.isDirectory || !child.isDirectory) return false;
	if (parent.op !== child.op) return false;
	const pOld = parent.directoryOldPath;
	const pNew = parent.directoryNewPath;
	const cOld = child.directoryOldPath;
	const cNew = child.directoryNewPath;
	if (!pOld || !pNew || !cOld || !cNew) return false;
	if (cOld === pOld) return true;
	if (!cOld.startsWith(`${pOld}/`)) return false;
	const suffix = cOld.slice(pOld.length);
	return cNew === `${pNew}${suffix}`;
}

function pathUnderPrefix(path: string, prefix: string): boolean {
	if (!prefix) return false;
	return path === prefix || path.startsWith(`${prefix}/`);
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
