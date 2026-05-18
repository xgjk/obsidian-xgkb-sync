import { Notice, Plugin } from "obsidian";
import type { XgkbPluginSettings } from "./types";
import { DEFAULT_SETTINGS } from "./constants";
import { XgkbPluginSettingTab } from "./settings";
import { SyncEngine } from "./syncEngine";
import { SyncStateDb } from "./syncStateDb";
import { FsLocal } from "./fsLocal";
import { FsXgkb } from "./fsXgkb";
import { XgkbApi } from "./xgkbApi";

export default class XgkbSyncPlugin extends Plugin {
	settings!: XgkbPluginSettings;

	/** 上次同步成功后的水位时间戳（毫秒），持久化到 data.json */
	private lastSyncTime: number | undefined;

	/** 自动同步定时器句柄（window.setInterval 返回值） */
	private autoSyncHandle: number | undefined;

	/** 防止并发执行多次同步 */
	private isSyncing = false;

	async onload() {
		await this.loadSettings();

		// Ribbon 图标（使用 Obsidian 内置 Lucide 图标 refresh-cw）
		this.addRibbonIcon("refresh-cw", "Sync xgkb", async () => {
			await this.runSync();
		});

		// 命令面板
		this.addCommand({
			id: "xgkb-sync-now",
			name: "Sync now",
			callback: async () => {
				await this.runSync();
			},
		});

		// 设置面板
		this.addSettingTab(new XgkbPluginSettingTab(this.app, this));

		// 启动自动同步定时器
		this.scheduleAutoSync();
	}

	/**
	 * 注册/重置自动同步定时器。
	 * 设置页修改间隔时调用，或插件加载时调用。
	 * 使用 Plugin.registerInterval 确保插件卸载时自动清理。
	 */
	scheduleAutoSync(): void {
		// 清除旧定时器
		if (this.autoSyncHandle !== undefined) {
			window.clearInterval(this.autoSyncHandle);
			this.autoSyncHandle = undefined;
		}

		const intervalMin = this.settings.autoSyncInterval ?? 0;
		if (intervalMin <= 0) return;

		const intervalMs = intervalMin * 60 * 1000;
		// registerInterval 会在插件卸载时自动 clearInterval
		this.autoSyncHandle = this.registerInterval(
			window.setInterval(() => {
				void this.runSync();
			}, intervalMs)
		);
		console.debug(`[XGKB Sync] 自动同步已启动，间隔 ${intervalMin} 分钟`);
	}

	async loadSettings() {
		const raw: unknown = (await this.loadData()) ?? {};
		// lastSyncTime 是运行状态，不放入 XgkbPluginSettings 接口，单独提取
		const { lastSyncTime, ...rest } = raw as Record<string, unknown>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, rest);
		this.lastSyncTime = typeof lastSyncTime === "number" ? lastSyncTime : undefined;
	}

	async saveSettings() {
		// settings 与 lastSyncTime 合并保存到同一份 data.json
		await this.saveData({ ...this.settings, lastSyncTime: this.lastSyncTime });
	}

	private async runSync() {
		if (!this.settings.appKey) {
			new Notice("Xgkb sync: configure app key first");
			return;
		}

		// 防止并发：上一次同步尚未完成时跳过本次触发
		if (this.isSyncing) {
			console.debug("[XGKB Sync] 上次同步仍在进行，跳过本次触发");
			return;
		}
		this.isSyncing = true;

		const isIncremental = this.lastSyncTime !== undefined;
		const sinceStr = this.lastSyncTime
			? new Date(this.lastSyncTime).toLocaleString("zh-CN")
			: "无（首次全量）";
		console.debug(`[XGKB Sync] ===== 开始同步 mode=${isIncremental ? "增量" : "全量"} lastSyncTime=${this.lastSyncTime ?? "-"} (${sinceStr}) =====`);
		new Notice(`XGKB Sync: 开始${isIncremental ? "增量" : "全量"}同步...`);
		const db = new SyncStateDb();
		let dbOpened = false;

		try {
			const dbResult = await db.open();
			if (!dbResult.ok) {
				new Notice(`XGKB Sync: 数据库打开失败 - ${dbResult.error}`);
				return;
			}
			dbOpened = true;

			const api = new XgkbApi(this.settings.serverUrl, this.settings.appKey);
			const fsLocal = new FsLocal(this.app, this.settings.syncFolder);
			const fsXgkb = new FsXgkb(api, this.settings.targetFolderName, this.settings.projectId);
			const engine = new SyncEngine(fsLocal, fsXgkb, db, this.settings);

			const stats = await engine.runSync(undefined, this.lastSyncTime);

			// 同步成功后更新水位
			if (stats.newSince) {
				this.lastSyncTime = stats.newSince;
				await this.saveSettings();
				console.debug(`[XGKB Sync] 水位已更新: ${stats.newSince} (${new Date(stats.newSince).toLocaleString("zh-CN")})`);
			}

			// 结果通知
			const lines: string[] = [];
			if (stats.uploaded > 0) lines.push(`↑${stats.uploaded}`);
			if (stats.downloaded > 0) lines.push(`↓${stats.downloaded}`);
			if (stats.deleted > 0) lines.push(`✗${stats.deleted}`);
			if (stats.failed > 0) lines.push(`失败:${stats.failed}`);
			if (stats.skipped > 0) lines.push(`跳过:${stats.skipped}`);

			const summary = lines.length > 0 ? lines.join(" ") : "无变化";
			new Notice(`XGKB Sync 完成: ${summary}`, stats.failed > 0 ? 8000 : 4000);

			if (stats.errors.length > 0) {
				console.error("[XGKB Sync] 同步错误:", stats.errors);
				new Notice(`XGKB Sync: ${stats.errors.length} 个文件同步失败，请查看控制台`, 8000);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[XGKB Sync] 同步异常:", msg);
			new Notice(`XGKB Sync 同步失败: ${msg}`, 8000);
			// 同步失败不更新水位，下次仍用旧水位（或全量）重试
		} finally {
			if (dbOpened) db.close();
			this.isSyncing = false;
		}
	}
}

