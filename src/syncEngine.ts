import type { XgkbPluginSettings, FileEntry, SyncStateRecord, SyncStats, ProgressCallback, Result } from "./types";
import { SyncStateDb } from "./syncStateDb";
import { FsLocal } from "./fsLocal";
import { FsXgkb } from "./fsXgkb";
import { DEFAULT_SETTINGS, MTIME_TOLERANCE_MS } from "./constants";

/**
 * 同步引擎（Last-Write-Wins）
 *
 * 决策逻辑：
 * - 无 record（首次）：本地有→上传，云端有→下载，都有→对比 mtime
 * - 有 record（增量）：基于 mtime 变化判断方向
 * - 两端都修改了→LWW：较新覆盖较旧
 * - 一端删除了→另一端也删除
 */
export class SyncEngine {
	private db: SyncStateDb;
	private fsLocal: FsLocal;
	private fsXgkb: FsXgkb;
	private settings: XgkbPluginSettings;
	private stats: SyncStats;
	private progress: ProgressCallback = () => {};

	constructor(
		fsLocal: FsLocal,
		fsXgkb: FsXgkb,
		db: SyncStateDb,
		settings: XgkbPluginSettings
	) {
		this.fsLocal = fsLocal;
		this.fsXgkb = fsXgkb;
		this.db = db;
		this.settings = { ...DEFAULT_SETTINGS, ...settings };
		this.stats = this.emptyStats();
	}

	private emptyStats(): SyncStats {
		return { uploaded: 0, downloaded: 0, deleted: 0, skipped: 0, failed: 0, errors: [] };
	}

	async runSync(onProgress?: ProgressCallback): Promise<SyncStats> {
		this.stats = this.emptyStats();
		this.progress = onProgress || (() => {});
		const prog = (msg: string) => {
			console.log(`[XGKB Sync] ${msg}`);
			this.progress(msg);
		};

		// Step 1: 初始化云端
		prog("连接玄关知识库...");
		const initResult = await this.fsXgkb.init();
		if (!initResult.ok) throw new Error(`初始化失败: ${initResult.error}`);

		// Step 2: 扫描文件
		prog("扫描本地文件...");
		const localFiles = await this.fsLocal.listFiles();
		prog(`本地: ${localFiles.length} 个 .md 文件`);

		prog("扫描云端文件...");
		const remoteResult = await this.fsXgkb.listFiles();
		if (!remoteResult.ok) throw new Error(`扫描云端失败: ${remoteResult.error}`);
		const remoteFiles = remoteResult.value;
		prog(`云端: ${remoteFiles.length} 个 .md 文件`);

		// Step 3: 构建映射
		const localMap = new Map<string, FileEntry>();
		for (const f of localFiles) localMap.set(f.path, f);

		const remoteMap = new Map<string, FileEntry>();
		for (const f of remoteFiles) remoteMap.set(f.path, f);

		// Step 4: 合并所有路径
		const allPaths = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
		prog(`共 ${allPaths.size} 个路径需要处理`);

		// Step 5: 逐文件决策
		let idx = 0;
		for (const path of allPaths) {
			idx++;
			const local = localMap.get(path);
			const remote = remoteMap.get(path);
			const record = await this.db.get(path);

			if (idx % 50 === 0 || idx === allPaths.size) {
				prog(`处理中 ${idx}/${allPaths.size}...`);
			}

			await this.syncOne(path, local, remote, record);
		}

		prog(`完成: ↑${this.stats.uploaded} ↓${this.stats.downloaded} ✗${this.stats.deleted} ✗fail:${this.stats.failed} ∅${this.stats.skipped}`);
		return this.stats;
	}

