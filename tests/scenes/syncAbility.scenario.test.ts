import { describe, expect, it } from "vitest";
import { SyncEngine } from "../../src/syncEngine";
import type {
	FileEntry,
	MoveFileResult,
	Result,
	SyncStateRecord,
	XgkbChangeItem,
	XgkbListChangesData,
	XgkbMetaItem,
	XgkbPluginSettings,
} from "../../src/types";

const globalWithWindow = globalThis as unknown as {
	window: { setTimeout: typeof setTimeout };
};
globalWithWindow.window = {
	setTimeout: globalThis.setTimeout.bind(globalThis),
};

const SCOPE_KEY = "scene-sync";
const ROOT_ID = "root";

describe("plugin sync ability scenes", () => {
	it("first bidirectional sync uploads local files and downloads cloud files", async () => {
		const { local, remote, db, engine } = scene({
			local: { "local/a.md": "# Local A\n" },
			remote: { "cloud/b.md": "# Cloud B\n" },
		});

		const stats = await engine.runSync();

		expect(stats.failed).toBe(0);
		expect(stats.uploaded).toBe(1);
		expect(stats.downloaded).toBe(1);
		expect(local.content("cloud/b.md")).toBe("# Cloud B\n");
		expect(remote.content("local/a.md")).toBe("# Local A\n");
		await expectConverged(local, remote, db);
	});

	it("bidirectional sync propagates local and cloud updates", async () => {
		const context = scene({ local: { "note.md": "v1\n" } });
		let stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);

		await context.local.writeFile("note.md", "local v2\n");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.remote.content("note.md")).toBe("local v2\n");

		await context.remote.updatePath("note.md", "cloud v3\n");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.local.content("note.md")).toBe("cloud v3\n");
		await expectConverged(context.local, context.remote, context.db);
	});

	it("syncs local delete and explicit cloud delete", async () => {
		const context = scene({ local: { "delete-me.md": "delete me\n", "cloud-delete.md": "keep\n" } });
		let stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		let since = stats.newSince;

		await context.local.trashFile("delete-me.md");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.remote.has("delete-me.md")).toBe(false);

		context.remote.markDeletedChange("cloud-delete.md");
		stats = await context.engine.runSync(undefined, since);
		expect(stats.failed).toBe(0);
		expect(context.local.has("cloud-delete.md")).toBe(false);
		expect(context.local.trashedPaths).toContain("cloud-delete.md");
		await expectConverged(context.local, context.remote, context.db);
	});

	it("syncs file rename and move in both directions", async () => {
		const context = scene({ local: { "docs/a.md": "# A\n", "docs/b.md": "# B\n" } });
		let stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);

		await context.local.renameFile("docs/a.md", "docs/a-renamed.md");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.remote.has("docs/a-renamed.md")).toBe(true);
		expect(context.remote.has("docs/a.md")).toBe(false);

		await context.local.renameFile("docs/b.md", "archive/b.md");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.remote.has("archive/b.md")).toBe(true);
		expect(context.remote.has("docs/b.md")).toBe(false);

		await context.remote.renamePath("docs/a-renamed.md", "docs/a-cloud.md");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.local.has("docs/a-cloud.md")).toBe(true);
		expect(context.local.has("docs/a-renamed.md")).toBe(false);

		await context.remote.movePath("archive/b.md", "cloud-archive/b.md");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.local.has("cloud-archive/b.md")).toBe(true);
		expect(context.local.has("archive/b.md")).toBe(false);
		await expectConverged(context.local, context.remote, context.db);
	});

	it("syncs directory rename and move in both directions", async () => {
		const context = scene({
			local: {
				"topic/a.md": "# A\n",
				"topic/sub/b.md": "# B\n",
			},
		});
		let stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);

		await renameLocalFolder(context, "topic", "topic-renamed");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.remote.has("topic-renamed/a.md")).toBe(true);
		expect(context.remote.has("topic-renamed/sub/b.md")).toBe(true);
		expect(context.remote.has("topic/a.md")).toBe(false);

		await renameLocalFolder(context, "topic-renamed", "archive/topic-renamed");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.remote.has("archive/topic-renamed/a.md")).toBe(true);
		expect(context.remote.has("archive/topic-renamed/sub/b.md")).toBe(true);
		expect(context.remote.has("topic-renamed/a.md")).toBe(false);

		await renameRemoteFolder(context, "archive/topic-renamed", "archive/cloud-topic");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.local.has("archive/cloud-topic/a.md")).toBe(true);
		expect(context.local.has("archive/cloud-topic/sub/b.md")).toBe(true);
		expect(context.local.has("archive/topic-renamed/a.md")).toBe(false);

		await renameRemoteFolder(context, "archive/cloud-topic", "cloud-archive/cloud-topic");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.local.has("cloud-archive/cloud-topic/a.md")).toBe(true);
		expect(context.local.has("cloud-archive/cloud-topic/sub/b.md")).toBe(true);
		expect(context.local.has("archive/cloud-topic/a.md")).toBe(false);
		await expectConverged(context.local, context.remote, context.db);
	});

	it("resolves same-file conflicts by the newer mtime", async () => {
		const context = scene({ local: { "conflict.md": "v1\n" } });
		let stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);

		await context.remote.updatePath("conflict.md", "cloud older\n");
		await writeLocalNewerThanRemote(context, "conflict.md", "local newer\n");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.remote.content("conflict.md")).toBe("local newer\n");

		await context.local.writeFile("conflict.md", "local older\n");
		await updateRemoteNewerThanLocal(context, "conflict.md", "cloud newer\n");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.local.content("conflict.md")).toBe("cloud newer\n");
		await expectConverged(context.local, context.remote, context.db);
	});

	it("resolves first-sync same-path conflicts without duplicate files", async () => {
		const remoteWins = scene({
			local: { "same-path.md": "local old\n" },
			remote: { "same-path.md": "remote newer\n" },
		});

		let stats = await remoteWins.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(remoteWins.local.content("same-path.md")).toBe("remote newer\n");
		expect(Object.keys(await snapshotRemote(remoteWins.remote))).toEqual(["same-path.md"]);
		await expectConverged(remoteWins.local, remoteWins.remote, remoteWins.db);

		const localWins = scene({
			local: { "same-path.md": "local newer\n" },
			remote: { "same-path.md": "remote old\n" },
		});
		while ((localWins.local.mtime("same-path.md") ?? 0) < (localWins.remote.mtime("same-path.md") ?? 0)) {
			await localWins.local.writeFile("same-path.md", "local newer\n");
		}

		stats = await localWins.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(localWins.remote.content("same-path.md")).toBe("local newer\n");
		expect(Object.keys(await snapshotRemote(localWins.remote))).toEqual(["same-path.md"]);
		await expectConverged(localWins.local, localWins.remote, localWins.db);
	});

	it("retries a failed download on the next sync and converges", async () => {
		const context = scene({
			remote: {
				"cloud/a.md": "A\n",
				"cloud/b.md": "B\n",
				"cloud/c.md": "C\n",
			},
		});
		context.remote.failNextRead("cloud/b.md");

		let stats = await context.engine.runSync();
		expect(stats.failed).toBe(1);
		expect(context.local.has("cloud/a.md")).toBe(true);
		expect(context.local.has("cloud/b.md")).toBe(false);
		expect(context.local.has("cloud/c.md")).toBe(true);
		expect(context.db.recordsFor().find((record) => record.localPath === "cloud/b.md")?.syncStatus).toBe("failed");

		stats = await context.engine.runSync(undefined, stats.newSince);
		expect(stats.failed).toBe(0);
		expect(context.local.content("cloud/b.md")).toBe("B\n");
		await expectConverged(context.local, context.remote, context.db);
	});

	it("accepts remote rename when local is unchanged even if local mtime is newer", async () => {
		const context = scene({ remote: { "cloud-old.md": "cloud\n" } });
		let stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);

		const record = await context.db.get(SCOPE_KEY, "cloud-old.md");
		expect(record).toBeTruthy();
		const futureLocalMtime = (context.remote.mtime("cloud-old.md") ?? 0) + 10_000;
		context.local.setMtime("cloud-old.md", futureLocalMtime);
		await context.db.put({ ...record!, localMtime: futureLocalMtime });

		await context.remote.renamePath("cloud-old.md", "cloud-new.md");
		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(context.local.has("cloud-old.md")).toBe(false);
		expect(context.local.content("cloud-new.md")).toBe("cloud\n");
		expect(context.remote.has("cloud-old.md")).toBe(false);
		expect(context.remote.has("cloud-new.md")).toBe(true);
		await expectConverged(context.local, context.remote, context.db);
	});

	it("protects local files when a remote entry is missing without confirmed delete", async () => {
		const context = scene({ local: { "protected.md": "keep local\n" } });
		let stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);

		const remoteId = context.remote.id("protected.md");
		expect(remoteId).toBeTruthy();
		await context.remote.deleteFile(remoteId!);

		stats = await context.engine.runSync();
		expect(stats.failed).toBe(0);
		expect(stats.deleted).toBe(0);
		expect(context.local.content("protected.md")).toBe("keep local\n");
		expect(context.remote.has("protected.md")).toBe(false);
		expect(context.db.recordsFor().find((record) => record.localPath === "protected.md")?.syncStatus).toBe("done");
	});
});

