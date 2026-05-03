# RT-001 v3.0: Obsidian 玄关知识库双向同步插件 MVP

> **基于 2026-05-03 API 全面实测验证更新**
> 
> 关键变更：文件更新不再使用 `updateFileVersion`，改用 `uploadContent(updateFileId)` 模式。
> 读取最新内容使用 `getDownloadInfo → downloadUrl`，而非 `getFullFileContent`（有 10s 缓存延迟）。

---

## §1 核心同步规则

### 1.1 同步模型：Last-Write-Wins (LWW)

**以 mtime（文件修改时间）为唯一基准**

- 本地 mtime 最新 → 上传覆盖云端
- 云端 mtime 最新 → 下载覆盖本地
- 两端同时修改 → 以最新 mtime 为准，较旧的一方被覆盖
- **不保留冲突副本，直接覆盖**

### 1.2 同步范围

| 条件 | 处理 |
|------|------|
| 扩展名 `.md` | ✅ 同步 |
| 文件名包含 `_conflict_` | ❌ 忽略（冲突产物） |
| 其他扩展名（图片、附件等） | ❌ 忽略 |
| 云端 `type !== 2` 或 `suffix !== "md"` | ❌ 忽略 |

### 1.3 目录结构映射

```
Obsidian Vault                    玄关知识库
─────────────────                 ──────────────────
syncFolder/                       个人空间/
├── 日常学习/                      ├── 日常学习/
│   └── 笔记.md          ←→       │   └── 笔记.md
└── 投资/                         └── 投资/
    └── 分析.md          ←→           └── 分析.md
```

- **云端根目录**：个人空间下的 `Obsidian` 文件夹（`folderId` 由初始化获取）
- **路径一一对应**：本地 `syncFolder/日常学习/笔记.md` ↔ 云端 `Obsidian/日常学习/笔记.md`
- **上传时自动创建子目录**：通过 `uploadContent` 的 `folderName` 传嵌套路径

### 1.4 多设备支持

- 一个云端（XGKB），多个本地客户端（Mac/iPhone/iPad 通过 iCloud 共享同一 Vault）
- 以云端 mtime 为权威时间，各设备时钟差异不影响判断

---

## §2 XGKB API 接口映射

### 2.1 接口使用策略

基于 2026-05-03 实测验证，确定以下接口使用策略：

| 同步操作 | 使用接口 | 说明 |
|---------|---------|------|
| **新建文件** | `uploadContent` (无 updateFileId) | 传 folderName 自动创建目录 | **官方推荐** |
| **更新文件** | `uploadContent` (传 updateFileId) | v1.13 新增，轻量级高速通道 | **官方推荐** |
| **读取文件内容** | `getFullFileContent` | 所写即所读，双写缓存已跑通 | **官方推荐** |
| **浏览目录** | `getChildFiles(parentId)` | 递归遍历 | |
| **搜索文件** | `searchFile(nameKey)` | 按名称搜索 | |
| **删除文件** | `deleteFile(fileId)` | 逻辑删除 | |
| **获取根目录** | `getLevel1Folders(projectId)` | 找 Obsidian 文件夹 | |
| **获取个人空间 ID** | `getPersonalProjectId` | 一次性获取 | |

### 2.2 不使用的接口及原因

| 接口 | 原因 |
|------|------|
| `batchGetContent` | 返回 `no permission`（无权限） |
| `saveFileByParentId` | 同名文件报错（不幂等），`uploadContent` 更适合纯文本 |
| `saveFileByPath` | 同上 |
| `updateFileVersion` (4.25) | 底层重型 resourceId 物理分片逻辑，纯文本不需要。改用轻量级 `uploadContent(updateFileId)` |
| `getDownloadInfo` → downloadUrl | 同步场景不需要绕路下载，直接用 `getFullFileContent` 所写即所读 |

### 2.3 关键 API 参数

