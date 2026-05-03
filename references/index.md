# 玄关知识库同步插件 - 参考资料索引

## 1. 玄关知识库 API

- **仓库**：<https://github.com/xgjk/dev-guide/>
- **业务说明**：<https://github.com/xgjk/dev-guide/blob/main/02.%E4%BA%A7%E5%93%81%E4%B8%9A%E5%8A%A1AI%E6%96%87%E6%A1%A3/%E7%9F%A5%E8%AF%86%E5%BA%93/%E7%9F%A5%E8%AF%86%E5%BA%93%E4%B8%9A%E5%8A%A1%E8%AF%B4%E6%98%8E.md>
- **API 文档**：<https://github.com/xgjk/dev-guide/blob/main/02.%E4%BA%A7%E5%93%81%E4%B8%9A%E5%8A%A1AI%E6%96%87%E6%A1%A3/%E7%9F%A5%E8%AF%86%E5%BA%93/%E7%9F%A5%E8%AF%86%E5%BA%93-API%E8%AF%B4%E6%98%8E.md>

### 关键 API 汇总

| # | 功能 | Method | Path | 备注 |
|---|------|--------|------|------|
| 4.1 | 获取下级目录及文件 | GET | /document-database/file/getChildFiles | parentId 下钻 |
| 4.2 | 获取下载/预览凭据 | GET | /document-database/file/getDownloadInfo | |
| 4.3 | 分页获取文件内容 | GET | /document-database/file/getFileContent | |
| 4.4 | 获取文件全文 | GET | /document-database/file/getFullFileContent | 返回 Markdown |
| 4.8 | 获取个人知识库空间Id | GET | /document-database/project/personal/getProjectId | |
| 4.11 | 搜索文件 | GET | /document-database/file/searchFile | |
| 4.12 | 获取一级目录 | GET | /document-database/file/getLevel1Folders | |
| 4.15 | 批量获取内容 | POST | /document-database/file/batchGetContent | 最多 10 个 |
| 4.16 | 按父ID保存文件 | POST | /document-database/file/saveFileByParentId | |
| 4.17 | 按路径保存文件 | POST | /document-database/file/saveFileByPath | 自动创建目录 |
| 4.18 | 纯文本入库 | POST | /document-database/file/uploadContent | Markdown 入库首选 |
| 4.19 | 获取空间列表 | GET | /document-database/project/list | |
| 4.20 | 获取可写空间列表 | GET | /document-database/project/uploadableList | |

### 认证
- Header: `appKey: {YOUR_KEY}`
- Base URL: `https://sg-al-cwork-web.mediportal.com.cn/open-api/`

## 2. Remotely Save（参考实现）

- **仓库**：<https://github.com/remotely-save/remotely-save>
- **同步算法文档**：<https://github.com/remotely-save/remotely-save/tree/master/docs/sync_algorithm/v3>
- **关键设计模式**：
  - FakeFsLocal / FakeFsRemote 抽象层
  - SyncEngine 基于状态 DB 的增量同步
  - SyncPlan（差异计算 → 用户确认 → 执行）
  - 冲突处理（keep_newer / keep_larger / keep_both）

## 3. Obsidian Plugin 开发

- **官方文档**：<https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin>
- **API 参考**：<https://docs.obsidian.md/Reference/TypeScript+API>
- **Sample Plugin**：<https://github.com/obsidianmd/obsidian-sample-plugin>