function scene(seed: {
	local?: Record<string, string>;
	remote?: Record<string, string>;
	settings?: Partial<XgkbPluginSettings>;
} = {}) {
	const local = new MemoryLocalFs(seed.local);
	const remote = new MemoryXgkbFs(seed.remote);
	const db = new MemorySyncStateDb();
	const engine = new SyncEngine(
		local as never,
		remote as never,
		db as never,
		settings(seed.settings),
		SCOPE_KEY
	);
	return { local, remote, db, engine };
}

async function renameLocalFolder(
	context: ReturnType<typeof scene>,
	oldPrefix: string,
	newPrefix: string
): Promise<void> {
	await context.local.renameFolder(oldPrefix, newPrefix);
	await makeLocalFolderNewerThanRemote(context, newPrefix, oldPrefix);
	await context.db.relocateRecordsByPrefix(SCOPE_KEY, oldPrefix, newPrefix);
}

async function renameRemoteFolder(
	context: ReturnType<typeof scene>,
	oldPrefix: string,
	newPrefix: string
): Promise<void> {
	await context.remote.renameFolderPath(oldPrefix, newPrefix);
	await makeRemoteFolderNewerThanLocal(context, newPrefix, oldPrefix);
}

async function makeLocalFolderNewerThanRemote(
	context: ReturnType<typeof scene>,
	localPrefix: string,
	remotePrefix = localPrefix
): Promise<void> {
	const remoteFiles = await context.remote.listFiles();
	if (!remoteFiles.ok) throw new Error(remoteFiles.error);
	const remoteMax = Math.max(
		0,
		...remoteFiles.value
			.filter((file) => pathUnderPrefix(file.path, remotePrefix))
			.map((file) => file.mtime)
	);
	for (const file of await context.local.listFiles()) {
		if (!pathUnderPrefix(file.path, localPrefix)) continue;
		while ((context.local.mtime(file.path) ?? 0) <= remoteMax) {
			await context.local.writeFile(file.path, context.local.content(file.path) ?? "");
		}
	}
}