**uploadContent 新建模式：**
```json
{
  "content": "# Markdown content",
  "fileName": "笔记.md",
  "fileSuffix": "md",
  "folderName": "Obsidian/日常学习"
}
```

**uploadContent 更新模式：**
```json
{
  "updateFileId": "2050924928689090562",
  "content": "# Updated content",
  "fileName": "笔记.md",
  "fileSuffix": "md",
  "versionRemark": "sync update"
}
```

**getDownloadInfo 读取最新内容：**
```bash
# 1. 获取下载凭据
GET /document-database/file/getDownloadInfo?fileId={id}
# → data.downloadUrl (签名 URL，7天有效)

# 2. 下载内容
GET {downloadUrl}
# → 纯文本 Markdown（无 "Page X of Y" 后缀）
```

---

## §3 同步状态数据库

### 3.1 数据结构（IndexedDB）

```typescript
interface SyncStateRecord {
  localPath: string;         // 主键：相对于 syncFolder 的路径，如 "日常学习/笔记.md"
  xgkbFileId: string;        // 玄关文件 ID
  xgkbFolderId: string;      // 玄关父文件夹 ID
  localMtime: number;        // 上次同步后的本地 mtime（毫秒）
  remoteMtime: number;       // 上次同步后的云端 mtime（毫秒）
  syncStatus: 'done' | 'failed';
  lastSyncAt: number;        // 上次同步时间戳
  lastError?: string;        // 最近一次错误信息
}
```

### 3.2 索引

- 主键：`localPath`
- 索引：`xgkbFileId`（用于云端文件反查本地路径）

### 3.3 初始化（首次同步）

当 SyncStateDb 为空时：
1. 遍历本地 syncFolder 下所有 `.md` 文件
2. 遍历云端 Obsidian 文件夹下所有 `.md` 文件（递归 getChildFiles）
3. 按路径匹配，执行决策逻辑
4. 同步成功后写入状态记录

---

## §4 同步算法

### 4.1 单次同步流程

```
用户触发同步（Ribbon 图标 / 命令面板）
    ↓
Step 1: 初始化
    ├─ getPersonalProjectId → projectId
    ├─ getLevel1Folders(projectId) → 找 "Obsidian" 文件夹
    │   ├─ 找到 → 记录 folderId
    │   └─ 未找到 → 调用 uploadContent 创建一个占位文件（自动创建 Obsidian 文件夹）
    ↓
Step 2: 采集文件列表
    ├─ 遍历本地 syncFolder（递归，只取 .md）→ localFiles: Map<path, FileEntry>
    ├─ 遍历云端 Obsidian 文件夹（递归 getChildFiles）→ remoteFiles: Map<path, XgkbFileVO>
    ↓
Step 3: 对每个路径执行决策（§4.2）
    ↓
Step 4: 执行同步操作（上传/下载/删除）
    ├─ 每个操作独立 try-catch
    ├─ 失败的记录到 failed 数组，不阻塞其他文件
    ↓
Step 5: 更新 SyncStateDb
    ↓
Step 6: 显示同步报告
```

### 4.2 决策逻辑

