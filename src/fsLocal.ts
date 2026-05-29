import type { App, TFolder } from "obsidian";
// 使用命名空间导入，避免 esbuild 误删对 obsidian 的运行时引用（instanceof 需要构造函数）
import * as Obsidian from "obsidian";
import { normalizePath } from "obsidian";
import type { FileEntry } from "./types";
import { sanitizePathSegment, sanitizeRelativePath } from "./pathSanitize";
import { extensionOfPath } from "./syncFileTypes";

/** 文件名以 `.` 开头：Obsidian Vault API 不可靠，统一走 adapter */
function isDotHiddenRelativePath(relativePath: string): boolean {
	const slash = relativePath.lastIndexOf("/");
	const base = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
	return base.startsWith(".");
}

/** FileSystemAdapter：vault 相对路径 → 磁盘绝对路径 */
interface FileSystemAdapterLike {
	getFullPath(normalizedPath: string): string;
}

function tryRequireFs(): typeof import("fs") | null {
	try {
		// 动态加载：移动端无 fs，避免插件启动失败
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return require("fs") as typeof import("fs");
	} catch {
		return null;
	}
}

/**
 * 本地文件系统操作（Vault API 封装）
 */
export class FsLocal {
	private basePath: string;
	private syncExtensions: readonly string[];
	/** 同一目录并发 createFolder 时串行，避免 Obsidian 报 Folder already exists */
	private folderEnsureLocks = new Map<string, Promise<void>>();

	constructor(
		private app: App,
		syncFolder: string,
		syncExtensions: readonly string[] = ["md"]
	) {
		this.basePath = syncFolder ? this.normalize(syncFolder) : app.vault.getRoot().path;
		this.syncExtensions = syncExtensions;
	}

	private normalize(p: string): string {
		return normalizePath(p.replace(/\\/g, "/").replace(/\/+/g, "/"));
	}

	/** 列出 syncFolder 下所有已选类型的文件（递归，含 adapter 上的隐藏点文件） */
	async listFiles(): Promise<FileEntry[]> {
		const folder = this.app.vault.getAbstractFileByPath(this.basePath);
		const entries: FileEntry[] = [];
		const seen = new Set<string>();
		if (folder && folder instanceof Obsidian.TFolder) {
			await this.collectFromVaultTree(folder, entries, "", seen);
		}
		// 补充仅存在于磁盘、未编入 Vault 树的目录（adapter 递归）
		await this.collectDotFilesFromAdapter("", entries, seen);
		return entries;
	}

	private async collectFromVaultTree(
		folder: TFolder,
		entries: FileEntry[],
		prefix: string,
		seen: Set<string>
	): Promise<void> {
		// Vault 树能到达的目录：逐层用 adapter 补扫点文件（子目录不能只靠根级 adapter.list 递归）
		await this.collectDotFilesInAdapterDir(prefix, entries, seen);

		for (const child of folder.children) {
			if (child instanceof Obsidian.TFile) {
				if (
					this.syncExtensions.includes(child.extension) &&
					!child.name.includes("_conflict_")
				) {
					const seg = sanitizePathSegment(child.name);
					const relativePath = prefix ? `${prefix}/${seg}` : seg;
					if (seen.has(relativePath)) continue;
					seen.add(relativePath);
					entries.push({
						path: relativePath,
						name: child.name,
						mtime: child.stat.mtime,
						size: child.stat.size,
					});
				}
			} else if (child instanceof Obsidian.TFolder) {
				const seg = sanitizePathSegment(child.name);
				const subPrefix = prefix ? `${prefix}/${seg}` : seg;
				if (child.name.startsWith(".")) continue;
				await this.collectFromVaultTree(child, entries, subPrefix, seen);
			}
		}
	}

	/**
	 * 列举目录下文件名。子目录中的点文件 Obsidian adapter.list 常漏报，桌面端改读磁盘。
	 */
	private async listFileNamesInVaultDir(normalizedDir: string): Promise<string[]> {
		const adapter = this.app.vault.adapter as Partial<FileSystemAdapterLike>;
		const fs = tryRequireFs();
		if (typeof adapter.getFullPath === "function" && fs?.promises?.readdir) {
			try {
				const diskDir = adapter.getFullPath(normalizedDir);
				const dirents = await fs.promises.readdir(diskDir, { withFileTypes: true });
				return dirents.filter((d) => d.isFile()).map((d) => d.name);
			} catch {
				// 回退 adapter.list
			}
		}
		try {
			const listed = await this.app.vault.adapter.list(normalizedDir);
			return listed.files;
		} catch {
			return [];
		}
	}