async function makeRemoteFolderNewerThanLocal(
	context: ReturnType<typeof scene>,
	remotePrefix: string,
	localPrefix = remotePrefix
): Promise<void> {
	const localFiles = await context.local.listFiles();
	const localMax = Math.max(
		0,
		...localFiles
			.filter((file) => pathUnderPrefix(file.path, localPrefix))
			.map((file) => file.mtime)
	);
	const remoteFiles = await context.remote.listFiles();
	if (!remoteFiles.ok) throw new Error(remoteFiles.error);
	for (const file of remoteFiles.value) {
		if (!pathUnderPrefix(file.path, remotePrefix)) continue;
		while ((context.remote.mtime(file.path) ?? 0) <= localMax) {
			await context.remote.touchPath(file.path);
		}
	}
}

async function writeLocalNewerThanRemote(
	context: ReturnType<typeof scene>,
	path: string,
	content: string
): Promise<void> {
	await context.local.writeFile(path, content);
	const remoteMtime = context.remote.mtime(path) ?? 0;
	while ((context.local.mtime(path) ?? 0) <= remoteMtime) {
		await context.local.writeFile(path, content);
	}
}

async function updateRemoteNewerThanLocal(
	context: ReturnType<typeof scene>,
	path: string,
	content: string
): Promise<void> {
	await context.remote.updatePath(path, content);
	const localMtime = context.local.mtime(path) ?? 0;
	while ((context.remote.mtime(path) ?? 0) <= localMtime) {
		await context.remote.updatePath(path, content);
	}
}

