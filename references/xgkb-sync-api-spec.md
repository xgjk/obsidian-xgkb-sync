# XGKB API 接口映射表（cms-xgkb-sync 插件使用）

> **文档版本：v2.0**
> **最后更新：2026-05-07**
> **对应知识库 API 文档版本：v2（2026-05-06 更新）**

## 认证

- Header: `appKey: {YOUR_KEY}`
- Base URL: `https://sg-al-cwork-web.mediportal.com.cn/open-api/`
- 通用响应结构：`{ resultCode: 1, resultMsg: null, data: ... }`，`resultCode=1` 为成功

---

## 最佳实践（v2）

> **纯文本同步**：所有 Markdown 内容走 `uploadContent` 轻量通道（新建不传 `updateFileId`，更新传 `updateFileId`）。  
> **实时读取**：`uploadContent` 写入后直接用 `batchGetContent` / `getFullFileContent` 读取，**无需 sleep**（纯文本双写缓存即时生效）。  
> **异步延迟警告**：仅物理大文件（PDF/PPTX 等底层 `resourceId` 通道）写入后才存在 RAG 异步延迟，纯文本通道不受影响。  
> **增量同步**：用 `listChanges(since)` 拉增量变更 → `batchGetMeta` 对账 → 必要时 `batchGetContent` 拉正文；首次全量用 `listDescendantFiles`。

---

## 使用的接口

### 1. getPersonalProjectId — 获取个人空间 ID

**接口**: `GET /document-database/project/personal/getProjectId`

- 无参数，仅凭 `appKey` 自动返回当前用户的个人知识库 `projectId`
- 插件 `init()` 阶段一次性调用，结果缓存到 `fsXgkb.projectId`
- 返回: `data: Long`（即 `projectId`）

---

### 2. getLevel1Folders — 获取根目录一级列表

**接口**: `GET /document-database/file/getLevel1Folders?projectId={id}`

- 返回个人空间根目录下的所有文件夹和文件（`List<FileVO>`）
- 插件用于初始化时查找 `targetFolderName`（同步根目录）是否存在
- `type=1` 文件夹 / `type=2` 文件；用 `id` 作为后续 `parentId`

---

### 3. createFolder — 显式创建文件夹（v2 新增）

**接口**: `POST /document-database/file/createFolder`

```json
{
  "projectId": 2009488364113997826,
  "parentId": 0,
  "name": "NoteX",
  "cover": false,
  "autoRename": false
}
```

- 用于初始化时在根目录创建同步根文件夹，替代旧版"上传占位文件再删除"的旁路
- 同名冲突默认报错；`cover=true` 覆盖；`autoRename=true` 自动追加数字后缀
- 返回: `data: Long`（新建文件夹的 `fileId`）

---

### 4. listDescendantFiles — 子树扁平列举（v2 新增，全量扫描）

**接口**: `GET /document-database/file/listDescendantFiles`

| 参数 | 类型 | 说明 |
|------|------|------|
| `rootFileId` | Long | 必填，同步根目录的 `fileId` |
| `projectId` | Long | 建议传，用于权限隔离 |
| `suffix` | String | 文件后缀过滤，默认 `md` |
| `cursor` | String | 翻页游标（上一页返回的 `nextCursor`） |
| `limit` | Integer | 单页数量，默认 500 |
| `includePath` | Boolean | 是否返回 `relativePath`（开启有额外成本），插件传 `true` |

响应 `data`:
```json
{
  "files": [
    {
      "fileId": 30001,
      "parentId": 10086,
      "name": "README.md",
      "updateTime": 1714972800000,
      "size": 1024,
      "relativePath": "AI生成/调研摘要/README.md"
    }
  ],
  "nextCursor": "MTcxNDk3MjgwMDAwMCwzMDAwMQ"
}
```

- 插件替代递归 `getChildFiles` 的全量扫描方案，单次拉取整棵子树
- 循环翻页直到 `nextCursor` 为 `null`
- `relativePath` 是相对于 `rootFileId` 的路径，直接用于本地路径映射