	/** 在当前目录（相对 syncFolder）列举以 `.` 开头的可同步文件 */
	private async collectDotFilesInAdapterDir(
		relativeDir: string,
		entries: FileEntry[],
		seen: Set<string>
	): Promise<void> {
		const fullDir = relativeDir ? `${this.basePath}/${relativeDir}` : this.basePath;
		const normalizedDir = normalizePath(fullDir);
		const fileNames = await this.listFileNamesInVaultDir(normalizedDir);

		for (const name of fileNames) {
			if (!name.startsWith(".")) continue;
			const rel = relativeDir ? `${relativeDir}/${name}` : name;
			const full = normalizePath(`${normalizedDir}/${name}`);
			let stat: Awaited<ReturnType<typeof this.app.vault.adapter.stat>>;
			try {
				stat = await this.app.vault.adapter.stat(full);
			} catch {
				continue;
			}
			if (!stat || stat.type !== "file") continue;
			if (name.includes("_conflict_")) continue;
			const ext = extensionOfPath(name);
			if (!ext || !this.syncExtensions.includes(ext)) continue;
			const safeRel = sanitizeRelativePath(rel);
			if (seen.has(safeRel)) continue;
			seen.add(safeRel);
			entries.push({
				path: safeRel,
				name,
				mtime: stat.mtime,
				size: stat.size,
			});
		}
	}

	/** 补充 Vault 树里没有、但磁盘上存在的目录中的点文件 */
	private async collectDotFilesFromAdapter(
		relativeDir: string,
		entries: FileEntry[],
		seen: Set<string>
	): Promise<void> {
		await this.collectDotFilesInAdapterDir(relativeDir, entries, seen);

		const fullDir = relativeDir ? `${this.basePath}/${relativeDir}` : this.basePath;
		const normalizedDir = normalizePath(fullDir);
		let listed: { files: string[]; folders: string[] };
		try {
			listed = await this.app.vault.adapter.list(normalizedDir);
		} catch {
			return;
		}

		for (const name of listed.folders) {
			if (name.startsWith(".")) continue;
			const rel = relativeDir ? `${relativeDir}/${name}` : name;
			await this.collectDotFilesFromAdapter(rel, entries, seen);
		}
	}

	/** 将 Vault 绝对路径转为 syncFolder 相对路径；不在同步根下返回 null */
	toSyncRelativePath(vaultPath: string): string | null {
		const normalized = this.normalize(vaultPath);
		const root = this.app.vault.getRoot().path;
		const base = this.basePath === root ? "" : this.basePath;
		let relative: string | null;
		if (base) {
			if (normalized === base) relative = "";
			else if (!normalized.startsWith(`${base}/`)) relative = null;
			else relative = normalized.slice(base.length + 1);
		} else {
			relative = normalized;
		}
		return relative == null ? null : sanitizeRelativePath(relative);
	}

	/** 同 Vault 内重命名/移动文件，返回新路径 mtime */
	async renameFile(oldRelativePath: string, newRelativePath: string): Promise<number> {
		const oldFull = this.resolve(oldRelativePath);
		const newFull = this.resolve(newRelativePath);
		// 目标路径的中间目录可能仅存在于云端（本地从未创建）
		await this.ensureFolder(newFull);
		const file = this.app.vault.getAbstractFileByPath(oldFull);
		if (!(file instanceof Obsidian.TFile)) {
			throw new Error(`文件不存在: ${oldFull}`);
		}
		await this.app.fileManager.renameFile(file, newFull);
		const renamed = this.app.vault.getAbstractFileByPath(newFull);
		if (!(renamed instanceof Obsidian.TFile)) {
			throw new Error(`重命名后无法读取: ${newFull}`);
		}
		return renamed.stat.mtime;
	}

	/** 同 Vault 内重命名/移动文件夹（整棵子树） */
	async renameFolder(oldRelativePath: string, newRelativePath: string): Promise<void> {
		const oldFull = this.resolve(oldRelativePath);
		const newFull = this.resolve(newRelativePath);
		await this.ensureFolder(newFull);
		const folder = this.app.vault.getAbstractFileByPath(oldFull);
		if (!(folder instanceof Obsidian.TFolder)) {
			throw new Error(`目录不存在: ${oldFull}`);
		}
		await this.app.fileManager.renameFile(folder, newFull);
	}

	/** 判断相对路径对应目录是否存在 */
	async folderExists(relativePath: string): Promise<boolean> {
		const full = this.resolve(relativePath);
		const node = this.app.vault.getAbstractFileByPath(full);
		if (node instanceof Obsidian.TFolder) return true;
		try {
			const stat = await this.app.vault.adapter.stat(full);
			return stat?.type === "folder";
		} catch {
			return false;
		}
	}

	/** 读取文件内容 */
	async readFile(relativePath: string): Promise<string> {
		const fullPath = this.resolve(relativePath);
		if (isDotHiddenRelativePath(relativePath)) {
			if (!(await this.app.vault.adapter.exists(fullPath))) {
				throw new Error(`文件不存在: ${fullPath}`);
			}
			return this.app.vault.adapter.read(fullPath);
		}
		const file = this.app.vault.getAbstractFileByPath(fullPath);
		if (file instanceof Obsidian.TFile) {
			return this.app.vault.read(file);
		}
		if (await this.app.vault.adapter.exists(fullPath)) {
			return this.app.vault.adapter.read(fullPath);
		}
		throw new Error(`文件不存在: ${fullPath}`);
	}