function settings(overrides: Partial<XgkbPluginSettings> = {}): XgkbPluginSettings {
	return {
		appKey: "test-key",
		serverUrl: "https://example.test/open-api/",
		projectId: "project-1",
		syncFolder: "",
		targetFolderName: "Obsidian",
		syncDirection: "bidirectional",
		autoSyncInterval: 0,
		usePhysicalUpload: true,
		uploadContentFallback: true,
		syncFileExtensions: ["md"],
		protectLocalDelete: true,
		...overrides,
	};
}

async function expectConverged(
	local: MemoryLocalFs,
	remote: MemoryXgkbFs,
	db: MemorySyncStateDb
): Promise<void> {
	expect(await snapshotLocal(local)).toEqual(await snapshotRemote(remote));
	const paths = Object.keys(await snapshotLocal(local)).sort();
	expect(db.recordsFor().map((record) => record.localPath).sort()).toEqual(paths);
	expect(db.recordsFor().every((record) => record.syncStatus === "done")).toBe(true);
}

class MemoryLocalFs {
	private files = new Map<string, { content: string; mtime: number }>();
	private nextMtime = 10_000;
	trashedPaths: string[] = [];

	constructor(seed: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(seed)) {
			this.files.set(path, { content, mtime: this.tick() });
		}
	}

	listFiles(): Promise<FileEntry[]> {
		return Promise.resolve(
			[...this.files.entries()].map(([path, file]) => ({
				path,
				name: basename(path),
				mtime: file.mtime,
				size: file.content.length,
			}))
		);
	}

	readFile(path: string): Promise<string> {
		const file = this.files.get(path);
		if (!file) throw new Error(`Local file not found: ${path}`);
		return Promise.resolve(file.content);
	}

	writeFile(path: string, content: string): Promise<number> {
		const mtime = this.tick();
		this.files.set(path, { content, mtime });
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
		for (const [path, file] of [...this.files.entries()]) {
			if (!pathUnderPrefix(path, oldPrefix)) continue;
			this.files.delete(path);
			const suffix = path.slice(oldPrefix.length);
			this.files.set(`${newPrefix}${suffix}`, { ...file, mtime: this.tick() });
		}
		return Promise.resolve();
	}

	folderExists(prefix: string): Promise<boolean> {
		return Promise.resolve([...this.files.keys()].some((path) => pathUnderPrefix(path, prefix)));
	}

	getMtime(path: string): Promise<number | null> {
		return Promise.resolve(this.files.get(path)?.mtime ?? null);
	}

	trashFile(path: string): Promise<void> {
		this.files.delete(path);
		this.trashedPaths.push(path);
		return Promise.resolve();
	}

	content(path: string): string | undefined {
		return this.files.get(path)?.content;
	}

	mtime(path: string): number | undefined {
		return this.files.get(path)?.mtime;
	}

	setMtime(path: string, mtime: number): void {
		const file = this.files.get(path);
		if (!file) throw new Error(`Local file not found: ${path}`);
		this.files.set(path, { ...file, mtime });
	}

	has(path: string): boolean {
		return this.files.has(path);
	}

	private tick(): number {
		this.nextMtime += 2_000;
		return this.nextMtime;
	}
}

class MemoryXgkbFs {
	private files = new Map<string, RemoteFile>();
	private folders = new Map<string, RemoteFolder>([
		["", { id: ROOT_ID, path: "", mtime: 0 }],
	]);
	private failNextReadPaths = new Set<string>();
	private nextId = 1;
	private nextFolderId = 1;
	private nextMtime = 20_000;
	private changes: XgkbChangeItem[] = [];
	serverTime = 30_000;

