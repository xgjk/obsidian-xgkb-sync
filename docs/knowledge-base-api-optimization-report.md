# 知识库 Open API 优化需求说明（面向 Obsidian 双向同步等客户端）

**版本**：1.0  
**日期**：2026-05-04  
**背景**：本文在《知识库-API说明_总纲_v2》及 `API接口明细_v2` 已有能力之上，整理**建议新增或增强**的接口与契约，供产品/后端评审。凡未特别说明，均假定沿用现有鉴权：请求头 `appKey`、统一 `Result<T>` 响应（`resultCode === 1` 为成功）。

---

## 一、变更增量与同步游标

### 需求 R1：按时间（P0）/游标（P1）拉取「有变更的节点」

**问题**：客户端每次全树 `getChildFiles` 深度遍历，大库时请求次数多、易触达限流（如 610012），且无法做「只同步变化」。

**建议接口名（示例）**：`GET /document-database/file/listChanges` 或 `GET /document-database/sync/changes`

**分阶段建议（便于快速落地）**

- **P0（先上线）**：仅支持 `since` 增量拉取，满足双向同步主链路。  
- **P1（再增强）**：增加 `cursor`（不透明游标）以提升翻页稳定性与大规模增量拉取体验。

**请求参数（建议）**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `projectId` | Long | 否 | 空间 ID；不传且为个人库场景时，与 `4.8 getProjectId` 行为对齐，即默认当前用户个人空间 |
| `rootFileId` | Long | 否 | 仅关注某目录子树时传入该文件夹 `fileId`（与 `searchFile` 的 `rootFileId` 语义一致） |
| `since` | Long | 否 | 毫秒时间戳：返回「更新时间 ≥ since」的节点（与现有 `updateTime` 字段对齐） |
| `cursor` | String | 否 | 不透明游标（P1）；客户端只透传，不解析 |
| `limit` | Integer | 否 | 默认如 200，最大上限文档注明 |

**P0（since 模式）契约要求**

- 过滤规则：返回 `updateTime >= since`（避免边界漏数）。  
- 排序规则：`updateTime ASC, fileId ASC`（同毫秒稳定排序）。  
- 删除语义：必须返回 `event = delete`（至少携带 `fileId`）。  
- 客户端实践：`since` 建议回拨 3~10 秒（如 5 秒）并做去重（`fileId + updateTime`）。

**P1（cursor 模式）契约要求**

- `cursor` 为服务端生成的不透明令牌，客户端仅保存并回传。  
- 明确 `cursor` 失效错误码（如“游标过期”），客户端可降级执行一次 R2 全量对账后重建游标。  
- 若同时传 `since` 与 `cursor`，需文档固定优先级（建议 `cursor` 优先）。

**期望返回值 `data`**

```json
{
  "items": [
    {
      "fileId": 30001,
      "parentId": 10002,
      "type": 2,
      "name": "笔记.md",
      "updateTime": 1710000000000,
      "event": "upsert"
    }
  ],
  "nextCursor": "opaque-token-or-null",
  "serverTime": 1710000001000
}
```

- `event` 建议枚举：`upsert` | `delete`（逻辑删除时也要能通知到，避免客户端认为文件仍存在）。  
- 若暂不能提供删除事件，应在文档中明确「删除仅能通过全量对账发现」，以便客户端保留全量扫树作为降级路径。

**验收要点**：同一 `appKey` 下仅返回有权限的节点；`since` 边界与排序规则写死；`nextCursor` 与 `since` 组合行为（P1）写死，避免版本歧义。

---

## 二、单请求「子树扁平列表」

### 需求 R2：一次返回某根目录下全部 `.md` 文件元数据（可分页）

**问题**：深度优先多次 `getChildFiles` 延迟高；若配合 R1 仍可在「冷启动 / 无游标」时用扁平列表减少往返。

**建议接口名（示例）**：`GET /document-database/file/listDescendantFiles`

**请求参数（建议）**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `rootFileId` | Long | 是 | 根文件夹 `fileId` |
| `projectId` | Long | 否 | 与现网 `getChildFiles` 对项目根的行为保持一致 |
| `suffix` | String | 否 | 如 `md`，只返回该后缀文件 |
| `cursor` | String | 否 | 分页游标（建议统一 cursor，避免 page/cursor 双轨） |
| `limit` | Integer | 否 | 每页条数，默认值与上限需文档注明 |
| `includePath` | Boolean | 否 | 为 `true` 时每条带「相对 root 的逻辑路径」或 `ancestorNames` |

**期望返回值 `data`（示例）**

```json
{
  "files": [
    {
      "fileId": 30001,
      "parentId": 10002,
      "relativePath": "A/B/笔记.md",
      "name": "笔记.md",
      "updateTime": 1710000000000,
      "size": 1024
    }
  ],
  "nextCursor": null
}
```

**验收要点**：路径分隔符与命名规则与控制台一致；与个人库 / 企业库权限模型一致。

**契约补充建议**

- `relativePath` 分隔符固定为 `/`。  
- 明确 `relativePath` 是否包含 root 自身目录名（建议不包含）。  
- 明确返回对象范围：默认仅文件（`type=2`）；若要返回文件夹，建议额外参数 `includeFolders`。  
- 建议返回 `hasMore`（可选），减少客户端对 `nextCursor` 判空歧义。

---

## 三、批量元数据（无正文）

### 需求 R3：按 `fileId` 列表批量查询 `updateTime` / `size` / 父级

**问题**：下载前已用 `listFiles` 或 R2 拿到 `fileId`，若仅想比对是否变化，不需要拉 `getFullFileContent`。

**建议接口名（示例）**：`POST /document-database/file/batchGetMeta`

