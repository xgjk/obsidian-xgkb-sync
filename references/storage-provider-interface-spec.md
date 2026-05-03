# 云存储同步接口规范（Storage Provider Interface）

> 目标：定义一套统一的存储服务接口规范，插件通过这套接口对接任意云存储服务提供商，实现跨平台兼容。

## 一、设计原则

- **接口最小化**：只定义同步插件真正需要的操作，不贪大求全
- **语义清晰**：每个接口的语义、错误行为、边界条件都有明确说明
- **实现无关**：规范不限定具体技术栈（REST、gRPC、S3兼容等），只定义输入输出契约
- **幂等优先**：所有写操作尽量设计为幂等的，减少客户端复杂度

---

## 二、核心概念

### 存储空间（Bucket / Namespace）

存储服务中最顶层的命名空间。一个 Bucket 下可以包含任意数量的文件和文件夹。

```
bucket
└── folder/
    └── file.md
```

### 对象键（Object Key）

对象的唯一标识符，格式为文件在 Bucket 内的相对路径，使用 `/` 作为路径分隔符。

```
Obsidian/daily/2026-05-01/notes.md
```

### 文件夹（Folder）

用于组织对象的逻辑层级。文件夹本身不实际存在，对象列表通过 `prefix` + `delimiter` 模拟文件夹结构。

### 文件元数据

| 字段 | 类型 | 说明 |
|------|------|------|
| `key` | string | 对象键（必填） |
| `name` | string | 文件名（不含路径，如 `notes.md`） |
| `size` | integer | 文件大小（字节） |
| `lastModified` | integer | 最后修改时间（毫秒级 Unix 时间戳） |
| `etag` | string | 文件实体标签（用于变更检测，推荐 MD5） |

---

## 三、接口定义

### 接口 1：列举文件列表

**用途：** 同步时扫描云端已有哪些文件

**请求：**
```
GET /list
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prefix` | string | 否 | 只返回以此前缀开头的对象（如 `Obsidian/`） |
| `delimiter` | string | 否 | 分隔符（如 `/`），配合 prefix 使用可模拟文件夹层级 |
| `maxKeys` | integer | 否 | 单次最多返回条目数，默认 1000 |
| `marker` | string | 否 | 分页游标，首次请求为空，后续填入上次返回的 `nextMarker` |

**响应：**
```json
{
  "resultCode": 1,
  "data": {
    "entries": [
      {
        "key": "Obsidian/daily/notes.md",
        "name": "notes.md",
        "size": 1234,
        "lastModified": 1746057600000,
        "etag": "d8e8fca2dc0f896fd7cb4cb0031ba249"
      }
    ],
    "commonPrefixes": [
      "Obsidian/daily/",
      "Obsidian/work/"
    ],
    "isTruncated": false,
    "nextMarker": null
  }
}
```

**说明：**
- `entries` 为文件列表，`commonPrefixes` 为模拟的子文件夹列表
- 如果 `isTruncated=true`，需要用 `nextMarker` 请求下一页
- `lastModified` 必须为毫秒级时间戳

---

### 接口 2：上传文件

**用途：** 将本地文件同步到云端

**请求：**
```
PUT /upload
Content-Type: multipart/form-data 或 application/json
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | string | 是 | 对象键（如 `Obsidian/daily/notes.md`） |
| `content` | string | 是 | 文件内容（UTF-8 文本） |
| `overwrite` | boolean | 否 | 是否覆盖已有文件，默认 true |

**响应：**
```json
{
  "resultCode": 1,
  "data": {
    "key": "Obsidian/daily/notes.md",
    "etag": "d8e8fca2dc0f896fd7cb4cb0031ba249",
    "lastModified": 1746057600000
  }
}
```

**关键行为要求：**

| 场景 | 要求 |
|------|------|
| key 不存在 | 创建新文件，返回 200 |
| key 已存在 + overwrite=true | **幂等覆盖**，返回 200 |
| key 已存在 + overwrite=false | 返回 409 Conflict |
| 上传后立即 GET | **必须立即可读**，不允许延迟 |

**⚠️ 最重要的一条：上传后必须立即可被 GET 和 LIST 接口读取，不允许有异步传播延迟。**

---

### 接口 3：读取文件内容

**用途：** 从云端下载文件内容

**请求：**
```
GET /download?key={key}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `key` | string | 是 | 对象键 |

**响应：**
```json
{
  "resultCode": 1,
  "data": {
    "key": "Obsidian/daily/notes.md",
    "content": "# 标题\n\n正文内容...",
    "size": 1234,
    "lastModified": 1746057600000,
    "etag": "d8e8fca2dc0f896fd7cb4cb0031ba249"
  }
}
```

**错误响应：**
```json
{
  "resultCode": 404,
  "resultMsg": "文件不存在"
}
```

---

### 接口 4：删除文件

