import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
	API_PATHS,
	cleanContent,
	DEFAULT_MOVE_NAME_CONFLICT_STRATEGY,
	DEFAULT_RENAME_NAME_CONFLICT_STRATEGY,
	KB_PROJECT_ROOT_FILE_ID,
} from "../../src/constants";
import {
	normalizeKbRelativePath,
	normalizeTargetFolderPath,
	parseTargetFolderSegments,
	sanitizePathSegment,
} from "../../src/pathSanitize";
import type {
	DownloadInfoVO,
	FileEntry,
	MoveFileResult,
	Result,
	SyncStateRecord,
	UpdateFileResult,
	UploadContentResult,
	XgkbChangeItem,
	XgkbFileVO,
	XgkbListChangesData,
	XgkbListDescendantFilesData,
	XgkbMetaItem,
	XgkbPluginSettings,
} from "../../src/types";

const globalWithWindow = globalThis as unknown as {
	window: { setTimeout: typeof setTimeout };
};
globalWithWindow.window = {
	setTimeout: globalThis.setTimeout.bind(globalThis),
};

const SCOPE_KEY = "real-cloud-smoke";
const CONFIG = loadConfig();
const runRealCloud = CONFIG ? it : it.skip;

describe("plugin sync with real cloud smoke", () => {
	runRealCloud(
		"round-trips create, update, rename, move, and delete against the real cloud",
		async () => {
			if (!CONFIG) throw new Error("Missing real cloud test config");

			const { SyncEngine } = await import("../../src/syncEngine");

			const runId = `sync-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const localPath = `${runId}-local.md`;
			const cloudPath = `${runId}-cloud.md`;
			const cloudRenamedPath = `${runId}-cloud-renamed.md`;
			const movedFolder = `${runId}-moved`;
			const cloudMovedPath = `${movedFolder}/${runId}-cloud-renamed.md`;

			const local = new MemoryLocalFs({ [localPath]: "local v1\n" });
			const db = new MemorySyncStateDb();
			const remote = new RealXgkbFs(CONFIG);
			const engine = new SyncEngine(
				local as never,
				remote as never,
				db as never,
				settings(CONFIG),
				SCOPE_KEY
			);

			try {
				let stats = await engine.runSync();
				expect(stats.failed).toBe(0);
				await expectRemoteContent(remote, localPath, "local v1\n");

				await expectOk(await remote.createFile(cloudPath, "cloud v1\n"));
				await settle();
				stats = await engine.runSync();
				expect(stats.failed).toBe(0);
				expect(local.content(cloudPath)).toBe("cloud v1\n");

				await local.writeFile(localPath, "local v2\n");
				stats = await engine.runSync();
				expect(stats.failed).toBe(0);
				await expectRemoteContent(remote, localPath, "local v2\n");

				let cloud = await expectRemoteEntry(remote, cloudPath);
				await expectOk(await remote.updateFile(cloud.xgkbFileId!, cloud.name, "cloud v2\n"));
				await settle();
				stats = await engine.runSync();
				expect(stats.failed).toBe(0);
				expect(local.content(cloudPath)).toBe("cloud v2\n");

				cloud = await expectRemoteEntry(remote, cloudPath);
				await expectOk(await remote.renameRemoteFile(cloud.xgkbFileId!, `${runId}-cloud-renamed.md`));
				await settle();
				stats = await engine.runSync();
				expect(stats.failed).toBe(0);
				expect(local.has(cloudRenamedPath)).toBe(true);
				expect(local.has(cloudPath)).toBe(false);

				cloud = await expectRemoteEntry(remote, cloudRenamedPath);
				const targetFolder = await remote.resolveFolderIdForRelativePath(movedFolder);
				await expectOk(targetFolder);
				await expectOk(await remote.moveRemoteFile(cloud.xgkbFileId!, targetFolder.value));
				await settle();
				stats = await engine.runSync();
				expect(stats.failed).toBe(0);
				expect(local.has(cloudMovedPath)).toBe(true);
				expect(local.has(cloudRenamedPath)).toBe(false);

				await local.trashFile(localPath);
				stats = await engine.runSync();
				expect(stats.failed).toBe(0);
				expect(await remoteHas(remote, localPath)).toBe(false);

				const since = stats.newSince;
				cloud = await expectRemoteEntry(remote, cloudMovedPath);
				await expectOk(await remote.deleteFile(cloud.xgkbFileId!));
				await settle();
				stats = await engine.runSync(undefined, since);
				expect(stats.failed).toBe(0);
				expect(local.has(cloudMovedPath)).toBe(false);
				expect(local.trashedPaths).toContain(cloudMovedPath);
			} finally {
				await cleanupRunFiles(remote, runId);
			}
		},
		60_000
	);
});

type RealCloudConfig = {
	serverUrl: string;
	appKey: string;
	projectId: string;
	rootFolder: string;
};

function loadConfig(): RealCloudConfig | null {
	loadDotEnvFile(path.resolve(process.cwd(), ".env.test.local"));

	const allowWrite = normalizeBoolean(process.env.XGKB_TEST_ALLOW_WRITE);
	const serverUrl = process.env.XGKB_TEST_SERVER_URL?.trim();
	const appKey = process.env.XGKB_TEST_APP_KEY?.trim();
	const projectId = process.env.XGKB_TEST_PROJECT_ID?.trim();
	const rootFolder = process.env.XGKB_TEST_ROOT_FOLDER?.trim();

	if (!allowWrite || !serverUrl || !appKey || !rootFolder) return null;
	return {
		serverUrl,
		appKey,
		projectId: projectId ?? "",
		rootFolder,
	};
}

function loadDotEnvFile(filePath: string): void {
	if (!fs.existsSync(filePath)) return;
	const content = fs.readFileSync(filePath, "utf8");
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		const rawValue = trimmed.slice(eq + 1).trim();
		if (process.env[key] !== undefined) continue;
		process.env[key] = unquote(rawValue);
	}
}

function unquote(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function normalizeBoolean(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function settings(config: RealCloudConfig): XgkbPluginSettings {
	return {
		appKey: config.appKey,
		serverUrl: config.serverUrl,
		projectId: config.projectId,
		syncFolder: "",
		targetFolderName: config.rootFolder,
		syncDirection: "bidirectional",
		autoSyncInterval: 0,
		usePhysicalUpload: false,
		uploadContentFallback: true,
		syncFileExtensions: ["md"],
		protectLocalDelete: true,
	};
}

class RealXgkbFs {
	private rootId: string | null = null;
	private projectId: string | null = null;
	private readonly targetFolderPath: string;
	private readonly syncAtProjectRoot: boolean;

	constructor(private config: RealCloudConfig) {
		this.targetFolderPath = normalizeTargetFolderPath(config.rootFolder);
		this.syncAtProjectRoot = this.targetFolderPath.length === 0;
	}

	async init(): Promise<Result<string>> {
		this.projectId = this.config.projectId || await this.resolveProjectId();
		if (this.syncAtProjectRoot) {
			this.rootId = KB_PROJECT_ROOT_FILE_ID;
			return { ok: true, value: this.rootId };
		}
		const resolved = await this.resolveFolderIdFromPath(this.targetFolderPath);
		if (!resolved.ok) return resolved;
		this.rootId = resolved.value;
		return { ok: true, value: this.rootId };
	}

	isSyncAtProjectRoot(): boolean {
		return this.syncAtProjectRoot;
	}

	getRootId(): string | null {
		return this.rootId;
	}

	async listFiles(): Promise<Result<FileEntry[]>> {
		if (!this.rootId) return { ok: false, error: "not initialized" };
		const entries: FileEntry[] = [];
		const seen = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await this.request<XgkbListDescendantFilesData>("GET", API_PATHS.listDescendantFiles, {
				rootFileId: this.rootId,
				projectId: this.projectId || undefined,
				suffix: "md",
				limit: 500,
				cursor,
				includePath: true,
			});
			if (!page.ok) return page;
			for (const item of page.value.files || []) {
				const safePath = normalizeKbRelativePath(item.relativePath || item.name);
				if (!safePath.endsWith(".md") || seen.has(safePath)) continue;
				seen.add(safePath);
				entries.push({
					path: safePath,
					name: item.name,
					mtime: item.updateTime || 0,
					size: item.size,
					xgkbFileId: String(item.fileId),
					xgkbFolderId: item.parentId != null ? String(item.parentId) : "",
				});
			}
			cursor = page.value.nextCursor || undefined;
		} while (cursor);
		return { ok: true, value: entries };
	}

	async listAllChanges(since: number): Promise<Result<{ items: XgkbChangeItem[]; serverTime?: number }>> {
		if (!this.rootId || !this.projectId) return { ok: false, error: "not initialized" };
		const items: XgkbChangeItem[] = [];
		let cursor: string | undefined;
		let serverTime: number | undefined;
		do {
			const page = await this.request<XgkbListChangesData>("GET", API_PATHS.listChanges, {
				projectId: this.projectId,
				rootFileId: this.rootId,
				since,
				cursor,
				limit: 500,
				includePath: true,
			});
			if (!page.ok) return page;
			items.push(...(page.value.items || []));
			serverTime = page.value.serverTime ?? serverTime;
			cursor = page.value.nextCursor || undefined;
		} while (cursor);
		return { ok: true, value: { items, serverTime } };
	}

	async readFile(fileId: string): Promise<Result<string>> {
		const download = await this.request<DownloadInfoVO>("GET", API_PATHS.getDownloadInfo, {
			fileId,
			forceDownload: true,
		});
		if (download.ok && download.value.downloadUrl) {
			const response = await fetch(download.value.downloadUrl);
			if (response.ok) return { ok: true, value: cleanContent(await response.text()) };
		}

		const fallback = await this.request<string>("GET", API_PATHS.getFullFileContent, { fileId });
		if (!fallback.ok) return fallback;
		return { ok: true, value: cleanContent(fallback.value) };
	}

	async createFile(relativePath: string, content: string): Promise<Result<{ fileId: string; folderId: string }>> {
		const { folderName, fileName } = this.splitRelativePath(relativePath);
		const result = await this.request<UploadContentResult>("POST", API_PATHS.uploadContent, {
			content,
			fileName,
			fileSuffix: suffixOf(fileName),
			folderName,
			projectId: this.projectId || undefined,
		});
		if (!result.ok) return result;
		return {
			ok: true,
			value: {
				fileId: String(result.value.fileId),
				folderId: result.value.folderId != null ? String(result.value.folderId) : "",
			},
		};
	}

	async updateFile(fileId: string, fileName: string, content: string): Promise<Result<string>> {
		const result = await this.request<UpdateFileResult>("POST", API_PATHS.uploadContent, {
			content,
			fileName,
			fileSuffix: suffixOf(fileName),
			updateFileId: fileId,
			versionRemark: "XGKB Sync plugin update",
		});
		if (!result.ok) return result;
		return { ok: true, value: String(result.value.fileId) };
	}

	async deleteFile(fileId: string): Promise<Result<void>> {
		const result = await this.request<boolean>("POST", API_PATHS.deleteFile, { fileId });
		if (!result.ok) return result;
		return { ok: true, value: undefined };
	}

	async renameRemoteFile(fileId: string, newFileName: string): Promise<Result<void>> {
		if (!this.projectId) return { ok: false, error: "not initialized" };
		const result = await this.request<unknown>("POST", API_PATHS.updateFileName, {
			fileId,
			newName: newFileName,
			projectId: this.projectId,
			nameConflictStrategy: DEFAULT_RENAME_NAME_CONFLICT_STRATEGY,
			rootFileId: this.rootId ?? undefined,
		});
		if (!result.ok) return result;
		return { ok: true, value: undefined };
	}

	async moveRemoteFile(fileId: string, targetParentId: string): Promise<Result<MoveFileResult>> {
		if (!this.projectId) return { ok: false, error: "not initialized" };
		const result = await this.request<MoveFileResult>("POST", API_PATHS.moveFile, {
			fileId,
			targetParentId,
			projectId: this.projectId,
			nameConflictStrategy: DEFAULT_MOVE_NAME_CONFLICT_STRATEGY,
			rootFileId: this.rootId ?? undefined,
		});
		if (!result.ok) return result;
		if (result.value.mainSkipped) return { ok: false, error: "move skipped by cloud" };
		return result;
	}

	async resolveFolderIdForRelativePath(relativeFolderPath: string): Promise<Result<string>> {
		if (!this.projectId || !this.rootId) return { ok: false, error: "not initialized" };
		const segments = relativeFolderPath.split("/").filter(Boolean).map(sanitizePathSegment);
		let currentId = this.rootId;
		for (const seg of segments) {
			const children = await this.request<XgkbFileVO[]>("GET", API_PATHS.getChildFiles, {
				parentId: currentId,
				type: 1,
			});
			if (!children.ok) return children;
			const found = (children.value || []).find((item) => item.name === seg && item.type === 1);
			if (found) {
				currentId = String(found.id);
				continue;
			}
			const created = await this.request<string | number>("POST", API_PATHS.createFolder, {
				projectId: this.projectId,
				parentId: currentId,
				name: seg,
			});
			if (!created.ok) return created;
			currentId = String(created.value);
		}
		return { ok: true, value: currentId };
	}

	async batchGetMetaAll(fileIds: string[]): Promise<Map<string, XgkbMetaItem>> {
		const map = new Map<string, XgkbMetaItem>();
		for (let i = 0; i < fileIds.length; i += 50) {
			const batch = fileIds.slice(i, i + 50);
			const result = await this.request<XgkbMetaItem[]>("POST", API_PATHS.batchGetMeta, {
				fileIds: batch,
				projectId: this.projectId || undefined,
				includePath: true,
				rootFileId: this.rootId || undefined,
			});
			if (!result.ok) continue;
			for (const meta of result.value || []) {
				map.set(String(meta.fileId), meta);
			}
		}
		return map;
	}

	private async resolveProjectId(): Promise<string> {
		const result = await this.request<string | number>("GET", API_PATHS.getPersonalProjectId);
		if (!result.ok) throw new Error(result.error);
		return String(result.value);
	}

	private async resolveFolderIdFromPath(folderPath: string): Promise<Result<string>> {
		if (!this.projectId) return { ok: false, error: "not initialized" };
		const segments = parseTargetFolderSegments(folderPath);
		const first = segments[0];
		const level1 = await this.request<XgkbFileVO[]>("GET", API_PATHS.getLevel1Folders, {
			projectId: this.projectId,
		});
		if (!level1.ok) return level1;
		const found = (level1.value || []).find((item) => item.name === first && item.type === 1);
		let currentId: string;
		if (found) {
			currentId = String(found.id);
		} else {
			const created = await this.request<string | number>("POST", API_PATHS.createFolder, {
				projectId: this.projectId,
				parentId: "0",
				name: first,
			});
			if (!created.ok) return created;
			currentId = String(created.value);
		}
		for (const seg of segments.slice(1)) {
			const child = await this.resolveChildFolder(currentId, seg);
			if (!child.ok) return child;
			currentId = child.value;
		}
		return { ok: true, value: currentId };
	}

	private async resolveChildFolder(parentId: string, name: string): Promise<Result<string>> {
		if (!this.projectId) return { ok: false, error: "not initialized" };
		const children = await this.request<XgkbFileVO[]>("GET", API_PATHS.getChildFiles, {
			parentId,
			type: 1,
		});
		if (!children.ok) return children;
		const found = (children.value || []).find((item) => item.name === name && item.type === 1);
		if (found) return { ok: true, value: String(found.id) };
		const created = await this.request<string | number>("POST", API_PATHS.createFolder, {
			projectId: this.projectId,
			parentId,
			name,
		});
		if (!created.ok) return created;
		return { ok: true, value: String(created.value) };
	}

	private splitRelativePath(relativePath: string): { folderName: string; fileName: string } {
		const lastSlash = relativePath.lastIndexOf("/");
		const folderPath = lastSlash > 0 ? relativePath.substring(0, lastSlash) : "";
		const fileName = lastSlash > 0 ? relativePath.substring(lastSlash + 1) : relativePath;
		const folderName = this.syncAtProjectRoot
			? folderPath
			: folderPath
				? `${this.targetFolderPath}/${folderPath}`
				: this.targetFolderPath;
		return { folderName, fileName };
	}

	private async request<T>(
		method: "GET" | "POST",
		apiPath: string,
		params?: Record<string, unknown>
	): Promise<Result<T>> {
		const baseUrl = `${this.config.serverUrl.replace(/\/+$/, "")}/${apiPath}`;
		let url = baseUrl;
		const init: RequestInit = {
			method,
			headers: {
				"Content-Type": "application/json",
				appKey: this.config.appKey,
			},
		};

		if (method === "GET" && params) {
			const qs = Object.entries(params)
				.filter(([, value]) => value !== undefined && value !== null)
				.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
				.join("&");
			if (qs) url = `${baseUrl}?${qs}`;
		} else if (method === "POST" && params) {
			init.body = JSON.stringify(params);
		}

		try {
			const response = await fetch(url, init);
			const text = await response.text();
			if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${text}` };
			const json = JSON.parse(text) as { resultCode: number; resultMsg?: string; data: T };
			if (json.resultCode !== 1) {
				return { ok: false, error: `API error ${json.resultCode}: ${json.resultMsg ?? "Unknown error"}` };
			}
			return { ok: true, value: json.data };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
}

function suffixOf(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	return dot >= 0 ? fileName.slice(dot + 1) : "";
}

async function expectRemoteContent(remote: RealRemote, remotePath: string, content: string): Promise<void> {
	const entry = await expectRemoteEntry(remote, remotePath);
	const body = await remote.readFile(entry.xgkbFileId!);
	await expectOk(body);
	expect(body.value).toBe(content);
}

async function expectRemoteEntry(remote: RealRemote, remotePath: string): Promise<FileEntry> {
	const listed = await remote.listFiles();
	await expectOk(listed);
	const entry = listed.value.find((file) => file.path === remotePath);
	expect(entry, `missing remote path ${remotePath}`).toBeTruthy();
	return entry!;
}

async function remoteHas(remote: RealRemote, remotePath: string): Promise<boolean> {
	const listed = await remote.listFiles();
	await expectOk(listed);
	return listed.value.some((file) => file.path === remotePath);
}

async function cleanupRunFiles(remote: RealRemote, runId: string): Promise<void> {
	const init = await remote.init();
	if (!init.ok) return;
	const listed = await remote.listFiles();
	if (!listed.ok) return;
	for (const file of listed.value) {
		if (!file.path.includes(runId) || !file.xgkbFileId) continue;
		await remote.deleteFile(file.xgkbFileId);
	}
}

async function expectOk<T>(result: { ok: true; value: T } | { ok: false; error: string }): Promise<void> {
	if (!result.ok) throw new Error(result.error);
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 500));
}

