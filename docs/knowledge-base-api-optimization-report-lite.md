# 知识库 API 优化需求（简版：R1 / R2 / R3 / R5 / R6）

**版本**：简版 1.0  
**日期**：2026-05-04  
**说明**：从《knowledge-base-api-optimization-report.md》抽取并压缩；鉴权与响应格式仍遵循总纲：`appKey`、`Result<T>`、`resultCode === 1` 为成功。

---

## R1：增量变更列表（since / cursor）

| 项 | 内容 |
|----|------|
| **要解决** | 避免每次全树 `getChildFiles` 递归，支持「只拉变更」，降低限流风险。 |
| **建议路径** | `GET .../document-database/file/listChanges`（名称示例） |
| **参数** | `projectId?`，`rootFileId?`，`since?`（毫秒），`cursor?`，`limit?` |
| **期望 data** | `{ items: [{ fileId, parentId, type, name, updateTime, event }], nextCursor, serverTime }`，`event` 建议含 `upsert` / `delete`。 |
| **验收** | 权限范围与 `appKey` 一致；`since`+`cursor` 语义在文档中固定。 |

---

## R2：子树扁平列举（单根下全部 .md 元数据）

| 项 | 内容 |
|----|------|
| **要解决** | 冷启动时一次拿到某根目录下所有目标文件元数据，减少多层 `getChildFiles`。 |
| **建议路径** | `GET .../document-database/file/listDescendantFiles`（名称示例） |
| **参数** | `rootFileId`（必填），`projectId?`，`suffix?`（如 `md`），分页 `cursor`/`page`，`includePath?` |
| **期望 data** | `{ files: [{ fileId, parentId, relativePath?, name, updateTime, size }], nextCursor }` |
| **验收** | 路径规则与控制台一致；权限与现网列表接口一致。 |

---

## R3：按 fileId 批量查元数据（无正文）

| 项 | 内容 |
|----|------|
| **要解决** | 比对是否变更时不必每次 `getFullFileContent`。 |
| **建议路径** | `POST .../document-database/file/batchGetMeta` |
| **请求体** | `{ "fileIds": [30001, 30002], "projectId": null }` |
| **期望 data** | 数组：`[{ fileId, parentId, updateTime, size, name, deleted }]` |
| **验收** | 无效/无权限 id 的处理策略写清；单批条数上限与 `batchGetContent` 同档可配置。 |

---

## R5：删除与回收站语义（文档化为主）

| 项 | 内容 |
|----|------|
| **要解决** | 逻辑删除后：`fileId` 能否再读全文、是否仍出现在 `getChildFiles`、同步何时视为「不存在」。 |
| **建议** | 在《01-空间与目录树管理》**4.13 deleteFile** 增加「同步客户端推荐语义」小节。 |
| **可选接口** | `GET .../file/trashList`（低优先级，按需再做）。 |
| **验收** | 行为可预测，多端删除对账一致。 |

---

## R6：显式创建空文件夹

| 项 | 内容 |
|----|------|
| **要解决** | 不必依赖 `uploadContent` 占位文件再删来建目录。 |
| **建议路径** | `POST .../document-database/file/createFolder` |
| **请求体** | `{ "projectId", "parentId", "name" }` |
| **期望 data** | `{ "folderId", "name" }` |
| **验收** | 同名冲突策略与 `updateFileProperty`（cover/autoRename）对齐或单独说明。 |

---

## 简版优先级参考

| 优先级 | 编号 | 关键词 |
|--------|------|--------|
| P0 | R1、R3 | 增量、元数据批量 |
| P1 | R2、R6 | 扁平列表、建空目录 |
| P2 | R5 | 删除语义 |

---

**完整版**：见同目录 `knowledge-base-api-optimization-report.md`。
