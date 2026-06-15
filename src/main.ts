import { Notice, Plugin } from "obsidian";
import * as Obsidian from "obsidian";
import type { XgkbPluginSettings, SyncScopeEntry } from "./types";
import { DEFAULT_SETTINGS } from "./constants";
import { XgkbPluginSettingTab } from "./settings";
import { SyncEngine } from "./syncEngine";
import { SyncStateDb } from "./syncStateDb";
import { FsLocal } from "./fsLocal";
import { FsXgkb } from "./fsXgkb";
import { XgkbApi } from "./xgkbApi";
import {
	DATA_SCHEMA_VERSION,
	computeScopeKey,
	buildScopeFingerprint,
	isLegacyPersistedData,
	formatScopeLabel,
} from "./syncScope";
import { normalizeSyncExtensions } from "./syncFileTypes";
import { SyncProgressNotice } from "./syncProgressNotice";

function stripPersistedMeta(raw: Record<string, unknown>): Partial<XgkbPluginSettings> {
	const rest = { ...raw };
	delete rest.lastSyncTime;
	delete rest.dataSchemaVersion;
	delete rest.activeScopeKey;
	delete rest.syncScopes;
	return rest;
}

export default class XgkbSyncPlugin extends Plugin {
	settings!: XgkbPluginSettings;

	dataSchemaVersion = DATA_SCHEMA_VERSION;
	activeScopeKey = "";
	syncScopes: Record<string, SyncScopeEntry> = {};

	/** 自动同步定时器句柄（window.setInterval 返回值） */
	private autoSyncHandle: number | undefined;

	/** 防止并发执行多次同步 */
	private isSyncing = false;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("refresh-cw", "Sync xgkb", async () => {
			await this.runSync();
		});

		this.addCommand({
			id: "xgkb-sync-now",
			name: "Sync now",
			callback: async () => {
				await this.runSync();
			},
		});

		this.registerVaultRenameHandler();

		this.addSettingTab(new XgkbPluginSettingTab(this.app, this));

