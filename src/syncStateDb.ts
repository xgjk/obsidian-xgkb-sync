import type { PendingRemoteRenameOp, SyncStateRecord } from "./types";
import { DB_NAME, DB_VERSION, DB_STORE_NAME } from "./constants";
import type { Result } from "./types";

function requestError(request: IDBRequest): Error {
	return new Error(request.error?.message ?? "IndexedDB request failed");
}

/**
 * IndexedDB 状态持久化（按 scopeKey + localPath 隔离）
 */
export class SyncStateDb {
	private db: IDBDatabase | null = null;

	async open(): Promise<Result<void>> {
		return new Promise((resolve) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);

			request.onupgradeneeded = (event) => {
				const db = request.result;
				const oldVersion = event.oldVersion;
				if (oldVersion > 0 && oldVersion < DB_VERSION && db.objectStoreNames.contains(DB_STORE_NAME)) {
					db.deleteObjectStore(DB_STORE_NAME);
				}
				if (!db.objectStoreNames.contains(DB_STORE_NAME)) {
					const store = db.createObjectStore(DB_STORE_NAME, {
						keyPath: ["scopeKey", "localPath"],
					});
					store.createIndex("xgkbFileId", "xgkbFileId", { unique: false });
					store.createIndex("scopeKey", "scopeKey", { unique: false });
				}
			};

			request.onsuccess = () => {
				this.db = request.result;
				resolve({ ok: true, value: undefined });
			};

			request.onerror = () => {
				resolve({ ok: false, error: `IndexedDB open failed: ${request.error?.message}` });
			};
		});
	}

	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	async get(scopeKey: string, localPath: string): Promise<SyncStateRecord | undefined> {
		if (!this.db) return undefined;
		return new Promise((resolve) => {
			const tx = this.db!.transaction(DB_STORE_NAME, "readonly");
			const store = tx.objectStore(DB_STORE_NAME);
			const request = store.get([scopeKey, localPath]);
			request.onsuccess = () => resolve((request.result as SyncStateRecord | undefined) || undefined);
			request.onerror = () => resolve(undefined);
		});
	}

	async put(record: SyncStateRecord): Promise<void> {
		if (!this.db) return;
		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(DB_STORE_NAME, "readwrite");
			const store = tx.objectStore(DB_STORE_NAME);
			const request = store.put(record);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(requestError(request));
		});
	}

	async delete(scopeKey: string, localPath: string): Promise<void> {
		if (!this.db) return;
		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(DB_STORE_NAME, "readwrite");
			const store = tx.objectStore(DB_STORE_NAME);
			const request = store.delete([scopeKey, localPath]);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(requestError(request));
		});
	}

	async getAll(scopeKey: string): Promise<SyncStateRecord[]> {
		if (!this.db) return [];
		return new Promise((resolve) => {
			const tx = this.db!.transaction(DB_STORE_NAME, "readonly");
			const store = tx.objectStore(DB_STORE_NAME);
			const index = store.index("scopeKey");
			const request = index.getAll(scopeKey);
			request.onsuccess = () => resolve((request.result as SyncStateRecord[]) || []);
			request.onerror = () => resolve([]);
		});
	}

	async getByFileId(scopeKey: string, xgkbFileId: string): Promise<SyncStateRecord | undefined> {
		if (!this.db) return undefined;
		return new Promise((resolve) => {
			const tx = this.db!.transaction(DB_STORE_NAME, "readonly");
			const store = tx.objectStore(DB_STORE_NAME);
			const index = store.index("xgkbFileId");
			const request = index.getAll(xgkbFileId);
			request.onsuccess = () => {
				const rows = (request.result as SyncStateRecord[]) || [];
				resolve(rows.find((r) => r.scopeKey === scopeKey));
			};
			request.onerror = () => resolve(undefined);
		});
	}

	/** Vault rename：迁键 localPath，保留 xgkbFileId 等字段 */
	async relocateRecord(scopeKey: string, oldPath: string, newPath: string): Promise<boolean> {
		const record = await this.get(scopeKey, oldPath);
		if (!record) return false;
		await this.delete(scopeKey, oldPath);
		await this.put({ ...record, localPath: newPath, lastSyncAt: Date.now() });
		return true;
	}

	/** 标记文件待推送的远端 rename/move 动作。
	 *  连续多次 rename/move 时，保留最早一次的 pendingOldPath（= 远端文件实际所在路径），
	 *  仅更新 pendingNewPath 为最新目标路径，避免目录聚合使用过期中间路径。
	 */
	async markPendingRemoteRenameOrMove(
		scopeKey: string,
		localPath: string,
		oldPath: string,
		newPath: string
	): Promise<boolean> {
		const record = await this.get(scopeKey, localPath);
		if (!record) return false;
		const existingQueue = this.normalizePendingQueue(record);
		const now = Date.now();
		let nextQueue: PendingRemoteRenameOp[];
		if (existingQueue.length === 0) {
			nextQueue = [{ op: "rename-or-move", oldPath, newPath, setAt: now }];
		} else {
			nextQueue = [...existingQueue];
			const tail = nextQueue[nextQueue.length - 1];
			// 连续链式移动（A->B, B->C）压缩为同一链尾更新，减少噪音与中间态。
			if (tail.newPath === oldPath) {
				nextQueue[nextQueue.length - 1] = { ...tail, newPath, setAt: now };
			} else {
				nextQueue.push({ op: "rename-or-move", oldPath, newPath, setAt: now });
			}
		}
		const effective = {
			pendingRemoteOp: "rename-or-move" as const,
			pendingOldPath: nextQueue[0].oldPath,
			pendingNewPath: nextQueue[nextQueue.length - 1].newPath,
			pendingSetAt: nextQueue[nextQueue.length - 1].setAt,
			pendingRemoteOps: nextQueue,
		};
		await this.put({
			...record,
			...effective,
			lastSyncAt: Date.now(),
		});
		return true;
	}

	/** 文件夹 rename/move：为 newPrefix 下每个 record 标记待推送远端动作（push/bidirectional）。
	 *  与文件级 rename 对称，使目录移动在增量模式下也能被 reconcile 检测并推送到远端。
	 */
	async markPendingRemoteRenameByPrefix(
		scopeKey: string,
		oldPrefix: string,
		newPrefix: string
	): Promise<number> {
		if (!oldPrefix || oldPrefix === newPrefix) return 0;
		const all = await this.getAll(scopeKey);
		let marked = 0;
		for (const record of all) {
			if (!pathUnderPrefix(record.localPath, newPrefix)) continue;
			const suffix = record.localPath.slice(newPrefix.length);
			const oldPath = `${oldPrefix}${suffix}`;
			if (oldPath === record.localPath) continue;
			const ok = await this.markPendingRemoteRenameOrMove(
				scopeKey,
				record.localPath,
				oldPath,
				record.localPath
			);
			if (ok) marked++;
		}
		return marked;
	}

	/** 文件夹 rename/move：批量更新 oldPrefix 下所有 record 的路径前缀 */
	async relocateRecordsByPrefix(
		scopeKey: string,
		oldPrefix: string,
		newPrefix: string
	): Promise<number> {
		if (!oldPrefix || oldPrefix === newPrefix) return 0;
		const all = await this.getAll(scopeKey);
		let moved = 0;
		for (const record of all) {
			if (!pathUnderPrefix(record.localPath, oldPrefix)) continue;
			const suffix = record.localPath.slice(oldPrefix.length);
			const newPath = `${newPrefix}${suffix}`;
			if (newPath === record.localPath) continue;
			await this.delete(scopeKey, record.localPath);
			await this.put({ ...record, localPath: newPath, lastSyncAt: Date.now() });
			moved++;
		}
		return moved;
	}

	/** 目录级远端操作完成后，清除该前缀下所有 record 的 pendingRemoteOp */
	async clearPendingRemoteOpsByPrefix(scopeKey: string, prefix: string): Promise<void> {
		const all = await this.getAll(scopeKey);
		for (const record of all) {
			if (!pathUnderPrefix(record.localPath, prefix)) continue;
			if (!record.pendingRemoteOp && (!record.pendingRemoteOps || record.pendingRemoteOps.length === 0)) {
				continue;
			}
			await this.put({ ...clearPendingRemoteFields(record), lastSyncAt: Date.now() });
		}
	}

	/** 单文件 pending no-op 场景：清理该记录上的 pending 字段 */
	async clearPendingRemoteOps(scopeKey: string, localPath: string): Promise<void> {
		const record = await this.get(scopeKey, localPath);
		if (!record) return;
		if (!record.pendingRemoteOp && (!record.pendingRemoteOps || record.pendingRemoteOps.length === 0)) {
			return;
		}
		await this.put({ ...clearPendingRemoteFields(record), lastSyncAt: Date.now() });
	}

	private normalizePendingQueue(record: SyncStateRecord): PendingRemoteRenameOp[] {
		if (record.pendingRemoteOps?.length) return [...record.pendingRemoteOps];
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
					setAt: record.pendingSetAt ?? Date.now(),
				},
			];
		}
		return [];
	}

	/** moveFile 返回的 fileId 映射（目录 move 后子文件 id 可能变化） */
	async applyFileIdMappings(
		scopeKey: string,
		mappings: Array<{ sourceFileId: string; targetFileId: string }>
	): Promise<number> {
		if (mappings.length === 0) return 0;
		const lookup = new Map(mappings.map((m) => [m.sourceFileId, m.targetFileId]));
		const all = await this.getAll(scopeKey);
		let updated = 0;
		for (const record of all) {
			const nextFileId = lookup.get(record.xgkbFileId);
			const nextFolderId = lookup.get(record.xgkbFolderId);
			if (!nextFileId && !nextFolderId) continue;
			await this.put({
				...record,
				...(nextFileId ? { xgkbFileId: nextFileId } : {}),
				...(nextFolderId ? { xgkbFolderId: nextFolderId } : {}),
				lastSyncAt: Date.now(),
			});
			updated++;
		}
		return updated;
	}

	/** 移出 syncFolder 或删除时清理该前缀下所有 record */
	async deleteRecordsByPrefix(scopeKey: string, prefix: string): Promise<number> {
		if (!this.db || !prefix) return 0;
		const all = await this.getAll(scopeKey);
		let deleted = 0;
		for (const record of all) {
			if (!pathUnderPrefix(record.localPath, prefix)) continue;
			await this.delete(scopeKey, record.localPath);
			deleted++;
		}
		return deleted;
	}

	async deleteAllForScope(scopeKey: string): Promise<void> {
		if (!this.db) return;
		const records = await this.getAll(scopeKey);
		if (records.length === 0) return;
		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(DB_STORE_NAME, "readwrite");
			const store = tx.objectStore(DB_STORE_NAME);
			let pending = records.length;
			for (const r of records) {
				const request = store.delete([scopeKey, r.localPath]);
				request.onsuccess = () => {
					pending--;
					if (pending === 0) resolve();
				};
				request.onerror = () => reject(requestError(request));
			}
		});
	}

	async clear(): Promise<void> {
		if (!this.db) return;
		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(DB_STORE_NAME, "readwrite");
			const store = tx.objectStore(DB_STORE_NAME);
			const request = store.clear();
			request.onsuccess = () => resolve();
			request.onerror = () => reject(requestError(request));
		});
	}
}

function pathUnderPrefix(localPath: string, prefix: string): boolean {
	return localPath === prefix || localPath.startsWith(`${prefix}/`);
}

function clearPendingRemoteFields(record: SyncStateRecord): SyncStateRecord {
	const next = { ...record };
	delete next.pendingRemoteOp;
	delete next.pendingOldPath;
	delete next.pendingNewPath;
	delete next.pendingSetAt;
	delete next.pendingRemoteOps;
	return next;
}
