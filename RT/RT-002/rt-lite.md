# RT-002: 同步引擎重构 - 完整双向同步机制

## §1 背景与目标

### 现状问题
当前 MVP 的同步逻辑非常粗糙：
- 没有删除同步（本地删了云端不删）
- 冲突策略只有 keep_both，且实现不完整
- 没有增量同步概念（每次全量比对）
- 目录结构不一致时的处理逻辑缺失

### 目标
参考 **Syncthing + Dropbox** 的成熟方案，设计一套完整、可信赖的双向同步机制。

---

## §2 同步机制设计

### 2.1 核心概念

**三份数据模型：**
- `LocalFile` - 本地 Obsidian 文件
- `RemoteFile` - 玄关知识库文件
- `SyncState` - IndexedDB 中记录的同步状态

**同步状态记录（SyncStateRecord）：**
```typescript
interface SyncStateRecord {
  localPath: string;        // Vault 相对路径，PK
  xgkbFileId: number;       // 知识库 fileId
  localMtime: number;        // 本地文件上次同步时的 mtime
  remoteMtime: number;      // 云端文件上次同步时的 mtime
  contentHash: string;      // 上次同步时的 SHA-256 哈希
  lastSyncTime: number;      // 上次同步的 Unix timestamp
  syncStatus: SyncStatus;   // 'synced' | 'pending' | 'conflict'
}
```

### 2.2 变化检测

**检测方式：** `mtime + SHA-256 内容哈希`

| 场景 | 判断逻辑 |
|------|---------|
| 本地变了 | localMtime 变了 或 hash 变了 |
| 云端变了 | remoteMtime 变了 或 hash 变了 |
| 两边都没变 | mtime 和 hash 都没变 |
| 删除检测 | SyncState 有记录但本地文件不存在，或云端 fileId 不存在 |

**流程：**
1. 扫描本地文件列表，计算 SHA-256 哈希
2. 调用 `getChildFiles` 递归获取云端文件列表
3. 与 IndexedDB 中的 SyncState 对比
4. 标记每个文件的状态（新增/修改/删除/冲突/同步）

### 2.3 同步动作矩阵

| 本地状态 | 云端状态 | SyncState | 处理动作 |
|---------|---------|-----------|---------|
| 不存在 | 存在 | 有记录 | 删除 SyncState → 不自动删云端（可选策略） |
| 存在 | 不存在 | 有记录 | 同上逻辑 |
| 不存在 | 存在 | 无记录 | **拉取下载** |
| 存在 | 不存在 | 无记录 | **上传推送** |
| 存在 | 存在 | hash 相同 | 跳过（已同步） |
| 存在 | 存在 | hash 不同，mtime 本地新 | **本地覆盖云端**（push） |
| 存在 | 存在 | hash 不同，mtime 云端新 | **云端覆盖本地**（pull） |
| 存在 | 存在 | hash 不同，mtime 相近 | **冲突** → 保留两边 |

**冲突判定：** 两边都对同一文件做了修改，且内容 hash 不同 → 冲突。

### 2.4 冲突处理策略

参考 **Syncthing** 的成熟做法：

1. **保留两边**（默认策略）：
   - 本地文件保持不变
   - 云端文件下载到本地，命名为 `<name>.conflict.<timestamp>.<ext>`

2. **用户手动解决**：
   - 用户比较两个文件，决定保留哪个
   - 删除不要的版本，插件下次同步时会处理

3. **可选策略（后续迭代）**：
   - `keep_local` - 保留本地，强制上传覆盖云端
   - `keep_remote` - 保留云端，强制下载覆盖本地
   - `keep_both` - 保留两边（当前默认）

### 2.5 删除同步

当前 MVP 版本**不自动删除**文件，避免误操作导致数据丢失。

删除同步作为后续迭代功能。

---

## §3 同步流程

### 3.1 完整同步流程（每次 Sync Now）

```
1. 获取本地文件列表
   └── 计算每个文件的 SHA-256 哈希

2. 获取云端文件列表（递归）
   └── getChildFiles(rootId) 递归遍历

3. 构建差异矩阵
   └── 对比：SyncState + LocalList + RemoteList
   └── 标记每个文件的同步状态

4. 执行同步（按优先级）
   ├── 冲突文件（先标记，不操作）
   ├── 上传（push）
   ├── 下载（pull）
   └── 删除（标记，待定）

5. 更新 SyncState
   └── 成功同步后写入 IndexedDB

6. 报告结果
   └── 上传 N 个，下载 N 个，冲突 N 个
```

### 3.2 增量同步优化

首次同步后，每次 Sync Now 只检查：
- SyncState 中有记录且 mtime 未变的文件 → 跳过
- 新增/修改/删除的文件 → 按矩阵处理

---

## §4 参考方案

| 工具 | 变化检测 | 冲突处理 | 特点 |
|------|---------|---------|------|
| **Syncthing** | mtime + hash | 重命名 .sync-conflict | 去中心化，双向同步成熟方案 |
| **Remotely Save** | SHA-256 hash | 无冲突处理 | Obsidian 生态，简单直接 |
| **Dropbox** | 内容分块 delta | 版本历史 | 云存储标杆，delta 传输效率高 |
| **rsync** | rolling checksum | 不处理冲突 | delta 算法，远程同步经典 |

本方案以 **Syncthing** 为基础模型，适配 Obsidian 插件场景。

---

## §5 关键设计决策

1. **变化检测：** mtime + SHA-256，不依赖服务器时间戳
2. **SyncState 持久化：** IndexedDB，以 localPath 为主键
3. **冲突策略：** 默认 keep_both，用户手动解决
4. **删除策略：** MVP 不自动删除，标记状态待后续迭代
5. **增量同步：** 以 SyncState 为锚点，只处理差异文件

---

## §6 设计决策

| 维度 | 决策 | 参考来源 |
|------|------|---------|
| 删除同步 | 不自动删除，修改永远赢（Mod vs Del → Mod wins） | Syncthing |
| 冲突处理 | 保留两边，加 `.conflict.<timestamp>` 后缀 | Syncthing |
| 版本历史 | MVP 不做，后续迭代 | Dropbox (有 API 但 MVP 先跑通) |

---

## §7 实现计划

### Phase 1：同步状态层
- [ ] 重构 `syncStateDb.ts` — 完整 SyncStateRecord 结构
- [ ] `computeFileHash()` 工具函数
- [ ] `SyncEngine.listLocalFiles()` — 扫描 + hash
- [ ] `SyncEngine.listRemoteFiles()` — 递归 getChildFiles

### Phase 2：差异检测层
- [ ] `SyncEngine.buildDiffMatrix()` — 三路对比逻辑
- [ ] 冲突检测（hash 不同 + mtime 相近）
- [ ] 删除检测（SyncState 有但本地/云端不存在）

### Phase 3：执行层
- [ ] `SyncEngine.pushFile()` — 上传覆盖云端
- [ ] `SyncEngine.pullFile()` — 下载覆盖本地
- [ ] `SyncEngine.handleConflict()` — 生成 .conflict 文件
- [ ] `SyncEngine.execute()` — 主同步循环，按优先级执行