	private async syncOne(
		path: string,
		local: FileEntry | undefined,
		remote: FileEntry | undefined,
		record: SyncStateRecord | undefined
	): Promise<void> {
		try {
			const op = this.decide(path, local, remote, record);

			switch (op) {
				case "upload-new":
					await this.doUploadNew(path, local!);
					break;
				case "upload-update":
					await this.doUploadUpdate(path, local!, record!);
					break;
				case "download-new":
					await this.doDownloadNew(path, remote!);
					break;
				case "download-update":
					await this.doDownloadUpdate(path, remote!, record!);
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
		}
	}

	/**
	 * 决策逻辑
	 */
	private decide(
		path: string,
		local: FileEntry | undefined,
		remote: FileEntry | undefined,
		record: SyncStateRecord | undefined
	): SyncOp {
		const dir = this.settings.syncDirection;

		// ========== 情况 A：无 record（首次同步该路径） ==========
		if (!record) {
			if (local && !remote) {
				return dir === "pull" ? "skip" : "upload-new";
			}
			if (!local && remote) {
				return dir === "push" ? "skip" : "download-new";
			}
			if (local && remote) {
				// 对比 mtime
				if (dir === "pull") return "download-update";
				if (dir === "push") return "upload-update";
				return local.mtime >= remote.mtime ? "upload-update" : "download-update";
			}
			// 两端都无：不可能，忽略
			return "skip";
		}

		// ========== 情况 B：有 record（增量同步） ==========

		// 本地无 && 云端无 → 清理残留 record
		if (!local && !remote) {
			return "skip"; // delete-record 在 doDeleteLocal/doDeleteRemote 中处理
		}

		// 本地无 && 云端有 → 判断：本地被删了 → 删云端
		if (!local && remote) {
			if (dir === "push") return "skip";
			// 远端有更新 → 下载到本地
			const remoteChanged = remote.mtime > record.remoteMtime + MTIME_TOLERANCE_MS;
			if (remoteChanged) return "download-update";
			// 远端没变 → 本地删的 → 删云端
			return "delete-remote";
		}

		// 本地有 && 云端无 → 判断：云端被删了 → 删本地
		if (local && !remote) {
			if (dir === "pull") return "skip";
			const localChanged = local.mtime > record.localMtime + MTIME_TOLERANCE_MS;
			if (localChanged) return "upload-new"; // 本地改了且云端删了，重新上传
			return "delete-local";
		}

		// 两端都有 → 增量对比
		if (local && remote) {
			const localChanged = local.mtime > record.localMtime + MTIME_TOLERANCE_MS;
			const remoteChanged = remote.mtime > record.remoteMtime + MTIME_TOLERANCE_MS;

			if (!localChanged && !remoteChanged) return "skip";
			if (localChanged && !remoteChanged) {
				return dir === "pull" ? "skip" : "upload-update";
			}
			if (!localChanged && remoteChanged) {
				return dir === "push" ? "skip" : "download-update";
			}

			// 两端都变了 → LWW
			if (dir === "pull") return "download-update";
			if (dir === "push") return "upload-update";
			return local.mtime >= remote.mtime ? "upload-update" : "download-update";
		}

		return "skip";
	}

	// ==================== 操作执行 ====================

	private async doUploadNew(path: string, local: FileEntry): Promise<void> {
		const content = await this.fsLocal.readFile(path);
		const result = await this.fsXgkb.createFile(path, content);
		if (!result.ok) throw new Error(`上传失败: ${result.error}`);

		const fileId = result.value;
		await this.db.put({
			localPath: path,
			xgkbFileId: fileId,
			xgkbFolderId: "",
			localMtime: local.mtime,
			remoteMtime: Date.now(),
			syncStatus: "done",
			lastSyncAt: Date.now(),
		});
		this.stats.uploaded++;
		this.progress(`↑ ${path}`);
	}

	private async doUploadUpdate(path: string, local: FileEntry, record: SyncStateRecord): Promise<void> {
		const content = await this.fsLocal.readFile(path);
		const fileName = path.split("/").pop() || path;
		const result = await this.fsXgkb.updateFile(record.xgkbFileId, fileName, content);
		if (!result.ok) throw new Error(`更新失败: ${result.error}`);

		await this.db.put({
			...record,
			localMtime: local.mtime,
			remoteMtime: Date.now(),
			syncStatus: "done",
			lastSyncAt: Date.now(),
			lastError: undefined,
		});
		this.stats.uploaded++;
		this.progress(`↑ ${path}`);
	}

	private async doDownloadNew(path: string, remote: FileEntry): Promise<void> {
		const contentResult = await this.fsXgkb.readFile(remote.xgkbFileId!);
		if (!contentResult.ok) throw new Error(`下载失败: ${contentResult.error}`);

		const actualMtime = await this.fsLocal.writeFile(path, contentResult.value);
		await this.db.put({
			localPath: path,
			xgkbFileId: remote.xgkbFileId!,
			xgkbFolderId: remote.xgkbFolderId || "",
			localMtime: actualMtime,
			remoteMtime: remote.mtime,
			syncStatus: "done",
			lastSyncAt: Date.now(),
		});
		this.stats.downloaded++;
		this.progress(`↓ ${path}`);
	}

	private async doDownloadUpdate(path: string, remote: FileEntry, record: SyncStateRecord): Promise<void> {
		const contentResult = await this.fsXgkb.readFile(remote.xgkbFileId!);
		if (!contentResult.ok) throw new Error(`下载失败: ${contentResult.error}`);

		const actualMtime = await this.fsLocal.writeFile(path, contentResult.value);
		await this.db.put({
			...record,
			localMtime: actualMtime,
			remoteMtime: remote.mtime,
			syncStatus: "done",
			lastSyncAt: Date.now(),
			lastError: undefined,
		});
		this.stats.downloaded++;
		this.progress(`↓ ${path}`);
	}

	private async doDeleteLocal(path: string, record: SyncStateRecord): Promise<void> {
		await this.fsLocal.trashFile(path);
		await this.db.delete(path);
		this.stats.deleted++;
		this.progress(`✗ 本地删除 ${path}`);
	}

	private async doDeleteRemote(record: SyncStateRecord): Promise<void> {
		const result = await this.fsXgkb.deleteFile(record.xgkbFileId);
		if (!result.ok) throw new Error(`删除云端失败: ${result.error}`);
		await this.db.delete(record.localPath);
		this.stats.deleted++;
		this.progress(`✗ 云端删除 ${record.localPath}`);
	}
}

type SyncOp = "upload-new" | "upload-update" | "download-new" | "download-update" | "delete-local" | "delete-remote" | "skip";
