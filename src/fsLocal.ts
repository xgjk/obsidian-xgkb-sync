import type { App, TFile, TFolder } from "obsidian";
// 使用命名空间导入，避免 esbuild 误删对 obsidian 的运行时引用（instanceof 需要构造函数）
import * as Obsidian from "obsidian";
import type { FileEntry } from "./types";
import { sanitizePathSegment, sanitizeRelativePath } from "./pathSanitize";

/**
 * 本地文件系统操作（Vault API 封装）
 */
export class FsLocal {
	private basePath: string;

	constructor(private app: App, syncFolder: string) {
		this.basePath = syncFolder ? this.normalize(syncFolder) : app.vault.getRoot().path;
	}

	private normalize(p: string): string {
		// Obsidian normalizePath
		return p.replace(/\\/g, "/").replace(/\/+/g, "/");
	}

	/** 列出 syncFolder 下所有 .md 文件（递归） */
	async listFiles(): Promise<FileEntry[]> {
		const folder = this.app.vault.getAbstractFileByPath(this.basePath);
		if (!folder || !(folder instanceof Obsidian.TFolder)) return [];
		const entries: FileEntry[] = [];
		this.collectMd(folder, entries, "");
		return entries;
	}

	private collectMd(folder: TFolder, entries: FileEntry[], prefix: string): void {
		for (const child of folder.children) {
			if (child instanceof Obsidian.TFile) {
				if (child.extension === "md" && !child.name.includes("_conflict_")) {
					const seg = sanitizePathSegment(child.name);
					const relativePath = prefix ? `${prefix}/${seg}` : seg;
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
				// 跳过 .obsidian 和 .trash
				if (child.name.startsWith(".")) continue;
				this.collectMd(child, entries, subPrefix);
			}
		}
	}

	/** 读取文件内容 */
	async readFile(relativePath: string): Promise<string> {
		const fullPath = this.resolve(relativePath);
		const file = this.app.vault.getAbstractFileByPath(fullPath);
		if (!file || !(file instanceof Obsidian.TFile)) {
			throw new Error(`文件不存在: ${fullPath}`);
		}
		return this.app.vault.read(file);
	}

	/** 写入文件（自动创建目录） */
	async writeFile(relativePath: string, content: string): Promise<number> {
		const fullPath = this.resolve(relativePath);
		await this.ensureFolder(fullPath);
		const existing = this.app.vault.getAbstractFileByPath(fullPath);
		if (existing instanceof Obsidian.TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(fullPath, content);
		}
		// 返回实际 mtime
		const file = this.app.vault.getAbstractFileByPath(fullPath) as TFile;
		return file.stat.mtime;
	}

	/** 删除文件（走 Vault 回收站） */
	async trashFile(relativePath: string): Promise<void> {
		const fullPath = this.resolve(relativePath);
		const file = this.app.vault.getAbstractFileByPath(fullPath);
		if (file instanceof Obsidian.TFile) {
			// 尝试走回收站，不支持则直接删除
			try {
				await this.app.vault.trash(file, true);
			} catch {
				await this.app.vault.delete(file);
			}
		}
	}

	/** 获取文件的 mtime */
	getMtime(relativePath: string): number | null {
		const fullPath = this.resolve(relativePath);
		const file = this.app.vault.getAbstractFileByPath(fullPath);
		if (file instanceof Obsidian.TFile) return file.stat.mtime;
		return null;
	}

	private resolve(relativePath: string): string {
		const safe = sanitizeRelativePath(this.normalize(relativePath));
		const root = this.app.vault.getRoot().path;
		if (this.basePath === root) return safe;
		return `${this.basePath}/${safe}`;
	}

	private async ensureFolder(fullPath: string): Promise<void> {
		const parts = fullPath.split("/");
		if (parts.length <= 1) return;
		const folderParts = parts.slice(0, -1);
		let current = "";
		for (const part of folderParts) {
			current = current ? `${current}/${part}` : part;
			const normalized = this.normalize(current);
			if (!this.app.vault.getAbstractFileByPath(normalized)) {
				await this.app.vault.createFolder(normalized);
			}
		}
	}
}
