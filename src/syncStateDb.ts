import type { SyncStateRecord } from "./types";
import { DB_NAME, DB_VERSION, DB_STORE_NAME } from "./constants";
import type { Result } from "./types";

function requestError(request: IDBRequest): Error {
	return new Error(request.error?.message ?? "IndexedDB request failed");
}

/**
 * IndexedDB 状态持久化
 */
export class SyncStateDb {
	private db: IDBDatabase | null = null;

	async open(): Promise<Result<void>> {
		return new Promise((resolve) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);

			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(DB_STORE_NAME)) {
					const store = db.createObjectStore(DB_STORE_NAME, { keyPath: "localPath" });
					store.createIndex("xgkbFileId", "xgkbFileId", { unique: false });
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

	async get(localPath: string): Promise<SyncStateRecord | undefined> {
		if (!this.db) return undefined;
		return new Promise((resolve) => {
			const tx = this.db!.transaction(DB_STORE_NAME, "readonly");
			const store = tx.objectStore(DB_STORE_NAME);
			const request = store.get(localPath);
			request.onsuccess = () => resolve((request.result as SyncStateRecord | undefined) || undefined);
			request.onerror = () => resolve(undefined);
		});
	}

	async getByXgkbFileId(xgkbFileId: string): Promise<SyncStateRecord | undefined> {
		if (!this.db) return undefined;
		return new Promise((resolve) => {
			const tx = this.db!.transaction(DB_STORE_NAME, "readonly");
			const store = tx.objectStore(DB_STORE_NAME);
			const index = store.index("xgkbFileId");
			const request = index.get(xgkbFileId);
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

	async delete(localPath: string): Promise<void> {
		if (!this.db) return;
		return new Promise((resolve, reject) => {
			const tx = this.db!.transaction(DB_STORE_NAME, "readwrite");
			const store = tx.objectStore(DB_STORE_NAME);
			const request = store.delete(localPath);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(requestError(request));
		});
	}

	async getAll(): Promise<SyncStateRecord[]> {
		if (!this.db) return [];
		return new Promise((resolve) => {
			const tx = this.db!.transaction(DB_STORE_NAME, "readonly");
			const store = tx.objectStore(DB_STORE_NAME);
			const request = store.getAll();
			request.onsuccess = () => resolve(request.result || []);
			request.onerror = () => resolve([]);
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