**请求：**
```
DELETE /delete
```

**请求体：**
```json
{
  "key": "Obsidian/daily/notes.md"
}
```

**响应：**
```json
{
  "resultCode": 1,
  "data": null
}
```

**行为要求：**
- key 不存在时返回 200（幂等删除）
- key 是文件夹时返回 400 Bad Request

---

### 接口 5：批量删除

**请求：**
```
POST /delete-batch
```

**请求体：**
```json
{
  "keys": [
    "Obsidian/daily/notes.md",
    "Obsidian/daily/old.md"
  ]
}
```

**响应：**
```json
{
  "resultCode": 1,
  "data": {
    "deleted": ["Obsidian/daily/notes.md"],
    "failed": []
  }
}
```

---

### 接口 6：获取文件夹下直接子项（不含递归）

**请求：**
```
GET /list?prefix={prefix}&delimiter=/
```

**用途：** 快速判断某个文件夹下有多少直接子文件和子文件夹，不递归

**响应：** 同 `接口1`（列举文件列表），`entries` 为直接子文件，`commonPrefixes` 为直接子文件夹

---

## 四、错误码约定

| resultCode | HTTP Status | 说明 |
|------------|-------------|------|
| 1 | 200 | 成功 |
| 0 | 500 | 通用服务器错误 |
| 400 | 400 | 请求参数错误（如 key 格式非法） |
| 401 | 401 | 认证失败（API Key 无效） |
| 403 | 403 | 无权限（如 bucket 不存在或无访问权限） |
| 404 | 404 | 文件/文件夹不存在 |
| 409 | 409 | 冲突（如 overwrite=false 但文件已存在） |
| 429 | 429 | 请求频率超限（rate limit） |

---

## 五、可选接口（增强功能）

### 接口 7：获取预签名上传 URL

**用途：** 让客户端直接上传到存储服务，绕过中间代理

**请求：**
```
GET /presigned-put?key={key}&expiresIn={seconds}
```

**响应：**
```json
{
  "resultCode": 1,
  "data": {
    "uploadUrl": "https://storage.example.com/Obsidian/notes.md?signature=...",
    "expiresAt": 1746061200000
  }
}
```

### 接口 8：获取预签名下载 URL

**请求：**
```
GET /presigned-get?key={key}&expiresIn={seconds}
```

**响应：**
```json
{
  "resultCode": 1,
  "data": {
    "downloadUrl": "https://storage.example.com/Obsidian/notes.md?signature=...",
    "expiresAt": 1746061200000
  }
}
```

---

## 六、存储服务提供商适配清单

以下存储服务可直接适配本规范：

| 提供商 | 适配难度 | 备注 |
|--------|----------|------|
| 腾讯云 COS | 低 | 原生支持 S3 兼容 API，cos-python-sdk 完整 |
| 阿里云 OSS | 低 | S3 兼容 API，基本无需改造 |
| 华为云 OBS | 低 | S3 兼容 API |
| AWS S3 | 低 | 原生 S3，最完整支持 |
| MinIO | 低 | 自建 S3 兼容存储，部署灵活 |
| 任意 S3 兼容对象存储 | 低 | 同一套 SDK 覆盖 |

**S3 兼容 API 映射：**

| 本规范接口 | S3 API |
|------------|--------|
| 列举文件列表 | `ListObjectsV2` |
| 上传文件 | `PutObject` |
| 读取文件 | `GetObject` |
| 删除文件 | `DeleteObject` |
| 批量删除 | `DeleteObjects` |
| 预签名 URL | `PutObject` / `GetObject` + `Presigned` |

---

## 七、客户端同步逻辑（参考实现）

```
1. listFiles(prefix=targetFolder/, delimiter=/)
   → 获取云端文件列表 + 子文件夹列表

2. 对每个 commonPrefix 递归 listFiles
   → 构建完整目录树

3. 对比本地文件列表和云端文件列表
   → 计算差量（新增/更新/删除）

4. 对每个差量：
   上传: PUT /upload {key, content}
   下载: GET /download?key=xxx
   删除: DELETE /delete {key}

5. 每次操作后立即验证
   → PUT 成功后立即 GET 确认
   → 失败则重试（最多 3 次）
```

---

## 八、实现注意事项

### 时间戳
- `lastModified` 必须使用**毫秒级 Unix 时间戳**
- 不接受秒级时间戳或 ISO 8601 字符串

### 字符编码
- `key`（对象键）中的路径分隔符统一使用 `/`
- 文件名和路径必须使用 UTF-8 编码

### 文件大小
- 单文件大小上限：建议至少支持 **100MB**
- 超出上限时返回 413 Payload Too Large

### 目录模拟
- 存储服务本身没有"文件夹"概念，文件夹通过 `prefix` + `delimiter` 模拟
- 不允许创建空文件夹（文件夹在有文件时才存在）