```
输入：
  localFile  — 本地文件信息（FileEntry | undefined）
  remoteFile — 云端文件信息（XgkbFileVO | undefined）
  record     — SyncStateDb 记录（SyncStateRecord | undefined）

输出：
  'upload-new'      — 本地新建到云端
  'upload-update'   — 本地更新到云端（已知 xgkbFileId）
  'download-new'    — 从云端下载到本地
  'download-update' — 从云端更新本地文件
  'delete-local'    — 删除本地文件（云端已删）
  'delete-remote'   — 删除云端文件（本地已删）
  'skip'            — 跳过（两端一致）

┌─────────────────────────────────────────────────────────────┐
│ 情况 A：无 record（首次同步该路径）                           │
│                                                              │
│   本地有 && 云端无 → upload-new                              │
│   本地无 && 云端有 → download-new                            │
│   本地有 && 云端有 → 对比 mtime：                            │
│     localMtime >= remoteMtime → upload-update                │
│     localMtime < remoteMtime  → download-update              │
├─────────────────────────────────────────────────────────────┤
│ 情况 B：有 record（增量同步）                                │
│                                                              │
│   本地无 && 云端无 → 清理 record（异常，理论上不应出现）      │
│   本地无 && 云端有 → delete-remote                           │
│   本地有 && 云端无 → delete-local                            │
│   本地有 && 云端有：                                        │
│     两端 mtime 都没变 → skip                                 │
│     只有本地变了 → upload-update                             │
│     只有云端变了 → download-update                           │
│     两端都变了 → LWW：较新的覆盖较旧的                       │
└─────────────────────────────────────────────────────────────┘

备注：
- "本地变了" = localMtime > record.localMtime
- "云端变了" = remoteMtime > record.remoteMtime
- mtime 比较容忍 1s 误差（MTIME_TOLERANCE_MS）
```

### 4.3 上传流程

```
upload-new (path, content):
  1. 从 path 提取文件夹路径（如 "日常学习/2026-04-30"）
  2. folderName = "Obsidian/" + 文件夹路径
  3. 调用 uploadContent({content, fileName, fileSuffix: "md", folderName})
  4. 返回值中获取 fileId
  5. 写入 SyncStateDb

upload-update (path, content, xgkbFileId):
  1. 调用 uploadContent({content, fileName, fileSuffix: "md", updateFileId: xgkbFileId})
  2. 写入 SyncStateDb（更新 mtime）
```

**重要**：
- `folderName` 传相对于个人空间根目录的路径（如 `"Obsidian/日常学习"`）
- uploadContent 自动解析 folderName 并创建不存在的中间目录
- 更新模式不需要传 folderName（文件已在目标目录）

### 4.4 下载流程

```
download (remoteFile, localPath):
  1. 调用 getFullFileContent(remoteFile.id) → 获取 Markdown 正文
  2. 清理尾部 "Page X of Y" 标记（如有）
  3. 确保本地目录存在（vault.createFolder 递归）
  4. vault.modify(vault.getFileByPath(localPath), content)
  5. 写入 SyncStateDb
```

**官方最佳实践（2026-05-03 确认）**：
- 永远使用 `uploadContent` 做纯文本的新建/更新（传 `updateFileId` 更新已有文件）
- 直接使用 `getFullFileContent` 读取正文，双写缓存已跑通，**所写即所读，无需 sleep 等待**
- 不要走底层重型的 `resourceId` 物理分片逻辑（`updateFileVersion` 等）
- 不要绕路用 `getDownloadInfo → downloadUrl` 下载

### 4.5 删除流程

```
delete-local (localPath, record):
  1. vault.trash(vault.getFileByPath(localPath))  // 走回收站，不是永久删除
  2. 从 SyncStateDb 删除记录

delete-remote (record):
  1. deleteFile(record.xgkbFileId)
  2. 从 SyncStateDb 删除记录
```

---

## §5 文件过滤规则

### 5.1 本地文件过滤

| 条件 | 处理 |
|------|------|
| 扩展名 `.md` | ✅ 同步 |
| 文件名包含 `_conflict_` | ❌ 忽略 |
| 路径包含 `.obsidian/` | ❌ 忽略 |
| 路径包含 `.trash/` | ❌ 忽略 |
| 其他扩展名 | ❌ 忽略 |

### 5.2 云端文件过滤

| 条件 | 处理 |
|------|------|
| `type === 2` && `suffix === "md"` | ✅ 同步 |
| `type === 1`（文件夹） | 仅遍历，不同步 |
| 其他 | ❌ 忽略 |

---

## §6 同步方向

| 方向 | 行为 |
|------|------|
| `bidirectional` | 双向同步（默认） |
| `push` | 只上传，不下载 |
| `pull` | 只下载，不上传 |

