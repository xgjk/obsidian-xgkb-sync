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
			this.collectFromVaultTree(folder, entries, "", seen);
		}
		await this.collectDotFilesFromAdapter("", entries, seen);
		return entries;
	}

	private collectFromVaultTree(
		folder: TFolder,
		entries: FileEntry[],
		prefix: string,
		seen: Set<string>
	): void {
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
				this.collectFromVaultTree(child, entries, subPrefix, seen);
			}
		}
	}

	/** 补充 Vault 树里没有、但磁盘上存在的 `.xxx` 文件（adapter 写入的 orphan） */
	private async collectDotFilesFromAdapter(
		relativeDir: string,
		entries: FileEntry[],
		seen: Set<string>
	): Promise<void> {
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

		for (const name of listed.files) {
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

	/** 删除文件（走 Vault 回收站；隐藏点文件走 adapter.remove） */
	async trashFile(relativePath: string): Promise<void> {
		const fullPath = this.resolve(relativePath);
		if (isDotHiddenRelativePath(relativePath)) {
			if (await this.app.vault.adapter.exists(fullPath)) {
				await this.app.vault.adapter.remove(fullPath);
			}
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(fullPath);
		if (file instanceof Obsidian.TFile) {
			await this.app.fileManager.trashFile(file);
			return;
		}
		if (await this.app.vault.adapter.exists(fullPath)) {
			await this.app.vault.adapter.remove(fullPath);
		}
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