type RealRemote = {
	init(): Promise<{ ok: true; value: string } | { ok: false; error: string }>;
	listFiles(): Promise<{ ok: true; value: FileEntry[] } | { ok: false; error: string }>;
	readFile(fileId: string): Promise<{ ok: true; value: string } | { ok: false; error: string }>;
	deleteFile(fileId: string): Promise<{ ok: true; value: void } | { ok: false; error: string }>;
};

class MemoryLocalFs {
	private files = new Map<string, { content: string; mtime: number }>();
	private nextMtime = 10_000;
	trashedPaths: string[] = [];

	constructor(seed: Record<string, string> = {}) {
		for (const [filePath, content] of Object.entries(seed)) {
			this.files.set(filePath, { content, mtime: this.tick() });
		}
	}

	listFiles(): Promise<FileEntry[]> {
		return Promise.resolve(
			[...this.files.entries()].map(([filePath, file]) => ({
				path: filePath,
				name: basename(filePath),
				mtime: file.mtime,
				size: file.content.length,
			}))
		);
	}

	readFile(filePath: string): Promise<string> {
		const file = this.files.get(filePath);
		if (!file) throw new Error(`Local file not found: ${filePath}`);
		return Promise.resolve(file.content);
	}

	writeFile(filePath: string, content: string): Promise<number> {
		const mtime = this.tick();
		this.files.set(filePath, { content, mtime });
		return Promise.resolve(mtime);
	}