	/** 写入文件（自动创建目录） */
	async writeFile(relativePath: string, content: string): Promise<number> {
		const fullPath = this.resolve(relativePath);
		await this.ensureFolder(fullPath);
		const adapter = this.app.vault.adapter;

		// 隐藏点文件：只用 adapter，不碰 vault.create（会返回 null / already exists）
		if (isDotHiddenRelativePath(relativePath)) {
			await adapter.write(fullPath, content);
			return this.mtimeFromPathAsync(fullPath);
		}

		const indexed = this.app.vault.getAbstractFileByPath(fullPath);
		if (indexed instanceof Obsidian.TFile) {
			await this.app.vault.modify(indexed, content);
			return indexed.stat.mtime;
		}

		if (await adapter.exists(fullPath)) {
			await adapter.write(fullPath, content);
			return this.mtimeFromPathAsync(fullPath);
		}

		const created = await this.app.vault.create(fullPath, content);
		if (created instanceof Obsidian.TFile) {
			return created.stat.mtime;
		}

		await adapter.write(fullPath, content);
		return this.mtimeFromPathAsync(fullPath);
	}

	/** 删除文件：优先 Obsidian 回收站；未编入 Vault 的文件移入 `.trash/` 而非永久删除 */
	async trashFile(relativePath: string): Promise<void> {
		const fullPath = this.resolve(relativePath);
		const file = this.app.vault.getAbstractFileByPath(fullPath);
		if (file instanceof Obsidian.TFile) {
			await this.app.fileManager.trashFile(file);
			return;
		}
		if (await this.app.vault.adapter.exists(fullPath)) {
			await this.trashAdapterFileToVaultTrash(fullPath, relativePath);
		}
	}

	/** 将 adapter 上的文件移入库根 `.trash/`（可恢复），避免 sync 误删时永久丢失 */
	private async trashAdapterFileToVaultTrash(fullPath: string, relativePath: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const trashRoot = normalizePath(`${this.app.vault.getRoot().path}/.trash`);
		if (!this.app.vault.getAbstractFileByPath(trashRoot)) {
			try {
				await this.app.vault.createFolder(trashRoot);
			} catch {
				// 已存在或非 Vault 索引
			}
		}
		const baseName = relativePath.split("/").pop() || "file";
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		let dest = normalizePath(`${trashRoot}/xgkb-sync-${stamp}-${baseName}`);
		for (let n = 0; n < 20 && (await adapter.exists(dest)); n++) {
			dest = normalizePath(`${trashRoot}/xgkb-sync-${stamp}-${n}-${baseName}`);
		}
		await adapter.rename(fullPath, dest);
	}

	/** 获取文件的 mtime */
	async getMtime(relativePath: string): Promise<number | null> {
		const mtime = await this.mtimeFromPathAsync(this.resolve(relativePath));
		return mtime > 0 ? mtime : null;
	}

	private async mtimeFromPathAsync(fullPath: string): Promise<number> {
		const normalized = normalizePath(fullPath);
		const indexed = this.app.vault.getAbstractFileByPath(normalized);
		if (indexed instanceof Obsidian.TFile) {
			return indexed.stat.mtime;
		}
		const stat = await this.app.vault.adapter.stat(normalized);
		return stat?.mtime ?? 0;
	}

	private resolve(relativePath: string): string {
		const safe = sanitizeRelativePath(relativePath.replace(/\\/g, "/").replace(/\/+/g, "/"));
		const root = this.app.vault.getRoot().path;
		const full = this.basePath === root ? safe : `${this.basePath}/${safe}`;
		return normalizePath(full);
	}

	private async ensureFolder(fullPath: string): Promise<void> {
		const parts = fullPath.split("/");
		if (parts.length <= 1) return;
		const folderParts = parts.slice(0, -1);
		let current = "";
		for (const part of folderParts) {
			current = current ? `${current}/${part}` : part;
			await this.ensureFolderSegment(normalizePath(current));
		}
	}

	private folderIndexed(normalized: string): boolean {
		const node = this.app.vault.getAbstractFileByPath(normalized);
		return node instanceof Obsidian.TFolder;
	}

	private async ensureFolderSegment(normalized: string): Promise<void> {
		if (this.folderIndexed(normalized)) return;

		let lock = this.folderEnsureLocks.get(normalized);
		if (!lock) {
			lock = this.createFolderSegment(normalized);
			this.folderEnsureLocks.set(normalized, lock);
			lock.finally(() => {
				if (this.folderEnsureLocks.get(normalized) === lock) {
					this.folderEnsureLocks.delete(normalized);
				}
			});
		}
		await lock;
	}

	private async createFolderSegment(normalized: string): Promise<void> {
		if (this.folderIndexed(normalized)) return;
		try {
			await this.app.vault.createFolder(normalized);
		} catch (e) {
			if (!this.isFolderAlreadyExistsError(e)) throw e;
			if (this.folderIndexed(normalized)) return;
			if (await this.app.vault.adapter.exists(normalized)) return;
			throw e;
		}
	}

	private isFolderAlreadyExistsError(e: unknown): boolean {
		const msg = e instanceof Error ? e.message : String(e);
		return /folder already exists/i.test(msg);
	}
}