方向设置影响决策逻辑的输出范围。

---

## §7 错误处理

| 错误类型 | 处理策略 |
|---------|---------|
| 网络请求失败 | 指数退避重试（最多 3 次，base 1s） |
| 单文件同步失败 | 记录到 failed 列表，继续处理其他文件 |
| Obsidian 文件夹不存在 | `uploadContent` 自动创建 |
| 本地文件写入失败 | 记录 failed，报告用户 |
| 认证失败 (401) | 立即终止同步，提示检查 appKey |
| downloadUrl 过期 | 重新调用 getDownloadInfo |

---

## §8 MVP 范围

### ✅ 包含

- 双向同步（`.md` 文件）
- 手动触发（Ribbon 图标 + 命令面板）
- Last-Write-Wins 冲突策略
- 同步状态持久化（IndexedDB）
- 同步进度和结果报告
- 支持桌面端和移动端

### ❌ 不包含（后续 RT）

- 附件/图片同步
- 定时自动同步
- 同步历史/版本回溯
- wiki-links / frontmatter 转换
- 多空间支持（仅个人空间）
- 文件监控（实时同步）
- Obsidian Sync 兼容

---

## §9 技术架构

### 9.1 模块划分

```
src/
├── main.ts              ← 插件入口，注册命令和 Ribbon
├── settings.ts          ← 设置面板（appKey, syncFolder 等）
├── xgkbApi.ts           ← XGKB API 客户端（所有 HTTP 调用）
├── syncEngine.ts        ← 同步引擎（决策 + 执行）
├── syncStateDb.ts       ← IndexedDB 状态持久化
├── fsLocal.ts           ← 本地文件系统操作（Vault API 封装）
├── fsXgkb.ts            ← 云端文件系统抽象（API 封装）
├── conflictResolver.ts  ← 冲突解决（LWW 策略）
├── types.ts             ← 类型定义
└── constants.ts         ← 常量配置
```

### 9.2 XgkbApi 更新要点

相比现有代码需要更新：

1. **uploadContent 增加 updateFileId 支持**：
   - 传 `updateFileId` 时走版本更新模式
   - 不传时走新建模式

2. **下载直接用 getFullFileContent**：
   官方确认双写缓存已跑通，所写即所读，无需绕路 getDownloadInfo
   注意清理尾部 "Page X of Y" 标记

3. **移除对以下接口的依赖**：
   - `updateFileVersion`（底层重型逻辑，纯文本用 uploadContent 替代）
   - `batchGetContent`（无权限）
   - `saveFileByParentId` / `saveFileByPath`（不幂等，用 uploadContent 替代）
   - `getDownloadInfo → downloadUrl`（同步场景不需要绕路，直接用 getFullFileContent）

### 9.3 配置项

```typescript
interface XgkbPluginSettings {
  appKey: string;           // API 密钥
  serverUrl: string;        // API 地址
  syncFolder: string;       // 本地同步文件夹（空=整个 Vault）
  targetFolderName: string; // 云端目标文件夹名（默认 "Obsidian"）
  syncDirection: "bidirectional" | "push" | "pull";
}
```

---

## §10 变更记录

| 日期 | 版本 | 变更 | 作者 |
|------|------|------|------|
| 2026-04-30 | v1.0 | 创建，基于 hash 的同步方案 | Codex |
| 2026-05-01 | v2.0 | 切换到 LWW（mtime）策略 | Codex |
| 2026-05-03 | **v3.0** | **基于 API 实测 + 官方最佳实践重写**：① 文件更新用 `uploadContent(updateFileId)` 轻量高速通道；② 读取直接用 `getFullFileContent`（双写缓存已跑通，所写即所读）；③ 移除不可用接口依赖；④ 完善决策逻辑和错误处理；⑤ 明确 MVP 边界 | Codex |