	renameFile(oldPath: string, newPath: string): Promise<number> {
		const file = this.files.get(oldPath);
		if (!file) throw new Error(`Local file not found: ${oldPath}`);
		this.files.delete(oldPath);
		const mtime = this.tick();
		this.files.set(newPath, { content: file.content, mtime });
		return Promise.resolve(mtime);
	}

	renameFolder(oldPrefix: string, newPrefix: string): Promise<void> {
		for (const [filePath, file] of [...this.files.entries()]) {
			if (!pathUnderPrefix(filePath, oldPrefix)) continue;
			this.files.delete(filePath);
			const suffix = filePath.slice(oldPrefix.length);
			this.files.set(`${newPrefix}${suffix}`, { ...file, mtime: this.tick() });
		}
		return Promise.resolve();
	}

	folderExists(prefix: string): Promise<boolean> {
		return Promise.resolve([...this.files.keys()].some((filePath) => pathUnderPrefix(filePath, prefix)));
	}

	getMtime(filePath: string): Promise<number | null> {
		return Promise.resolve(this.files.get(filePath)?.mtime ?? null);
	}

	trashFile(filePath: string): Promise<void> {
		this.files.delete(filePath);
		this.trashedPaths.push(filePath);
		return Promise.resolve();
	}

	content(filePath: string): string | undefined {
		return this.files.get(filePath)?.content;
	}