		this.scheduleAutoSync();
	}

	private registerVaultRenameHandler(): void {
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				void this.onVaultRename(file, oldPath);
			})
		);
	}

	/** 本地 rename 时迁键 IndexedDB，避免下轮误判 upload-new（pull 模式也需迁键，不调远端 API） */
	private async onVaultRename(file: Obsidian.TAbstractFile, oldPath: string): Promise<void> {
		const exts = normalizeSyncExtensions(this.settings.syncFileExtensions);
		const fsLocal = new FsLocal(this.app, this.settings.syncFolder, exts);
		const oldRel = fsLocal.toSyncRelativePath(oldPath);
		const newRel = fsLocal.toSyncRelativePath(file.path);

		const scopeKey = await computeScopeKey(this.settings);
		const db = new SyncStateDb();
		try {
			const openResult = await db.open();
			if (!openResult.ok) return;

			// 移出 sync 根：清理 IDB，避免幽灵 record
			if (oldRel != null && newRel == null) {
				if (file instanceof Obsidian.TFolder) {
					const removed = await db.deleteRecordsByPrefix(scopeKey, oldRel);
					if (removed > 0) {
						console.debug(
							`[XGKB Sync] Vault 文件夹移出 sync 根: ${oldRel}（已清除 ${removed} 条状态）`
						);
					}
				} else if (file instanceof Obsidian.TFile && exts.includes(file.extension)) {
					await db.delete(scopeKey, oldRel);
					console.debug(`[XGKB Sync] Vault 文件移出 sync 根: ${oldRel}（已清除状态）`);
				}
				return;
			}

			if (oldRel == null || newRel == null || oldRel === newRel) return;

			if (file instanceof Obsidian.TFolder) {
				const moved = await db.relocateRecordsByPrefix(scopeKey, oldRel, newRel);
				if (moved > 0) {
					console.debug(
						`[XGKB Sync] Vault 文件夹 rename: ${oldRel} → ${newRel}（已更新 ${moved} 条状态）`
					);
				}
				// push/bidirectional：为子文件标记待推送远端动作，与文件级 rename 对称，
				// 否则增量模式下目录移动会被本地状态掩盖（云端不动，残留空目录）。
				if (this.settings.syncDirection !== "pull") {
					const marked = await db.markPendingRemoteRenameByPrefix(scopeKey, oldRel, newRel);
					if (marked > 0) {
						console.debug(
							`[XGKB Sync] Vault 文件夹 rename: 已标记 ${marked} 条待推送远端 rename/move`
						);
					}
				}
				return;
			}

			if (!(file instanceof Obsidian.TFile)) return;
			if (!exts.includes(file.extension)) return;

			const moved = await db.relocateRecord(scopeKey, oldRel, newRel);
			if (moved) {
				// push/bidirectional：记录待推送远端动作，避免被增量路径推导“提前对齐”短路。
				if (this.settings.syncDirection !== "pull") {
					await db.markPendingRemoteRenameOrMove(scopeKey, newRel, oldRel, newRel);
				}
				console.debug(`[XGKB Sync] Vault rename: ${oldRel} → ${newRel}（已更新状态库）`);
			}
		} finally {
			db.close();
		}
	}

	scheduleAutoSync(): void {
		if (this.autoSyncHandle !== undefined) {
			window.clearInterval(this.autoSyncHandle);
			this.autoSyncHandle = undefined;
		}

		const intervalMin = this.settings.autoSyncInterval ?? 0;
		if (intervalMin <= 0) return;

		const intervalMs = intervalMin * 60 * 1000;
		this.autoSyncHandle = this.registerInterval(
			window.setInterval(() => {
				void this.runSync({ quietIfBusy: true });
			}, intervalMs)
		);
		console.debug(`[XGKB Sync] 自动同步已启动，间隔 ${intervalMin} 分钟`);
	}

	async loadSettings() {
		const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;

		if (isLegacyPersistedData(raw)) {
			await this.migrateToSchemaV2(raw);
			return;
		}

		const { dataSchemaVersion, activeScopeKey, syncScopes, ...rest } = raw;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stripPersistedMeta(rest));
		this.settings.syncFileExtensions = normalizeSyncExtensions(this.settings.syncFileExtensions);
		this.dataSchemaVersion =
			typeof dataSchemaVersion === "number" ? dataSchemaVersion : DATA_SCHEMA_VERSION;
		this.syncScopes =
			syncScopes && typeof syncScopes === "object"
				? (syncScopes as Record<string, SyncScopeEntry>)
				: {};
		this.activeScopeKey =
			typeof activeScopeKey === "string"
				? activeScopeKey
				: await computeScopeKey(this.settings);
	}

	private async migrateToSchemaV2(raw: Record<string, unknown>): Promise<void> {
		const db = new SyncStateDb();
		const dbResult = await db.open();
		if (dbResult.ok) await db.clear();
		db.close();

		this.settings = Object.assign({}, DEFAULT_SETTINGS, stripPersistedMeta(raw));
		this.settings.syncFileExtensions = normalizeSyncExtensions(this.settings.syncFileExtensions);
		const scopeKey = await computeScopeKey(this.settings);
		this.dataSchemaVersion = DATA_SCHEMA_VERSION;
		this.syncScopes = {
			[scopeKey]: { fingerprint: buildScopeFingerprint(this.settings) },
		};
		this.activeScopeKey = scopeKey;
		await this.saveSettings();
		new Notice(
			"已升级到多作用域同步：旧水位未迁移，下次将执行全量对账",
			8000
		);
	}

	async saveSettings() {
		await this.saveData({
			...this.settings,
			dataSchemaVersion: this.dataSchemaVersion,
			activeScopeKey: this.activeScopeKey,
			syncScopes: this.syncScopes,
		});
	}

	/** 身份相关设置变更后更新作用域并提示 */
	async onScopeIdentityChanged(): Promise<void> {
		const newKey = await computeScopeKey(this.settings);
		const prevKey = this.activeScopeKey;
		this.activeScopeKey = newKey;

		if (newKey === prevKey) {
			await this.saveSettings();
			return;
		}

		if (!this.syncScopes[newKey]) {
			this.syncScopes[newKey] = { fingerprint: buildScopeFingerprint(this.settings) };
			new Notice("新的同步目标，首次将执行全量对账", 6000);
		} else {
			const entry = this.syncScopes[newKey];
			const when = entry.lastSuccessAt
				? new Date(entry.lastSuccessAt).toLocaleString("zh-CN")
				: "未知";
			new Notice(
				`已切换到此前使用过的同步目标（上次成功: ${when}），将沿用该目标的水位`,
				6000
			);
		}

		await this.saveSettings();
	}

	async resetCurrentSyncScope(): Promise<void> {
		const key = await computeScopeKey(this.settings);
		delete this.syncScopes[key];
		this.activeScopeKey = key;

		const db = new SyncStateDb();
		const dbResult = await db.open();
		if (dbResult.ok) await db.deleteAllForScope(key);
		db.close();

		await this.saveSettings();
		new Notice("已重置当前同步作用域，下次将全量对账", 6000);
	}

	async resetAllSyncScopes(): Promise<void> {
		this.syncScopes = {};
		this.activeScopeKey = await computeScopeKey(this.settings);
		this.syncScopes[this.activeScopeKey] = {
			fingerprint: buildScopeFingerprint(this.settings),
		};

		const db = new SyncStateDb();
		const dbResult = await db.open();
		if (dbResult.ok) await db.clear();
		db.close();

		await this.saveSettings();
		new Notice("已重置全部同步作用域，下次将全量对账", 6000);
	}

	getScopeDiagnosticLines(): string[] {
		const entry = this.syncScopes[this.activeScopeKey];
		const fp = entry?.fingerprint ?? buildScopeFingerprint(this.settings);
		const lines: string[] = [];
		lines.push(`activeScopeKey: ${this.activeScopeKey.slice(0, 16)}...`);
		lines.push(`scope: ${formatScopeLabel(fp)}`);
		if (entry?.lastSyncTime != null) {
			lines.push(
				`lastSyncTime: ${new Date(entry.lastSyncTime).toLocaleString("zh-CN")} (本作用域)`
			);
		} else {
			lines.push("lastSyncTime: (无，下次全量)");
		}
		const labels = Object.values(this.syncScopes)
			.map((e) => e.fingerprint?.targetFolderName)
			.filter(Boolean) as string[];
		const unique = [...new Set(labels)];
		lines.push(`knownScopes: ${Object.keys(this.syncScopes).length} 个（${unique.join(", ") || "—"}）`);
		return lines;
	}

	private async runSync(options?: { quietIfBusy?: boolean }) {
		if (!this.settings.appKey) {
			new Notice("Xgkb sync: configure app key first");
			return;
		}

		if (this.isSyncing) {
			console.debug("[XGKB Sync] 上次同步仍在进行，跳过本次触发");
			if (!options?.quietIfBusy) {
				new Notice("Xgkb sync: 同步进行中，请勿重复点击", 5000);
			}
			return;
		}
		this.isSyncing = true;

		const progressNotice = new SyncProgressNotice();

		const scopeKey = await computeScopeKey(this.settings);
		this.activeScopeKey = scopeKey;
		if (!this.syncScopes[scopeKey]) {
			this.syncScopes[scopeKey] = { fingerprint: buildScopeFingerprint(this.settings) };
		}

		const since = this.syncScopes[scopeKey]?.lastSyncTime;
		const isIncremental = since !== undefined;
		const sinceStr = since
			? new Date(since).toLocaleString("zh-CN")
			: "无（首次全量）";
		console.debug(
			`[XGKB Sync] ===== 开始同步 scope=${scopeKey.slice(0, 8)}... mode=${isIncremental ? "增量" : "全量"} lastSyncTime=${since ?? "-"} (${sinceStr}) =====`
		);
		progressNotice.update(`开始${isIncremental ? "增量" : "全量"}同步...`);
		const db = new SyncStateDb();
		let dbOpened = false;

		try {
			const dbResult = await db.open();
			if (!dbResult.ok) {
				progressNotice.finish(`数据库打开失败 - ${dbResult.error}`, 8000);
				return;
			}
			dbOpened = true;

			const api = new XgkbApi(this.settings.serverUrl, this.settings.appKey);
			const syncExtensions = normalizeSyncExtensions(this.settings.syncFileExtensions);
			const fsLocal = new FsLocal(this.app, this.settings.syncFolder, syncExtensions);
			const fsXgkb = new FsXgkb(
				api,
				this.settings.targetFolderName,
				this.settings.projectId,
				{
					usePhysicalUpload: this.settings.usePhysicalUpload !== false,
					uploadContentFallback: this.settings.uploadContentFallback !== false,
				},
				syncExtensions
			);
			const engine = new SyncEngine(fsLocal, fsXgkb, db, this.settings, scopeKey);

			let lastProgressUpdate = 0;
			const stats = await engine.runSync((msg) => {
				const now = Date.now();
				if (
					(msg.startsWith("下载进度") || msg.startsWith("上传进度")) &&
					now - lastProgressUpdate < 8000
				) {
					return;
				}
				lastProgressUpdate = now;
				progressNotice.update(msg);
			}, since);

			if (stats.newSince) {
				const rootId = fsXgkb.getRootId();
				this.syncScopes[scopeKey] = {
					...this.syncScopes[scopeKey],
					lastSyncTime: stats.newSince,
					rootFileId: rootId ?? undefined,
					lastSuccessAt: Date.now(),
					fingerprint: buildScopeFingerprint(this.settings),
				};
				await this.saveSettings();
				console.debug(
					`[XGKB Sync] 作用域水位已更新: ${stats.newSince} (${new Date(stats.newSince).toLocaleString("zh-CN")})`
				);
			}

			const lines: string[] = [];
			if (stats.uploaded > 0) lines.push(`↑${stats.uploaded}`);
			if (stats.downloaded > 0) lines.push(`↓${stats.downloaded}`);
			if (stats.deleted > 0) lines.push(`✗${stats.deleted}`);
			if (stats.failed > 0) lines.push(`失败:${stats.failed}`);
			if (stats.skipped > 0) lines.push(`跳过:${stats.skipped}`);

			const summary = lines.length > 0 ? lines.join(" ") : "无变化";
			let finishMsg = `完成: ${summary}`;
			if (stats.errors.length > 0) {
				console.error("[XGKB Sync] 同步错误:", stats.errors);
				finishMsg += `（${stats.errors.length} 个失败，下次重试）`;
			}
			progressNotice.finish(finishMsg, stats.failed > 0 ? 8000 : 4000);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[XGKB Sync] 同步异常:", msg);
			progressNotice.finish(`同步失败: ${msg}`, 8000);
		} finally {
			if (dbOpened) db.close();
			this.isSyncing = false;
		}
	}
}
