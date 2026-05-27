import { type App, PluginSettingTab, Notice, Setting } from "obsidian";
import type { XgkbPluginSettings } from "./types";
import type XgkbSyncPlugin from "./main";
import { DEFAULT_SETTINGS } from "./constants";
import { XgkbApi } from "./xgkbApi";
import { FsLocal } from "./fsLocal";
import { FsXgkb } from "./fsXgkb";
import { normalizeTargetFolderPath } from "./pathSanitize";
import {
	AVAILABLE_SYNC_EXTENSIONS,
	formatSyncExtensionsLabel,
	normalizeSyncExtensions,
} from "./syncFileTypes";

export class XgkbPluginSettingTab extends PluginSettingTab {
	private plugin: XgkbSyncPlugin;
	/** 作用域身份变更防抖，避免逐字输入时重复弹 Notice */
	private scopeIdentityTimer: number | undefined;

	constructor(app: App, plugin: XgkbSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		if (this.scopeIdentityTimer !== undefined) {
			window.clearTimeout(this.scopeIdentityTimer);
			this.scopeIdentityTimer = undefined;
		}

		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("App key")
			.setDesc("玄关知识库 API 密钥")
			.addText((text) => {
				text.setPlaceholder("Enter app key").setValue(this.plugin.settings.appKey);
				this.bindScopeIdentityText(text, (value) => {
					this.plugin.settings.appKey = value;
				});
			});

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("玄关知识库 API 地址")
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_SETTINGS.serverUrl)
					.setValue(this.plugin.settings.serverUrl);
				this.bindScopeIdentityText(text, (value) => {
					this.plugin.settings.serverUrl = value || DEFAULT_SETTINGS.serverUrl;
				});
			});

		new Setting(containerEl)
			.setName("Project ID")
			.setDesc("目标知识库空间 ID；留空则同步到个人知识库。切换空间将自动使用独立水位。")
			.addText((text) => {
				text
					.setPlaceholder("留空 = 个人知识库")
					.setValue(this.plugin.settings.projectId ?? "");
				this.bindScopeIdentityText(text, (value) => {
					this.plugin.settings.projectId = value.trim();
				});
			});

		new Setting(containerEl)
			.setName("Sync folder")
			.setDesc("Obsidian 中用于同步的文件夹路径（空 = 同步整个 vault）")
			.addText((text) => {
				text.setPlaceholder("Example: notes").setValue(this.plugin.settings.syncFolder);
				this.bindScopeIdentityText(text, (value) => {
					this.plugin.settings.syncFolder = value;
				});
			});

		new Setting(containerEl)
			.setName("Cloud target folder")
			.setDesc("知识库中的同步根目录；支持多级路径，如 Obsidian 或 A/B（不存在时自动创建）")
			.addText((text) => {
				text
					.setPlaceholder("Obsidian 或 A/B")
					.setValue(this.plugin.settings.targetFolderName);
				this.bindScopeIdentityText(text, (value) => {
					const normalized = normalizeTargetFolderPath(value);
					this.plugin.settings.targetFolderName = normalized || "Obsidian";
				});
			});

		const fileTypesWrap = containerEl.createDiv({ cls: "xgkb-sync-file-types" });
		new Setting(fileTypesWrap)
			.setName("Sync file types")
			.setDesc("选择要同步的文件类型（至少保留一种）");

		for (const ext of AVAILABLE_SYNC_EXTENSIONS) {
			const desc =
				ext === "md" ? "Markdown 笔记" : ext === "json" ? "JSON 配置/数据" : "HTML 页面";
			new Setting(fileTypesWrap)
				.setName(`.${ext}`)
				.setDesc(desc)
				.addToggle((toggle) => {
					const current = normalizeSyncExtensions(this.plugin.settings.syncFileExtensions);
					toggle.setValue(current.includes(ext));
					toggle.onChange(async (enabled) => {
						let next = [...normalizeSyncExtensions(this.plugin.settings.syncFileExtensions)];
						if (enabled) {
							if (!next.includes(ext)) next.push(ext);
						} else {
							next = next.filter((item) => item !== ext);
							if (next.length === 0) {
								new Notice("至少保留一种文件类型", 3000);
								toggle.setValue(true);
								return;
							}
						}
						this.plugin.settings.syncFileExtensions = normalizeSyncExtensions(next);
						await this.plugin.saveSettings();
					});
				});
		}

		new Setting(containerEl)
			.setName("Sync direction")
			.setDesc("双向同步 / 仅推送 / 仅拉取")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("bidirectional", "Bidirectional")
					.addOption("push", "Push only")
					.addOption("pull", "Pull only")
					.setValue(this.plugin.settings.syncDirection)
					.onChange(async (value) => {
						this.plugin.settings.syncDirection = value as XgkbPluginSettings["syncDirection"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Automatic sync interval")
			.setDesc("定期自动执行同步，关闭则仅手动触发")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("0",  "Off (manual sync)")
					.addOption("5",  "Every 5 minutes")
					.addOption("10", "Every 10 minutes")
					.addOption("30", "Every 30 minutes")
					.addOption("60", "Every hour")
					.addOption("120", "Every 2 hours")
					.setValue(String(this.plugin.settings.autoSyncInterval))
					.onChange(async (value) => {
						this.plugin.settings.autoSyncInterval = Number(value);
						await this.plugin.saveSettings();
						this.plugin.scheduleAutoSync();
					})
			);

		// 按钮组
		const btnGroup = containerEl.createDiv({ cls: "xgkb-settings-button-group" });

		const testBtn = btnGroup.createEl("button", { text: "Test connection", cls: "mod-cta" });
		testBtn.addEventListener("click", () => {
			void this.testConnection();
		});

		const debugBtn = btnGroup.createEl("button", { text: "Diagnostics" });
		debugBtn.addEventListener("click", () => {
			void this.debugSync();
		});

		const resetScopeBtn = btnGroup.createEl("button", { text: "Reset current scope" });
		resetScopeBtn.addEventListener("click", () => {
			void this.plugin.resetCurrentSyncScope();
		});

		const resetAllBtn = btnGroup.createEl("button", { text: "Reset all scopes" });
		resetAllBtn.addEventListener("click", () => {
			void this.plugin.resetAllSyncScopes();
		});
	}

	/** 文本类设置：防抖后再切换作用域并提示（失焦时立即提交） */
	private bindScopeIdentityText(
		text: import("obsidian").TextComponent,
		apply: (value: string) => void
	): void {
		const commitScope = () => {
			if (this.scopeIdentityTimer !== undefined) {
				window.clearTimeout(this.scopeIdentityTimer);
				this.scopeIdentityTimer = undefined;
			}
			void this.plugin.onScopeIdentityChanged();
		};

		text.onChange((value) => {
			apply(value);
			if (this.scopeIdentityTimer !== undefined) {
				window.clearTimeout(this.scopeIdentityTimer);
			}
			this.scopeIdentityTimer = window.setTimeout(commitScope, 600);
		});

		text.inputEl.addEventListener("blur", commitScope);
	}

	private async testConnection(): Promise<void> {
		const { appKey, serverUrl, targetFolderName, projectId } = this.plugin.settings;
		if (!appKey) {
			new Notice("Enter app key first");
			return;
		}

		new Notice("测试连接中...");
		const api = new XgkbApi(serverUrl, appKey);

		const projectIdResult = await api.resolveProjectId(projectId);
		if (!projectIdResult.ok) {
			new Notice(`❌ 连接失败: ${projectIdResult.error}`, 5000);
			return;
		}

		const resolvedId = projectIdResult.value;
		const spaceLabel = projectId?.trim() ? `空间 ${resolvedId}` : `个人知识库 (${resolvedId})`;

		const fsXgkb = new FsXgkb(
			api,
			targetFolderName,
			projectId,
			undefined,
			normalizeSyncExtensions(this.plugin.settings.syncFileExtensions)
		);
		const initResult = await fsXgkb.init();
		if (!initResult.ok) {
			new Notice(`❌ 目录解析失败: ${initResult.error}`, 8000);
			return;
		}

		const rootId = initResult.value;
		const displayPath = normalizeTargetFolderPath(targetFolderName) || "Obsidian";
		const filesResult = await api.getChildFiles(rootId);
		if (!filesResult.ok) {
			new Notice(`❌ 目录访问失败: ${filesResult.error}`, 5000);
			return;
		}

		const items = filesResult.value || [];
		const syncExtensions = normalizeSyncExtensions(this.plugin.settings.syncFileExtensions);
		const syncCount = items.filter(
			(f) => f.type === 2 && f.suffix && syncExtensions.includes(f.suffix.toLowerCase())
		).length;
		const folderCount = items.filter((f) => f.type === 1).length;
		const typesLabel = formatSyncExtensionsLabel(syncExtensions);
		new Notice(
			`✅ 连接成功（${spaceLabel}）！"${displayPath}" 含 ${syncCount} 个 ${typesLabel} 文件、${folderCount} 个子文件夹`,
			5000
		);
	}

	private async debugSync(): Promise<void> {
		const { appKey, serverUrl, targetFolderName, syncFolder, syncDirection, projectId } = this.plugin.settings;
		if (!appKey) {
			new Notice("Enter app key first");
			return;
		}

		new Notice("诊断中...");
		const api = new XgkbApi(serverUrl, appKey);
		const lines: string[] = [`=== XGKB Sync 诊断 ===\n`];
		lines.push(`同步方向: ${syncDirection}`);
		lines.push(`SyncFolder: "${syncFolder || "(整个Vault)"}"`);
		lines.push(`TargetFolder: "${targetFolderName}"`);
		lines.push(`ProjectId: "${projectId?.trim() || "(个人知识库)"}"`);
		for (const line of this.plugin.getScopeDiagnosticLines()) {
			lines.push(line);
		}
		lines.push("");

		try {
			const syncExtensions = normalizeSyncExtensions(this.plugin.settings.syncFileExtensions);
			const typesLabel = formatSyncExtensionsLabel(syncExtensions);
			const fsLocal = new FsLocal(this.plugin.app, syncFolder, syncExtensions);
			const fsXgkb = new FsXgkb(api, targetFolderName, projectId, undefined, syncExtensions);

			// 本地文件
			const localFiles = await fsLocal.listFiles();
			lines.push(`本地 ${typesLabel} 文件: ${localFiles.length} 个`);
			for (const f of localFiles.slice(0, 10)) {
				lines.push(`  📄 ${f.path}  (${new Date(f.mtime).toLocaleString()})`);
			}
			if (localFiles.length > 10) lines.push(`  ... 还有 ${localFiles.length - 10} 个`);

			// 云端文件
			const initResult = await fsXgkb.init();
			if (!initResult.ok) {
				lines.push(`\n❌ 云端初始化失败: ${initResult.error}`);
			} else {
				const remoteResult = await fsXgkb.listFiles();
				if (!remoteResult.ok) {
					lines.push(`\n❌ 获取云端文件失败: ${remoteResult.error}`);
				} else {
					const remoteFiles = remoteResult.value;
					lines.push(`\n云端 ${typesLabel} 文件: ${remoteFiles.length} 个`);
					for (const f of remoteFiles.slice(0, 10)) {
						lines.push(`  ☁️ ${f.path}  (${new Date(f.mtime).toLocaleString()})`);
					}
					if (remoteFiles.length > 10) lines.push(`  ... 还有 ${remoteFiles.length - 10} 个`);

					// 差异分析
					const localPaths = new Set(localFiles.map((f) => f.path));
					const remotePaths = new Set(remoteFiles.map((f) => f.path));
					const localOnly = [...localPaths].filter((p) => !remotePaths.has(p));
					const remoteOnly = [...remotePaths].filter((p) => !localPaths.has(p));
					const both = [...localPaths].filter((p) => remotePaths.has(p));

					lines.push(`\n=== 差异分析 ===`);
					lines.push(`仅本地: ${localOnly.length}  仅云端: ${remoteOnly.length}  两端都有: ${both.length}`);

					if (localOnly.length > 0) {
						lines.push(`\n将上传 (${localOnly.length}):`);
						for (const p of localOnly.slice(0, 10)) lines.push(`  ⬆ ${p}`);
					}
					if (remoteOnly.length > 0) {
						lines.push(`\n将下载 (${remoteOnly.length}):`);
						for (const p of remoteOnly.slice(0, 10)) lines.push(`  ⬇ ${p}`);
					}
				}
			}

			lines.push(`\n诊断完成。`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			lines.push(`\n诊断异常: ${message}`);
		}

		const fullText = lines.join("\n");
		console.debug(fullText);

		// 写入日志文件
		try {
			const logPath = ".xgkb-sync-debug.log";
			const existing = this.plugin.app.vault.getAbstractFileByPath(logPath);
			if (existing) await this.plugin.app.fileManager.trashFile(existing);
			await this.plugin.app.vault.create(logPath, fullText);
		} catch { /* ignore */ }

		new Notice("诊断完成，详情见控制台和 .xgkb-sync-debug.log", 5000);
	}
}
