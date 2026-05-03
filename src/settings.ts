import { type App, PluginSettingTab, Notice, Setting } from "obsidian";
import type { XgkbPluginSettings } from "./types";
import type XgkbSyncPlugin from "./main";
import { DEFAULT_SETTINGS } from "./constants";
import { XgkbApi } from "./xgkbApi";
import { FsLocal } from "./fsLocal";
import { FsXgkb } from "./fsXgkb";

export class XgkbPluginSettingTab extends PluginSettingTab {
	private plugin: XgkbSyncPlugin;

	constructor(app: App, plugin: XgkbSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "XGKB Sync 设置" });

		new Setting(containerEl)
			.setName("AppKey")
			.setDesc("玄关知识库 API 密钥")
			.addText((text) =>
				text
					.setPlaceholder("输入 appKey")
					.setValue(this.plugin.settings.appKey)
					.onChange(async (value) => {
						this.plugin.settings.appKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("玄关知识库 API 地址")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.serverUrl)
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value || DEFAULT_SETTINGS.serverUrl;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("同步文件夹")
			.setDesc("Obsidian 中用于同步的文件夹路径（空 = 同步整个 Vault）")
			.addText((text) =>
				text
					.setPlaceholder("如：Notes")
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("云端目标目录")
			.setDesc("玄关知识库中目标文件夹名称")
			.addText((text) =>
				text
					.setPlaceholder("Obsidian")
					.setValue(this.plugin.settings.targetFolderName)
					.onChange(async (value) => {
						this.plugin.settings.targetFolderName = value || "Obsidian";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("同步方向")
			.setDesc("双向同步 / 仅推送 / 仅拉取")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("bidirectional", "双向 (Bidirectional)")
					.addOption("push", "仅推送 (Push)")
					.addOption("pull", "仅拉取 (Pull)")
					.setValue(this.plugin.settings.syncDirection)
					.onChange(async (value) => {
						this.plugin.settings.syncDirection = value as XgkbPluginSettings["syncDirection"];
						await this.plugin.saveSettings();
					})
			);

		// 按钮组
		const btnGroup = containerEl.createDiv({ cls: "xgkb-settings-button-group" });
		btnGroup.style.display = "flex";
		btnGroup.style.gap = "8px";
		btnGroup.style.marginTop = "16px";

		const testBtn = btnGroup.createEl("button", { text: "测试连接", cls: "mod-cta" });
		testBtn.addEventListener("click", async () => {
			await this.testConnection();
		});

		const debugBtn = btnGroup.createEl("button", { text: "🔍 诊断" });
		debugBtn.addEventListener("click", async () => {
			await this.debugSync();
		});
	}

	private async testConnection(): Promise<void> {
		const { appKey, serverUrl, targetFolderName } = this.plugin.settings;
		if (!appKey) {
			new Notice("请先输入 AppKey");
			return;
		}

		new Notice("测试连接中...");
		const api = new XgkbApi(serverUrl, appKey);

		const projectIdResult = await api.getPersonalProjectId();
		if (!projectIdResult.ok) {
			new Notice(`❌ 连接失败: ${projectIdResult.error}`, 5000);
			return;
		}

		const foldersResult = await api.getLevel1Folders(projectIdResult.value);
		if (!foldersResult.ok) {
			new Notice(`❌ 获取目录失败: ${foldersResult.error}`, 5000);
			return;
		}

		const folders = foldersResult.value || [];
		const target = folders.find((f) => f.name === targetFolderName && f.type === 1);

		if (!target) {
			const names = folders.map((f) => f.name).join(", ");
			new Notice(`❌ 目录 "${targetFolderName}" 不存在。现有: ${names || "(空)"}`, 8000);
			return;
		}

		const filesResult = await api.getChildFiles(target.id);
		if (!filesResult.ok) {
			new Notice(`❌ 目录访问失败: ${filesResult.error}`, 5000);
			return;
		}

		const items = filesResult.value || [];
		const mdCount = items.filter((f) => f.type === 2 && f.suffix === "md").length;
		const folderCount = items.filter((f) => f.type === 1).length;
		new Notice(`✅ 连接成功！"${targetFolderName}" 含 ${mdCount} 个 .md 文件、${folderCount} 个子文件夹`, 5000);
	}

	private async debugSync(): Promise<void> {
		const { appKey, serverUrl, targetFolderName, syncFolder, syncDirection } = this.plugin.settings;
		if (!appKey) {
			new Notice("请先输入 AppKey");
			return;
		}

		new Notice("诊断中...");
		const api = new XgkbApi(serverUrl, appKey);
		const lines: string[] = [`=== XGKB Sync 诊断 ===\n`];
		lines.push(`同步方向: ${syncDirection}`);
		lines.push(`SyncFolder: "${syncFolder || "(整个Vault)"}"`);
		lines.push(`TargetFolder: "${targetFolderName}"\n`);

		try {
			const fsLocal = new FsLocal(this.plugin.app, syncFolder);
			const fsXgkb = new FsXgkb(api, targetFolderName);

			// 本地文件
			const localFiles = await fsLocal.listFiles();
			lines.push(`本地 .md 文件: ${localFiles.length} 个`);
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
					lines.push(`\n云端 .md 文件: ${remoteFiles.length} 个`);
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
			lines.push(`\n诊断异常: ${e}`);
		}

		const fullText = lines.join("\n");
		console.log(fullText);

		// 写入日志文件
		try {
			const logPath = ".xgkb-sync-debug.log";
			const existing = this.plugin.app.vault.getAbstractFileByPath(logPath);
			if (existing) await this.plugin.app.vault.delete(existing);
			await this.plugin.app.vault.create(logPath, fullText);
		} catch { /* ignore */ }

		new Notice("诊断完成，详情见控制台和 .xgkb-sync-debug.log", 5000);
	}
}
