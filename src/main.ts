import { Notice, Plugin, addIcon } from "obsidian";
import type { XgkbPluginSettings } from "./types";
import { DEFAULT_SETTINGS } from "./constants";
import { XgkbPluginSettingTab } from "./settings";
import { SyncEngine } from "./syncEngine";
import { SyncStateDb } from "./syncStateDb";
import { FsLocal } from "./fsLocal";
import { FsXgkb } from "./fsXgkb";
import { XgkbApi } from "./xgkbApi";

export default class XgkbSyncPlugin extends Plugin {
	settings: XgkbPluginSettings;

	async onload() {
		await this.loadSettings();

		// Ribbon 图标
		addIcon("sync-icon", SYNC_ICON_SVG, 0);
		this.addRibbonIcon("sync-icon", "XGKB 同步", async () => {
			await this.runSync();
		});

		// 命令面板
		this.addCommand({
			id: "xgkb-sync-now",
			name: "立即同步",
			callback: async () => {
				await this.runSync();
			},
		});

		// 设置面板
		this.addSettingTab(new XgkbPluginSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async runSync() {
		if (!this.settings.appKey) {
			new Notice("XGKB Sync: 请先在设置中配置 appKey");
			return;
		}

		new Notice("XGKB Sync: 开始同步...");
		const db = new SyncStateDb();
		let syncing = true;

		try {
			const dbResult = await db.open();
			if (!dbResult.ok) {
				new Notice(`XGKB Sync: 数据库打开失败 - ${dbResult.error}`);
				return;
			}

			const api = new XgkbApi(this.settings.serverUrl, this.settings.appKey);
			const fsLocal = new FsLocal(this.app, this.settings.syncFolder);
			const fsXgkb = new FsXgkb(api, this.settings.targetFolderName);
			const engine = new SyncEngine(fsLocal, fsXgkb, db, this.settings);

			const stats = await engine.runSync((msg) => {
				// 进度通知（静默更新）
			});

			syncing = false;

			// 结果通知
			const lines: string[] = [];
			if (stats.uploaded > 0) lines.push(`↑${stats.uploaded}`);
			if (stats.downloaded > 0) lines.push(`↓${stats.downloaded}`);
			if (stats.deleted > 0) lines.push(`✗${stats.deleted}`);
			if (stats.failed > 0) lines.push(`失败:${stats.failed}`);
			if (stats.skipped > 0) lines.push(`跳过:${stats.skipped}`);

			const summary = lines.length > 0 ? lines.join(" ") : "无变化";
			new Notice(`XGKB Sync 完成: ${summary}`, stats.failed > 0 ? 8000 : 4000);

			// 如果有错误，打印到控制台
			if (stats.errors.length > 0) {
				console.error("[XGKB Sync] 同步错误:", stats.errors);
				new Notice(`XGKB Sync: ${stats.errors.length} 个文件同步失败，请查看控制台`, 8000);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[XGKB Sync] 同步异常:", msg);
			new Notice(`XGKB Sync 同步失败: ${msg}`, 8000);
		} finally {
			if (syncing) db.close();
		}
	}
}

const SYNC_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`;