	has(filePath: string): boolean {
		return this.files.has(filePath);
	}

	private tick(): number {
		this.nextMtime += 2_000;
		return this.nextMtime;
	}
}

class MemorySyncStateDb {
	private records = new Map<string, SyncStateRecord>();

	get(scopeKey: string, localPath: string): Promise<SyncStateRecord | undefined> {
		return Promise.resolve(cloneRecord(this.records.get(key(scopeKey, localPath))));
	}

	put(record: SyncStateRecord): Promise<void> {
		this.records.set(key(record.scopeKey, record.localPath), cloneRecord(record)!);
		return Promise.resolve();
	}

	delete(scopeKey: string, localPath: string): Promise<void> {
		this.records.delete(key(scopeKey, localPath));
		return Promise.resolve();
	}

	getAll(scopeKey: string): Promise<SyncStateRecord[]> {
		return Promise.resolve(
			[...this.records.values()]
				.filter((record) => record.scopeKey === scopeKey)
				.map((record) => cloneRecord(record)!)
		);
	}

	relocateRecord(scopeKey: string, oldPath: string, newPath: string): Promise<boolean> {
		const record = this.records.get(key(scopeKey, oldPath));
		if (!record) return Promise.resolve(false);
		this.records.delete(key(scopeKey, oldPath));
		this.records.set(key(scopeKey, newPath), { ...record, localPath: newPath });
		return Promise.resolve(true);
	}

