# 知识库 Open API 调用问题 — 401 Token校验失败

## 问题描述

调用知识库 Open API 接口时，使用 `appKey` Header 认证，所有接口均返回 `401 Token校验失败`。

## 环境信息

- API Base URL: `https://sg-al-cwork-web.mediportal.com.cn/open-api/`
- appKey: `TsFhRR7OywNULeHPqudePf85STc4EpHI`
- 调用方: Evan 团队（Obsidian 同步插件开发）
- 日期: 2026-04-30

## 复现步骤

```bash
# 任意接口均返回相同错误
curl -H "appKey: TsFhRR7OywNULeHPqudePf85STc4EpHI" \
  "https://sg-al-cwork-web.mediportal.com.cn/open-api/document-database/project/personal/getProjectId"
```

## 实际返回

```json
{"resultCode":401,"resultMsg":"Token校验失败"}
```

HTTP 状态码为 200，业务码为 401。

## 已验证的事实

1. **API 路径正确** — 错误路径（如 `/open-api/not-exist`）返回 `no permission`，正确路径返回 `Token校验失败`，说明请求到达了知识库服务
2. **appKey 100% 有效** — 该 Key 在其他场景正常使用，不存在过期问题
3. **多种 Header 组合均失败**:
   - 只传 `appKey` → 401
   - `appKey` + `Content-Type: application/json` → 401
   - `access-token` 用 appKey 的值 → 401
   - 两个都传 → 401
4. **响应头**: server: openresty，CORS 完全开放（`access-control-allow-headers: *`）
5. **所有接口表现一致**: personalProjectId、projectList、getChildFiles、uploadContent 均 401

## 疑问

1. 文档（2.3 节）说只需在 Header 传 `appKey`，但错误信息是 `Token校验失败`，不是 `appKey无效`。请问是否需要额外的 Token 认证？
2. 错误码表中 `610002` = `appKey 无效`，但实际返回的是 `401` + `Token校验失败`，这两者的关系是什么？
3. 是否需要先用 `appKey` 换取 `access-token`，再用 `access-token` 调用知识库接口？

## 期望

请确认知识库 Open API 的完整认证流程，以及该 appKey 是否需要额外配置才能调用知识库接口。