---

### 5. listChanges — 增量变更列表（v2 新增，增量同步）

**接口**: `GET /document-database/file/listChanges`

| 参数 | 类型 | 说明 |
|------|------|------|
| `rootFileId` | Long | 限定在同步根目录子树内 |
| `since` | Long | 毫秒时间戳，拉取该时间之后的变更；首次全量同步前不传 |
| `cursor` | String | 翻页游标（存在时优先于 `since`） |
| `limit` | Integer | 单页数量，默认 200 |

响应 `data`:
```json
{
  "items": [
    {
      "fileId": 30001,
      "parentId": 10086,
      "type": 2,
      "name": "README.md",
      "updateTime": 1714972800000,
      "event": "upsert"
    },
    {
      "fileId": 30002,
      "parentId": 10086,
      "type": 2,
      "name": "old.md",
      "updateTime": 1714972810000,
      "event": "delete"
    }
  ],
  "nextCursor": "MTcxNDk3MjgxMDAwMCwzMDAwMg",
  "serverTime": 1714972812345
}
```

- `event`: `upsert`（新增/更新）或 `delete`（逻辑删除）
- `serverTime`：服务端当前时间戳，作为下次同步的 `since` 水位（存入 `data.json`）
- 插件侧安全窗口：查询时 `since = lastSyncTime - CHANGES_SAFETY_WINDOW_MS (5s)` 防止漏事件
- 循环翻页直到 `nextCursor` 为 `null`

---

### 6. batchGetMeta — 批量获取文件元数据（v2 新增，增量对账）

**接口**: `POST /document-database/file/batchGetMeta`

```json
{ "fileIds": [30001, 30002], "projectId": 2009488364113997826 }
```

响应 `data` (`List<MetaItem>`):
```json
[
  { "fileId": 30001, "parentId": 10086, "name": "README.md", "updateTime": 1714972800000, "size": 1024, "deleted": false },
  { "fileId": 30002, "parentId": 10086, "name": "secret.md", "updateTime": 1714972810000, "size": 2048, "deleted": true }
]
```

- 用于增量同步中对 `upsert` 事件的文件批量刷新元数据（`mtime`、`name`、`parentId`）
- `deleted: true` 表示该文件已被逻辑删除
- 插件单批上限：`BATCH_GET_META_MAX = 50`，超出自动分批

---

### 7. uploadContent — 新建 + 更新文件（纯文本高速通道）

**接口**: `POST /document-database/file/uploadContent`