	relocateRecordsByPrefix(scopeKey: string, oldPrefix: string, newPrefix: string): Promise<number> {
		let moved = 0;
		for (const record of [...this.records.values()]) {
			if (record.scopeKey !== scopeKey || !pathUnderPrefix(record.localPath, oldPrefix)) continue;
			this.records.delete(key(scopeKey, record.localPath));
			const suffix = record.localPath.slice(oldPrefix.length);
			this.records.set(key(scopeKey, `${newPrefix}${suffix}`), {
				...record,
				localPath: `${newPrefix}${suffix}`,
			});
			moved++;
		}
		return Promise.resolve(moved);
	}

	clearPendingRemoteOps(scopeKey: string, localPath: string): Promise<void> {
		const record = this.records.get(key(scopeKey, localPath));
		if (record) this.records.set(key(scopeKey, localPath), { ...record, pendingRemoteOps: [] });
		return Promise.resolve();
	}

	clearPendingRemoteOpsByPrefix(scopeKey: string, prefix: string): Promise<void> {
		for (const record of [...this.records.values()]) {
			if (record.scopeKey !== scopeKey || !pathUnderPrefix(record.localPath, prefix)) continue;
			this.records.set(key(scopeKey, record.localPath), {
				...record,
				pendingRemoteOp: undefined,
				pendingOldPath: undefined,
				pendingNewPath: undefined,
				pendingSetAt: undefined,
				pendingRemoteOps: undefined,
			});
		}
		return Promise.resolve();
	}

	applyFileIdMappings(
		scopeKey: string,
		mappings: Array<{ sourceFileId: string; targetFileId: string }>
	): Promise<number> {
		let changed = 0;
		for (const record of [...this.records.values()]) {
			if (record.scopeKey !== scopeKey) continue;
			const mapping = mappings.find((item) => item.sourceFileId === record.xgkbFileId);
			if (!mapping) continue;
			this.records.set(key(scopeKey, record.localPath), {
				...record,
				xgkbFileId: mapping.targetFileId,
			});
			changed++;
		}
		return Promise.resolve(changed);
	}
}

function key(scopeKey: string, localPath: string): string {
	return `${scopeKey}\0${localPath}`;
}

function cloneRecord(record: SyncStateRecord | undefined): SyncStateRecord | undefined {
	return record ? { ...record } : undefined;
}

function basename(filePath: string): string {
	return filePath.split("/").pop() || filePath;
}

function pathUnderPrefix(filePath: string, prefix: string): boolean {
	return filePath === prefix || filePath.startsWith(`${prefix}/`);
}