	constructor(seed: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(seed)) {
			const folderId = this.ensureFolder(parentPathOf(path));
			this.files.set(path, {
				id: this.allocFileId(),
				path,
				content,
				mtime: this.tick(),
				folderId,
			});
		}
	}

	init(): Promise<Result<string>> {
		return Promise.resolve({ ok: true, value: ROOT_ID });
	}

	isSyncAtProjectRoot(): boolean {
		return false;
	}

	getRootId(): string {
		return ROOT_ID;
	}

	listFiles(): Promise<Result<FileEntry[]>> {
		return Promise.resolve({
			ok: true,
			value: [...this.files.values()].map((file) => this.toEntry(file)),
		});
	}

	listAllChanges(_since: number): Promise<Result<XgkbListChangesData>> {
		return Promise.resolve({
			ok: true,
			value: {
				items: [...this.changes],
				serverTime: this.serverTime,
				nextCursor: null,
			},
		});
	}

	readFile(fileId: string): Promise<Result<string>> {
		const file = this.findById(fileId);
		if (file && this.failNextReadPaths.has(file.path)) {
			this.failNextReadPaths.delete(file.path);
			return Promise.resolve({ ok: false, error: "transient read failure" });
		}
		return file ? Promise.resolve({ ok: true, value: file.content }) : Promise.resolve({ ok: false, error: "not found" });
	}

	createFile(path: string, content: string): Promise<Result<{ fileId: string; folderId: string }>> {
		const folderId = this.ensureFolder(parentPathOf(path));
		const file: RemoteFile = {
			id: this.allocFileId(),
			path,
			content,
			mtime: this.tick(),
			folderId,
		};
		this.files.set(path, file);
		return Promise.resolve({ ok: true, value: { fileId: file.id, folderId } });
	}

	updateFile(fileId: string, _fileName: string, content: string): Promise<Result<{ fileId: string; fileName: string }>> {
		const file = this.findById(fileId);
		if (!file) return Promise.resolve({ ok: false, error: "not found" });
		file.content = content;
		file.mtime = this.tick();
		return Promise.resolve({ ok: true, value: { fileId, fileName: basename(file.path) } });
	}

	deleteFile(fileId: string): Promise<Result<boolean>> {
		const file = this.findById(fileId);
		if (file) this.files.delete(file.path);
		return Promise.resolve({ ok: true, value: true });
	}

	renameRemoteFile(fileId: string, newFileName: string): Promise<Result<void>> {
		const file = this.findById(fileId);
		if (file) {
			this.files.delete(file.path);
			file.path = pathJoin(parentPathOf(file.path), newFileName);
			file.mtime = this.tick();
			this.files.set(file.path, file);
			return Promise.resolve({ ok: true, value: undefined });
		}
		const folder = this.findFolderById(fileId);
		if (!folder || folder.id === ROOT_ID) return Promise.resolve({ ok: false, error: "not found" });
		this.renameFolderPathInternal(folder.path, pathJoin(parentPathOf(folder.path), newFileName));
		return Promise.resolve({ ok: true, value: undefined });
	}

	moveRemoteFile(fileId: string, targetParentId: string): Promise<Result<MoveFileResult>> {
		const file = this.findById(fileId);
		const target = this.findFolderById(targetParentId);
		if (!target) return Promise.resolve({ ok: false, error: "not found" });
		if (!file) {
			const folder = this.findFolderById(fileId);
			if (!folder || folder.id === ROOT_ID) return Promise.resolve({ ok: false, error: "not found" });
			const newPath = pathJoin(target.path, basename(folder.path));
			this.renameFolderPathInternal(folder.path, newPath);
			return Promise.resolve({
				ok: true,
				value: {
					fileId,
					sourceFileId: fileId,
					idChanged: false,
					name: basename(newPath),
					parentId: targetParentId,
					updateTime: this.folders.get(newPath)?.mtime ?? this.tick(),
				},
			});
		}
		this.files.delete(file.path);
		file.folderId = targetParentId;
		file.path = pathJoin(target.path, basename(file.path));
		file.mtime = this.tick();
		this.files.set(file.path, file);
		return Promise.resolve({
			ok: true,
			value: {
				fileId,
				sourceFileId: fileId,
				idChanged: false,
				name: basename(file.path),
				parentId: targetParentId,
				updateTime: file.mtime,
			},
		});
	}

	resolveFolderIdForRelativePath(path: string): Promise<Result<string>> {
		return Promise.resolve({ ok: true, value: this.ensureFolder(path) });
	}

	batchGetMetaAll(fileIds: string[]): Promise<Map<string, XgkbMetaItem>> {
		const map = new Map<string, XgkbMetaItem>();
		for (const id of fileIds) {
			const file = this.findById(id);
			if (file) {
				map.set(id, {
					fileId: id,
					parentId: file.folderId,
					name: basename(file.path),
					updateTime: file.mtime,
					size: file.content.length,
					relativePath: file.path,
				});
				continue;
			}
			const folder = this.findFolderById(id);
			if (folder) {
				map.set(id, {
					fileId: id,
					parentId: this.parentFolderId(folder.path),
					name: basename(folder.path),
					updateTime: folder.mtime,
					size: 0,
					relativePath: folder.path,
				});
			}
		}
		return Promise.resolve(map);
	}

	async updatePath(path: string, content: string): Promise<void> {
		const id = this.id(path);
		if (!id) throw new Error(`Remote file not found: ${path}`);
		await this.updateFile(id, basename(path), `${content}gap\n`);
		await this.updateFile(id, basename(path), content);
		this.setChanges([this.upsertChange(path)]);
	}

	async renamePath(oldPath: string, newPath: string): Promise<void> {
		const id = this.id(oldPath);
		if (!id) throw new Error(`Remote file not found: ${oldPath}`);
		if (parentPathOf(oldPath) !== parentPathOf(newPath)) {
			await this.movePath(oldPath, newPath);
			return;
		}
		const result = await this.renameRemoteFile(id, basename(newPath));
		if (!result.ok) throw new Error(result.error);
		this.setChanges([this.upsertChange(newPath)]);
	}

	async movePath(oldPath: string, newPath: string): Promise<void> {
		const id = this.id(oldPath);
		if (!id) throw new Error(`Remote file not found: ${oldPath}`);
		const folderId = this.ensureFolder(parentPathOf(newPath));
		const move = await this.moveRemoteFile(id, folderId);
		if (!move.ok) throw new Error(move.error);
		if (basename(oldPath) !== basename(newPath)) {
			const rename = await this.renameRemoteFile(id, basename(newPath));
			if (!rename.ok) throw new Error(rename.error);
		}
		this.setChanges([this.upsertChange(newPath)]);
	}

	async renameFolderPath(oldPrefix: string, newPrefix: string): Promise<void> {
		if (!this.folders.has(oldPrefix)) throw new Error(`Remote folder not found: ${oldPrefix}`);
		this.renameFolderPathInternal(oldPrefix, newPrefix);
	}

	async touchPath(path: string): Promise<void> {
		const file = this.files.get(path);
		if (!file) throw new Error(`Remote file not found: ${path}`);
		file.mtime = this.tick();
		this.setChanges([this.upsertChange(path)]);
	}

	markDeletedChange(path: string): void {
		const file = this.files.get(path);
		if (!file) throw new Error(`Remote file not found: ${path}`);
		this.files.delete(path);
		this.setChanges([
			{
				fileId: file.id,
				parentId: file.folderId,
				type: 2,
				name: basename(path),
				updateTime: this.tick(),
				event: "delete",
			},
		]);
	}

	content(path: string): string | undefined {
		return this.files.get(path)?.content;
	}

	mtime(path: string): number | undefined {
		return this.files.get(path)?.mtime;
	}

	has(path: string): boolean {
		return this.files.has(path);
	}

	id(path: string): string | undefined {
		return this.files.get(path)?.id;
	}

	failNextRead(path: string): void {
		this.failNextReadPaths.add(path);
	}

	private setChanges(items: XgkbChangeItem[]): void {
		this.changes = items;
		this.serverTime += 2_000;
	}

	private upsertChange(path: string): XgkbChangeItem {
		const file = this.files.get(path);
		if (!file) throw new Error(`Remote file not found: ${path}`);
		return {
			fileId: file.id,
			parentId: file.folderId,
			type: 2,
			name: basename(path),
			updateTime: file.mtime,
			relativePath: path,
			event: "upsert",
		};
	}

	private toEntry(file: RemoteFile): FileEntry {
		return {
			path: file.path,
			name: basename(file.path),
			mtime: file.mtime,
			size: file.content.length,
			xgkbFileId: file.id,
			xgkbFolderId: file.folderId,
		};
	}

	private ensureFolder(path: string): string {
		const normalized = trimSlashes(path);
		const existing = this.folders.get(normalized);
		if (existing) return existing.id;
		const parent = parentPathOf(normalized);
		if (normalized) this.ensureFolder(parent);
		const folder = { id: this.allocFolderId(), path: normalized, mtime: this.tick() };
		this.folders.set(normalized, folder);
		return folder.id;
	}

	private findById(fileId: string): RemoteFile | undefined {
		return [...this.files.values()].find((file) => file.id === fileId);
	}

	private findFolderById(folderId: string): RemoteFolder | undefined {
		return [...this.folders.values()].find((folder) => folder.id === folderId);
	}

	private parentFolderId(path: string): string {
		return this.ensureFolder(parentPathOf(path));
	}

	private renameFolderPathInternal(oldPrefix: string, newPrefix: string): void {
		const normalizedOld = trimSlashes(oldPrefix);
		const normalizedNew = trimSlashes(newPrefix);
		const touchedAt = this.tick();

		for (const [path, folder] of [...this.folders.entries()]) {
			if (!pathUnderPrefix(path, normalizedOld)) continue;
			this.folders.delete(path);
			const suffix = path.slice(normalizedOld.length);
			const nextPath = `${normalizedNew}${suffix}`;
			this.folders.set(nextPath, { ...folder, path: nextPath, mtime: touchedAt });
		}

		for (const [path, file] of [...this.files.entries()]) {
			if (!pathUnderPrefix(path, normalizedOld)) continue;
			this.files.delete(path);
			const suffix = path.slice(normalizedOld.length);
			const nextPath = `${normalizedNew}${suffix}`;
			this.files.set(nextPath, {
				...file,
				path: nextPath,
				folderId: this.ensureFolder(parentPathOf(nextPath)),
				mtime: touchedAt,
			});
		}
	}

	private allocFileId(): string {
		return `file-${this.nextId++}`;
	}

	private allocFolderId(): string {
		return `folder-${this.nextFolderId++}`;
	}

	private tick(): number {
		this.nextMtime += 2_000;
		return this.nextMtime;
	}
}