**请求体（建议）**

```json
{
  "fileIds": [30001, 30002],
  "projectId": null
}
```

**期望返回值 `data`**

```json
[
  {
    "fileId": 30001,
    "status": "success",
    "parentId": 10002,
    "updateTime": 1710000000000,
    "size": 1024,
    "name": "笔记.md",
    "type": 2,
    "deleted": false
  },
  {
    "fileId": 30002,
    "status": "not_found",
    "deleted": true
  }
]
```

**验收要点**：不存在的或无权访问的 `fileId` 建议返回逐项状态（不要静默忽略）；与 `batchGetContent` 单次条数上限可同档（如 10～50 可配置）；明确响应顺序是否与请求顺序一致。

---

## 四、条件写与冲突可观测性

### 需求 R4：上传/更新时携带「期望的远端版本」

**问题**：纯 LWW 会静默覆盖；客户端需要 **409/412** 类冲突信号以做「保留双方副本」或弹窗。

**建议（二选一或同时提供）**

1. **扩展现有 `uploadContent`（4.18）**  
   - 新增可选参数：`expectedUpdateTime`（Long）或 `expectedVersionNumber`（Integer）。  
   - 若与服务端当前最新不一致：`resultCode` 非 1，`resultMsg` / `data` 中带当前最新 `updateTime` 或 `versionNumber`。

2. **独立接口**：`POST /document-database/file/uploadContentIfMatch`  
   - 请求体在现有 `uploadContent` 基础上增加 `ifMatchUpdateTime` 等；  
   - 成功时与现网一致；失败时返回明确 **冲突子码**（如 `resultCode: 409001`）及当前元数据。

**期望失败时 `data` 结构（示例）**

```json
{
  "currentUpdateTime": 1710000000000,
  "currentVersionNumber": 3,
  "fileId": 30001
}
```

---

## 五、删除与回收站语义

### 需求 R5：「删除」事件可查询、可恢复策略明确

**问题**：`deleteFile` 已有 `isPhysical`；客户端需要文档级说明：逻辑删除后 `fileId` 是否仍可 `getFullFileContent`、是否仍出现在 `getChildFiles`、同步时应视为「不存在」的时间点。

**建议**：在《01-空间与目录树管理》4.13 补充「同步客户端推荐语义」小节；如有必要增加 `GET /document-database/file/trashList`（可选，低优先级）。

---

## 六、目录创建与空文件夹

### 需求 R6：显式创建空文件夹（不打占位文件）

**问题**：当前 Obsidian 插件用 `uploadContent` 占位文件再删除来「挤出」一级目录，脆弱且产生噪音。

**建议接口名（示例）**：`POST /document-database/file/createFolder`

**请求体（建议）**

```json
{
  "projectId": 2009488364113997826,
  "parentId": 10086,
  "name": "新文件夹",
  "conflictPolicy": "error"
}
```

**期望返回值 `data`**

```json
{
  "folderId": 10099,
  "name": "新文件夹",
  "parentId": 10086,
  "created": true
}
```

**验收要点**：同名冲突策略需固定（`error` / `reuse` / `autoRename`）；非法字符/长度限制与错误码需文档化；幂等语义需明确（重复创建同名目录时行为）。

---

## 七、路径与跨平台命名

### 需求 R7：返回「存储用规范化路径键」或官方非法字符规则

**问题**：Windows 与云端允许的文件夹名不完全一致，客户端各自 sanitize 易与 Web 端展示不一致。

**建议（任选）**

- 在 `FileVO` 中增加 `storageKey` 或 `canonicalName`；或  
- 提供「仅返回规范」的文档表：云端允许的字符集、与 Windows 冲突时的官方替换规则，便于多端一致。

---

## 八、限流与批大小（运维契约）

### 需求 R8：对批量接口的统一配额说明

**问题**：`batchGetContent` 已有「建议 ≤10 条」；若增加 `batchGetMeta`、R1 列表等，应有统一 **每用户 QPS / 每日配额 / 单请求最大条数**，并在错误码中区分「超限可重试」（610012）与「永久拒绝」。

**期望**：在总纲「错误码说明」中扩展 **610012** 的 Retry-After 或响应头约定（若技术上可行）；并补充 `listChanges/listDescendantFiles/batchGetMeta` 的单请求上限与推荐重试策略。

---

## 补充：与双向同步强相关的语义要求（建议新增）

1. **fileId 稳定性**：同一文件 rename / move 后 `fileId` 应保持不变。  
2. **删除可见性**：删除后能通过 R1 事件明确感知（而非依赖全量对账）。  
3. **时间语义**：`updateTime` 的时区与单位（毫秒）固定，并说明是否单调。  
4. **权限语义**：无权限对象在各接口中的表现保持一致（过滤或逐项错误）。

---

## 九、优先级建议（供排期）

| 优先级 | 需求编号 | 说明 |
|--------|----------|------|
| P0 | R1 / R3 | 显著减少全量扫树与无效全文下载 |
| P1 | R2 / R6 | 降低冷启动延迟、去掉占位文件初始化 |
| P2 | R4 / R5 | 冲突可观测、删除语义一致 |
| P3 | R7 / R8 | 多端一致性与运维可预期 |

---

## 十、与现有文档的引用关系

- 现有 **4.15 `batchGetContent`**（`POST .../document-database/ai/batchGetContent`）：适合作为全文批量拉取通道；客户端已在插件侧按 ≤10 条分块调用。  
- 现有 **4.4 `getFullFileContent`**：保留为单文件兜底与批量失败回退。  
- 现有 **4.18 `uploadContent`**：个人库快捷写盘；与 R4 条件写结合可提升同步安全性。

---

**文档结束**
