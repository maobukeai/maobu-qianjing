# 环境列表轮询性能记录

本轮目标是减少每三秒收到相同环境数据后，客户端重复解析、排序及建立搜索索引。记录来自本机隔离测试，使用合成数据，不包含真实账号、代理认证、Cookie 或会话。所有测试只访问内存桩或本机 loopback 服务。

## 未采用的通用深比较实验

最初尝试通过 `id`/`name` 匹配行，再比较全部 JSON 字段，为未变行和数组保留引用。实验保留未知字段，能识别 tags/extensions 深层变化、顺序变化、添加和删除，并对循环、异常、非 JSON 值和遍历上限回退。

完整的 31 字段环境数据包含 tags、extensions、导入检查嵌套结构及未知元数据；不是只有 id/name 的小对象。

| 环境数 | 相同快照比较 | 单行嵌套变化 | 完整重排 | 搜索索引重新建立 |
| --- | ---: | ---: | ---: | ---: |
| 10,000 | 111.1 ms | 109.9 ms | 105.9 ms | 22.6 ms |
| 50,000 | 573.7 ms | 548.0 ms | 530.4 ms | 116.9 ms |

两种规模均实际返回旧数组，未触发工作量上限。但即使采用不生成逐字段 descriptor 对象的防御检查，成本仍明显高于重建搜索索引，因此没有接入产品，也不计作已完成的性能优化。产品目录中的实验模块已移除；可复现实验留在 `node_modules/.cache/roster-snapshot-prototype-round6.ts`、对应测试及 `roster-snapshot-round6-tests.log`。

另测了几种属性检查方式：50,000 行直接比较约 138.8 ms、批量 descriptors 525.7 ms、getter 检查 258.6 ms。更快的直接比较不能提供同等 accessor 防御，未作为产品方案。

## 采用的条件 GET

服务端 `GET /ui/api/profiles` 继续执行现有请求来源保护、`reconcileOrphans()` 和完整数据映射，再将实际 JSON 响应序列化一次，并用 SHA-256 生成带引号的强 ETag。只有单个 `If-None-Match` 与该值完全相同才返回 304。200/304 保持 `Cache-Control: no-store`，304 不带响应体；错误不会冒充未变化结果。

客户端 `fetchProfiles()` 仅在当前 JavaScript document/module 内保留最近一次成功的 `{origin, etag, roster}`。key 为 `window.location.origin`（无浏览器环境的隔离测试使用 `local`），API 路径固定为 `/ui/api/profiles`。工作区切换产生新 document 时模块状态自然重置。没有 localStorage、IndexedDB、浏览器 HTTP 磁盘缓存或客户端全量 stringify。

- 手动请求使用 `cache: no-store`、`credentials: same-origin`、`redirect: error`。
- 有效强 ETag 才会用于下一次条件请求；旧服务端返回无 ETag 的 200 时清除旧 tag，继续兼容普通读取。
- 304 必须匹配发起请求时的缓存 tag 与响应 tag；无匹配内存快照、缺 tag 或 tag 不符时抛出固定错误，不伪造空列表，也不增加重试请求。
- 并发读取用递增请求序号保护最近成功提交。旧 200、304、解析完成或失败都不能覆盖较新成功快照；只允许返回最新的同源快照，绝不借用另一 origin 的缓存。
- 普通 304 返回原 `UiRoster`、profiles、groups、folders 引用，既有 React setter 可自然跳过相同引用。
- 数据变化仍返回完整 200；本方案没有承诺局部变化时逐行复用，也没有省略服务端健康检查和映射。

## 条件请求实测

客户端测试使用 31 字段的完整 JSON 数据，服务器表示在计时前准备好。下表衡量客户端响应读取/解析/映射及索引建立，不代表完整 HTTP 往返耗时。

| 环境数 | JSON 字节数 | 重复 200 读取/解析/映射 | 搜索索引 | 304 返回原引用 | 304 body 读取 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 9,187,486 | 28.6 ms | 26.0 ms | 0.146 ms | 0 |
| 50,000 | 46,051,562 | 133.9 ms | 115.4 ms | 0.059 ms | 0 |

独立服务端基准调用真实 `handleUiRequest` 映射/序列化/哈希，使用当前实际 25 字段投影和 folders 元数据。50,000 行 JSON 为 31,840,854 字节：200 约 85.8 ms，304 约 75.0 ms。两次都执行 reconciliation 和完整映射各一次。304 主要减少传输及客户端工作，服务端仍承担当前状态计算，不能把客户端 0.059 ms 宣称为端到端延迟。

测试入口为 `ui-roster-etag.test.ts`、`web/profile-roster-etag.test.ts`，客户端夹具为 `test-fixtures/profile-roster-etag-client.ts`。详细结果见 `node_modules/.cache/roster-conditional-get-round6-tests.log`。测试另覆盖运行/停止状态、tags/extensions、新增/删除、未知 folder 字段、强 tag 完整 body hash、错误保留最近成功快照、origin 隔离及乱序响应；真实 loopback 测试验证正确 tag 不能绕过外部 Origin/Referer/Sec-Fetch-Site 拒绝。

最终相关服务端/UI/API 与真实 App 创建、批量、快捷键、收藏视图合跑 9 个测试文件：180 通过、0 失败，TypeScript `--noEmit` 通过。日志为 `roster-conditional-get-round6-focused-tests.log` 和 `roster-conditional-get-round6-final-typecheck.log`。编辑器新增 dirty guard 的旧夹具断言另由其负责人更新，不用回退产品行为。

## 2026-11-23 的后续优化

桌面服务在完成运行状态核对后，会用 SQLite 的连接内写入计数、跨连接数据版本和 schema 版本判断列表是否变动。条件请求的标签与当前版本都匹配时，直接返回无响应体的 304。缓存仅保留版本和标签。版本变化时重新读取数据库快照，按实际 JSON 计算标签。读取期间发生的其他连接提交会使本次标签无法进入缓存。[SQLite 数据版本](https://www.sqlite.org/pragma.html#pragma_data_version) · [SQLite 写入计数](https://www.sqlite.org/c3ref/total_changes.html)

`bun test --no-env-file ui-roster-etag.test.ts` 可复现合成对照。在本机 50,000 条环境的测试中，未变列表的服务端处理耗时从约 72 毫秒降到 0.2 毫秒，命中后没有重新映射环境。数据来自合成夹具，运行状态核对使用桩服务，耗时不包含 HTTP 往返或真实浏览器进程探测。真正的 SQLite 双连接回归覆盖了读取期间和读取之后的外部提交。