type RemoteFile = {
	id: string;
	path: string;
	content: string;
	mtime: number;
	folderId: string;
};

type RemoteFolder = {
	id: string;
	path: string;
	mtime: number;
};

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

	clearPendingRemoteOpsByPrefix(): Promise<void> {
		return Promise.resolve();
	}

	applyFileIdMappings(): Promise<number> {
		return Promise.resolve(0);
	}

	recordsFor(scopeKey = SCOPE_KEY): SyncStateRecord[] {
		return [...this.records.values()]
			.filter((record) => record.scopeKey === scopeKey)
			.map((record) => cloneRecord(record)!);
	}
}

async function snapshotLocal(local: MemoryLocalFs): Promise<Record<string, string>> {
	const files = await local.listFiles();
	return Object.fromEntries(
		files.map((file) => [file.path, local.content(file.path) ?? ""]).sort(([a], [b]) => a.localeCompare(b))
	);
}

async function snapshotRemote(remote: MemoryXgkbFs): Promise<Record<string, string>> {
	const listed = await remote.listFiles();
	if (!listed.ok) throw new Error(listed.error);
	return Object.fromEntries(
		listed.value.map((file) => [file.path, remote.content(file.path) ?? ""]).sort(([a], [b]) => a.localeCompare(b))
	);
}

function key(scopeKey: string, localPath: string): string {
	return `${scopeKey}\0${localPath}`;
}

function cloneRecord(record: SyncStateRecord | undefined): SyncStateRecord | undefined {
	return record ? { ...record } : undefined;
}

function parentPathOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx >= 0 ? path.slice(0, idx) : "";
}

function basename(path: string): string {
	return path.split("/").pop() || path;
}

function pathJoin(parent: string, child: string): string {
	return parent ? `${parent}/${child}` : child;
}

function trimSlashes(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}

function pathUnderPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}
