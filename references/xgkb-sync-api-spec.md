# XGKB API 接口映射表（RT-001 同步方案使用）

> **最后验证：2026-05-03**
> 
> 基于 GitHub 文档（v1.15, 2026-04-27）、实际 API 调用验证、以及官方最佳实践确认。

## 认证

- Header: `appKey: {YOUR_KEY}`
- Base URL: `https://sg-al-cwork-web.mediportal.com.cn/open-api/`
- 状态: ✅ 正常

---

## 官方最佳实践（2026-05-03 确认）

> **场景**：AI 助手生成新文章，或 Obsidian 插件更新笔记，需要立即读取确认。
>
> **更新文本**：纯文本数据永远走轻量级 `uploadContent` 高速通道，更新已有文件务必传 `updateFileId`。不要走底层重型的 `resourceId` 物理分片逻辑。
>
> **实时读取**：无论新建还是更新，直接调用 `getFullFileContent`。后端双写缓存已跑通，**所写即所读，无需 sleep 延迟等待**。

---

## 使用的接口

### 1. uploadContent — 新建 + 更新文件（高速通道）

**接口**: `POST /document-database/file/uploadContent`

**新建模式**（不传 updateFileId）：
```json
{
  "content": "# Title\nContent",
  "fileName": "笔记.md",
  "fileSuffix": "md",
  "folderName": "Obsidian/日常学习"
}
```
- `folderName` 支持嵌套路径，自动创建中间目录
- 不传 `folderName` 默认归档到"和AI的对话"
- 返回: `{projectId, folderId, fileId, fileName, downloadUrl}`

**更新模式**（传 updateFileId）：
```json
{
  "updateFileId": "2050924928689090562",
  "content": "# Updated content",
  "fileName": "笔记.md",
  "fileSuffix": "md",
  "versionRemark": "sync update"
}
```
- 传入 `updateFileId` 自动切换为版本更新模式
- 创建新版本记录，`folderName` 参数无效
- 返回: `{fileId, fileName}`

### 2. getFullFileContent — 读取文件全文（所写即所读）

**接口**: `GET /document-database/file/getFullFileContent?fileId={id}`

- 新建/更新后立即可读（双写缓存已跑通）
- 返回 Markdown 正文
- 可能含尾部 "Page X of Y" 标记，需代码中清理

### 3. getChildFiles — 浏览目录

**接口**: `GET /document-database/file/getChildFiles?parentId={id}`

- `parentId=0` 为根目录
- `type=1` 文件夹, `type=2` 文件
- 支持 `type`、`excludeFileTypes`、`excludeFolderNames` 等过滤参数
- 需递归调用遍历子目录

### 4. getLevel1Folders — 获取一级目录

**接口**: `GET /document-database/file/getLevel1Folders?projectId={id}`

- 返回项目空间根目录下的所有文件夹和文件
- 用于初始化时找 "Obsidian" 文件夹

### 5. getPersonalProjectId — 获取个人空间 ID

**接口**: `GET /document-database/project/personal/getProjectId`

- 返回个人知识库的 projectId
- 一次性调用，结果可缓存

### 6. deleteFile — 删除文件

**接口**: `POST /document-database/file/deleteFile`

```json
{"fileId": "2050924928689090562"}
```

- 逻辑删除
- 返回 `data: true`

### 7. searchFile — 搜索文件

**接口**: `GET /document-database/file/searchFile?nameKey={keyword}`

- 返回 `{folders: [...], files: [...]}`
- 支持 `rootFileId` 限定搜索范围

### 8. getVersionList / getLastVersion — 版本管理（调试用）

- `GET /document-database/file/getVersionList?fileId={id}`
- `GET /document-database/file/getLastVersion?fileId={id}`

---

## 不使用的接口

| 接口 | 原因 |
|------|------|
| `updateFileVersion` (4.25) | 底层重型 resourceId 物理分片逻辑。纯文本用轻量级 `uploadContent(updateFileId)` |
| `batchGetContent` (4.15) | 返回 `no permission`，无访问权限 |
| `saveFileByParentId` (4.16) | 同名文件报错（不幂等），纯文本场景用 uploadContent 更合适 |
| `saveFileByPath` (4.17) | 同上 |
| `getDownloadInfo → downloadUrl` | 同步场景不需要绕路下载，直接用 `getFullFileContent` 所写即所读 |

---

## 重要注意事项

1. **ID 类型**：API 返回的 id 可能是 string 或 number，统一转为 string 存储
2. **所写即所读**：双写缓存已跑通，`getFullFileContent` 写后立即可读，无需 sleep
3. **"Page X of Y"**：`getFullFileContent` 可能追加分页标记，代码中需清理（strip 末尾 `\n\nPage \d+ of \d+`）
4. **幂等性**：`uploadContent` 新建模式每次调用都会创建新文件，更新模式（updateFileId）幂等
5. **folderName 嵌套**：自动创建中间目录，不需要单独创建文件夹的 API
