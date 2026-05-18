import type { SyncStateRecord } from "./types";
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
