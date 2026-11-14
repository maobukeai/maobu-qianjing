# Chromium 155 后台联网：隔离测量与预加载 A/B

2026-11-10，已验证的本地 managed Chromium `155.0.8059.85-aliasmode.5`，headless。**三对交错实验均减少了代理可见的 Google 目标尝试，但没有证明零后台联网、DNS 防泄漏、实际公网性能提升或第三方反检测通过。生产 launcher、网络默认策略和已有证据未修改。**

## 工具与运行边界

- 新工具：[qa-network-background.ts](../../scripts/qa-network-background.ts)，只使用 `reports/engine-qa/` 已有的 Chromium155 executable/archive。先核对 release JSON、checksum manifest 及源码 archive/executable SHA-256；不接受任意 binary/output/浏览器 flags，不下载/安装。
- 每次新建 `reports/network-background-qa/run-*`，每个 arm/pair 单独 synthetic SQLite、profile、runtime、app-settings，TEMP/TMP 也在本轮新目录内。没有读取应用真实环境、账号或用户浏览器数据，没有删除目录或修改已验证 binary。
- 严格认证 HTTP proxy 只绑定 `127.0.0.1`，唯一允许目的地为自己创建的 `maobu-engine-qa.test:<随机端口>`，上游固定转发到自己的 `127.0.0.1`。其他 hostname/port 全部拒绝，不调用外部代理；共同 hostname resolver 拒绝非 loopback 解析。
- 保留生产 pin/identity/ownership gate 和两次真实 proxy preflight。关闭账号自动导航、会话恢复及 GeoIP lookup。没有给主测量加 `--disable-background-networking` / `--disable-component-update` 等功能抑制 flags，避免掩盖候选效果。
- NetLog 省略 capture-mode 参数，采用 Chromium 默认的 Strip private information，未启用 IncludeSensitive/Everything。共同参数为 `--log-net-log=<每个trial自己的文件>`、`--net-log-max-size-mb=8`、`--net-log-duration=30`；读取前另检查 12 MiB 上限。默认剥离并非“日志没有任何环境信息”，因此本工具只在全合成测试环境启用。上述日志大小/时长能力有 [Chromium 官方说明](https://www.chromium.org/for-testers/providing-network-details/)。
- 默认 3 对、每次固定 10 秒，从 `Launcher.start` 前开始，覆盖原有 fingerprint capture、自有 settings readback、自有页面及 idle。工具允许 3–5 对、5–15 秒；页面 helper 25 秒硬超时，CDP ready 15 秒、capture 8 秒请求超时，日志自己在 30 秒停止。启动/验证超过观察窗会记失败，不能拿不等长窗口比较。
- 每次 `finally` 都经原有 Launcher 所有权检查关闭自己的 profile，杀掉未结束的页面 helper，关闭自有代理/origin；保留全部证据。错误认证验证使用无 NetLog 参数的独立 Launcher，防止第二次启动覆盖主测量日志。

## 唯一候选与实际命令

Baseline 写入全新空 Preferences，保留内核原生默认。候选只增加 `net.network_prediction_options=2`，其他参数/身份保持等价。值 `2` 是持久化 NetworkPredictionOptions 的 Disabled；不要与另一种 PreloadPagesState 枚举的编号混淆。[官方枚举](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/preloading/preloading_prefs.h)、[读取/设置实现](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/preloading/preloading_prefs.cc) 与 [NetworkPredictionOptions policy](https://raw.githubusercontent.com/chromium/chromium/main/components/policy/resources/templates/policy_definitions/Miscellaneous/NetworkPredictionOptions.yaml) 说明它影响预取、预连接和预渲染。官方 main 源码用于机制核对，实际 pinned fork 是否应用偏好由浏览器运行时读回确认。

两组都打开自己的 `chrome://settings/privacy`，通过 settingsPrivate 读取该 key；六次实际读回为 baseline `1`、candidate `2`。没有只凭磁盘 JSON 声称已应用。正常页面只访问自有 origin，验证中文 POST、Cookie、语言、时区、屏幕与核数。

```powershell
bun --no-env-file scripts/qa-network-background.ts
bun --no-env-file test scripts/qa-network-background.test.ts
```

实际执行顺序为 B1/C1、C2/B2、B3/C3，反转中间配对以暴露次序影响。命令仅在自动审批允许的提升执行环境运行，未绕过 preflight 或身份保护；前一次普通 engine QA 在受限沙箱失败的记录仍保留于[此前报告](2026-11-10-real-engine-qa.md)。本次没有将那次沙箱失败混入 A/B 样本。

本次运行：北京时间 **14:55:58–14:57:12，约 74.4 秒**。[总 manifest](../../reports/network-background-qa/run-UQAcKD/manifest.json)、[命令日志](../../node_modules/.cache/network-background-9f8aed9e/run.log)。每个 trial 的 `network.json` 是原始默认剥离 NetLog；`evidence.json` 提供不复制 URL query、header、凭据、Cookie 的分类摘要、source ID、事件类型、相对时间和代理阶段。

## 实测结果

这里的“Google 尝试”是观察窗内 **严格代理收到的目标连接/请求次数**，含预连接/重试，不能等同唯一 HTTP 请求数、外部成功请求数或 DNS 查询数。NetLog 的 URL-bearing source 也包含 HTTP stream job 和 CORS source，不可与代理次数相加或等同。

| Pair | Arm / 实际偏好 | Google 目标尝试 | 合成探测目标代理尝试 | 启动至 capture ready | 本机页面导航 | NetLog bytes | 证据 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | baseline / 1 | 20 | 3 | 1008 ms | 38.5 ms | 360660 | [B1](../../reports/network-background-qa/run-UQAcKD/pair-1-baseline/evidence.json) |
| 1 | no-preloading / 2 | 15 | 0 | 1605 ms | 42.5 ms | 295769 | [C1](../../reports/network-background-qa/run-UQAcKD/pair-1-no-preloading/evidence.json) |
| 2 | baseline / 1 | 20 | 3 | 1031 ms | 32.7 ms | 360661 | [B2](../../reports/network-background-qa/run-UQAcKD/pair-2-baseline/evidence.json) |
| 2 | no-preloading / 2 | 15 | 0 | 1052 ms | 31.1 ms | 296727 | [C2](../../reports/network-background-qa/run-UQAcKD/pair-2-no-preloading/evidence.json) |
| 3 | baseline / 1 | 22 | 3 | 925 ms | 31.9 ms | 369650 | [B3](../../reports/network-background-qa/run-UQAcKD/pair-3-baseline/evidence.json) |
| 3 | no-preloading / 2 | 15 | 0 | 1024 ms | 44.6 ms | 296727 | [C3](../../reports/network-background-qa/run-UQAcKD/pair-3-no-preloading/evidence.json) |

观察窗实际为 10002–10018 ms。三对 Google 次数变化为 **-5/-5/-7**，总量 62→45（本样本减少 27.4%），中位数 20→15。全部减少来自 `www.google.com`（三次合计 44→27）；其他 Google hostname 计数不变。每次自有 origin 只转发三次；所有非自有目的地均被拒绝。

六次 Canvas、Audio SHA-256 一致，真实 `fpObserved` 的语言/时区/屏幕/核数符合设置，capture source 等于当前 profile+launch 的生产 provenance，certifiedActive 通过。合成探测代理尝试由 3→0 时，NetLog 仍包含 `fingerprint.aliasmode.invalid` 的本地捕获事件，真实采样仍成功：这与关闭额外预连接相符，**不能解释成关闭了指纹验收**。

六次错误代理凭据均让导航失败，origin 新请求数为零；正常 origin 从未收到 Proxy-Authorization。12 个记录的自有根 PID 均已关闭。随后按六个自有 profile 的共同 run 路径筛选 Chromium 进程，剩余为 0，见[只读复核](../../reports/network-background-qa/run-UQAcKD/post-run-process-check.json)。

启动中位数 baseline 1008 ms、candidate 1052 ms；本机导航中位数 32.7 ms、candidate 42.5 ms。样本小且只有 loopback，不能把差异归因为预加载，亦不能声称性能提升。真实网络点击导航可能失去预连接/预取的加速；这项功能的合理定位是减少推测联网与潜在流量的可选权衡。

## Google 候选请求归因

对本轮合成 NetLog 只检查 hostname + 固定 path 分类，不导出 query/header/body。以下官方源码用于候选归因，不能替代完整调用栈或同一 pinned fork 源码审计。

| 实际 hostname/path | 与官方实现的对应关系 |
| --- | --- |
| `clients2.google.com/time/1/current` | [NetworkTimeTracker](https://raw.githubusercontent.com/chromium/chromium/main/components/network_time/network_time_tracker.cc) 的时间查询 endpoint，与此前仅看到 80 端口的推测相比，证据更具体。 |
| `update.googleapis.com/service/update2/json` | [组件 updater 默认 endpoint](https://raw.githubusercontent.com/chromium/chromium/main/components/component_updater/component_updater_url_constants.cc)。不是本项目 GitHub 应用更新请求。 |
| `accounts.google.com/ListAccounts` | [GAIA endpoint](https://raw.githubusercontent.com/chromium/chromium/main/google_apis/gaia/gaia_urls.cc)，本轮没有登录/自动导航；不能据此认定存在真实账号。 |
| `www.google.com/complete/search` | [搜索建议 policy](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/components/policy/resources/templates/policy_definitions/DefaultSearchProvider/DefaultSearchProviderSuggestURL.yaml) 对应建议 endpoint。本轮没有人工输入查询；没有保留 query 作为对外证据。 |
| `www.google.com/async/newtab_ogb` | [OneGoogleBarLoader](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/new_tab_page/one_google_bar/one_google_bar_loader_impl.cc) 的新标签页 Google bar endpoint。 |
| `www.google.com/async/ddljson` | [Google logo/Doodle 实现](https://raw.githubusercontent.com/chromium/chromium/main/components/search_provider_logos/google_logo_api.cc) 处理对应 Doodle 数据；仍按候选归因。 |
| `www.google.com/async/folae` | [AI Mode eligibility service](https://raw.githubusercontent.com/chromium/chromium/main/components/omnibox/browser/aim_eligibility_service.cc) 直接声明该 endpoint 及 startup/profile-state/周期性触发；它是 Chromium 自身搜索功能，和本项目 AI workbench/MCP 请求不同。 |
| `android.clients.google.com/checkin` | [GCM settings](https://raw.githubusercontent.com/chromium/chromium/main/google_apis/gcm/engine/gservices_settings.cc) 的默认 checkin endpoint。本轮各 arm 每次一次。 |
| `www.google.com/` | 仅有 path 和 stream/cors 事件仍不足以精确归因，保留 unattributed。 |
| `fingerprint.aliasmode.invalid` | 本项目 `playwright-worker.mjs` 的专用合成验收 URL，由 owned target 的 Fetch interception 在本地 fulfill。逻辑 URL 和预连接尝试不等于外网转发。 |

上游 Chromium 的 [GCM startup issue](https://issues.chromium.org/issues/566157929) 也记录了 fresh signed-out profile 在 155 的 checkin 行为；这支持继续跟踪已验证 runtime 更新，不意味着当前 pinned fork 已包含某个修复。

## 产品可提供的选项与后续边界

建议独立配置 **“页面预加载：保持浏览器默认 / 关闭预加载”**，默认保持当前行为。说明：关闭后减少预取、预连接和预渲染；部分页面打开可能变慢，不阻止页面自身联网、扩展、账号服务、组件更新等。仅对已验证 managed Chromium155 提供适用承诺；Firefox/Cloak 未做此项 A/B，不自动套同一偏好。

只在下次启动、确认 profile 未运行时应用。恢复“默认”须恢复/移除本产品自己管理的 override、保留用户先前值，不应一刀写 `1`。Preferences 或管理 sidecar 损坏、路径越界/junction、写入失败要保守报告并保留文件；两文件更新需要可恢复的 write-ahead 记录和原子替换。运行时偏好读回应作为单独的实际应用证据，因为现有 fingerprint configuration digest 尚未包含此项 workspace policy；后续接入不能把旧 capture 当作新网络配置已经应用。

不添加随机 flags，不为降低计数关闭 TLS/沙箱/安全组件更新，不放松 proxy preflight。后续若验证其他开关，应一次只改一个配置，重复同样的身份、错误认证和关闭检查；本轮结果不外推到长时间运行、真实网页、外部 DNS、UDP/STUN/WebRTC、公网 IP 或反检测网站。

工具纯逻辑测试 **8 pass / 60 assertions**，覆盖数量/时长限制、路径边界、单一候选、有界默认剥离参数、敏感字段不进入摘要、损坏/过大日志不冒充零请求、不完整/重复/失败配对不能宣称收益。页面 helper 语法与新增 TS 严格类型检查通过。