**新建模式**（不传 `updateFileId`）：
```json
{
  "content": "# Title\nContent",
  "fileName": "笔记",
  "fileSuffix": "md",
  "folderName": "NoteX/日常学习"
}
```
- `folderName` 支持多级路径，自动创建中间目录
- `fileName` 不能含路径分隔符（`/` `\`），路径只放在 `folderName`
- 不传 `folderName` 默认归档到"和AI的对话"
- 返回: `{ projectId, folderId, fileId, fileName, downloadUrl }`

**更新模式**（传 `updateFileId`）：
```json
{
  "updateFileId": 30001,
  "content": "# Updated content",
  "fileName": "笔记",
  "fileSuffix": "md",
  "versionRemark": "sync update"
}
```
- 创建新版本记录，`folderName` 参数无效
- 返回: `{ fileId, fileName }`

---

### 8. batchGetContent — 批量获取文件全文

**接口**: `POST /document-database/ai/batchGetContent`

```json
{
  "files": [
    { "fileId": 30001 },
    { "fileId": 30002, "fileType": "doc" }
  ]
}
```

响应 `data` (`List<FileContentVO>`):
```json
[
  { "fileId": 30001, "content": "# 全文...", "status": "success", "message": null },
  { "fileId": 30002, "content": null, "status": "empty", "message": "文件内容为空" }
]
```

- `status`: `success` / `empty` / `error`
- 插件用于下载文件正文（Download 动作）
- 单次建议不超过 10 个文件；`BATCH_GET_CONTENT_MAX = 10`
- `fileType` 可不传，后端自动补全；仅在需要强制覆盖时传入

---

### 9. getFullFileContent — 读取单文件全文

**接口**: `GET /document-database/file/getFullFileContent?fileId={id}`

- 返回经过提纯的 Markdown 全文（`data: String`）
- 纯文本（`uploadContent` 写入）可立即读取，无延迟
- 可能含尾部 `\n\nPage X of Y` 标记，插件中需 `cleanContent()` 清理
- 大文件/物理文件存在异步 RAG 解析延迟，同步场景只用 `uploadContent` 通道无此问题

---

### 10. deleteFile — 删除文件

**接口**: `POST /document-database/file/deleteFile`

```json
{ "fileId": 30001, "isPhysical": false }
```

- `isPhysical: false`（默认）：逻辑删除（移入回收站）
- `isPhysical: true`：物理彻底删除
- 插件同步删除动作使用逻辑删除
- 重复删除已删除文件不报错（幂等）
- 返回: `data: true`

---

### 11. getChildFiles — 浏览子目录（初始化辅助）

**接口**: `GET /document-database/file/getChildFiles?parentId={id}`

- `parentId=0` 为根目录
- 插件仅在 `init()` 阶段扫描根目录时使用（已被 `listDescendantFiles` 替代大部分场景）
- 支持 `type`、`excludeFileTypes`、`excludeFolderNames` 等过滤参数

---

### 12. searchFile — 搜索文件

**接口**: `GET /document-database/file/searchFile?nameKey={keyword}`

- 返回 `{ folders: [...], files: [...] }`（`SearchFileVO`）
- 支持 `rootFileId` 限定搜索范围；中文参数需 URL 编码（UTF-8）

---

### 13. getVersionList / getLastVersion — 版本管理（调试用）

- `GET /document-database/file/getVersionList?fileId={id}`
- `GET /document-database/file/getLastVersion?fileId={id}`

---

## 不使用的接口

| 接口 | 原因 |
|------|------|
| `updateFileVersion` (4.25) | 底层重型 `resourceId` 物理分片逻辑。纯文本场景用 `uploadContent(updateFileId)` |
| `saveFileByParentId` (4.16) | 同名文件报错（不幂等），纯文本场景用 `uploadContent` 更合适 |
| `saveFileByPath` (4.17) | 同上 |
| `getDownloadInfo → downloadUrl` | 同步场景不需要绕路下载，直接用 `batchGetContent` / `getFullFileContent` |
| `updateFileProperty` (4.14) | 重命名/移动接口。当前插件以路径为主键，云端改名由 `listChanges+batchGetMeta` 探测后重新上传处理 |

---

## 重要注意事项

1. **ID 类型**：API 返回的 `id`/`fileId`/`parentId` 可能是 `string` 或 `number`（Long），统一转为 `string` 存储
2. **所写即所读**：`uploadContent` 纯文本通道写入后立即可用 `batchGetContent` / `getFullFileContent` 读取，无需 sleep
3. **`Page X of Y` 清理**：`getFullFileContent` / `batchGetContent` 返回内容可能含分页标记，插件用 `cleanContent()` 清理（strip 末尾 `\n\nPage \d+ of \d+`）
4. **幂等性**：`uploadContent` 新建模式（不传 `updateFileId`）每次调用都创建新文件；更新模式（传 `updateFileId`）幂等
5. **`folderName` 与 `fileName` 分离**：`fileName` 只传文件名不含路径，路径部分放 `folderName`
6. **增量水位**：`listChanges` 返回的 `serverTime` 是下次 `since` 的基准，插件持久化到 `data.json` 的 `lastSyncTime` 字段
7. **限流**：`resultCode=610012` 表示触发 QPS 限流，需退避重试
8. **`batchGetContent` 路径变更（v2）**：接口路径从 `document-database/file/` 变更为 `document-database/ai/`，插件已更新
