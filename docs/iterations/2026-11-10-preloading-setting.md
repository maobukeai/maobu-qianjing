# 页面预加载：工作区设置与可撤销应用

阶段 13 的产品接入。界面位于设置 → 网络与代理 → 页面预加载，选项为“保持浏览器默认 / 关闭预加载”。默认保留现状，保存仅改变工作区意图；下次 fresh launch 才处理持久化偏好，不更改正在运行或重新附着的浏览器。

## 最小接入范围

- `app-settings.ts`：`network.chromiumPreloading` 严格枚举 `browser-default | disabled`，旧文件缺少此字段时按默认解析、不重写原文件；partial patch 保留代理 preflight 等其它设置。不同 workspace 文件独立。
- `web/settings-api.ts`：兼容旧响应、严格拒绝未知值。新卡片 `web/chromium-preloading-settings.tsx` 只 PATCH 该叶子；有范围/性能说明，重复保存互斥，失败保留草稿，响应未确认所选值时不显示成功，没有浏览器操作或轮询。`web/settings-center.tsx` 只增加此卡片。
- `cli.ts`：把当前 workspace 的 settings getter 传入 Launcher。
- `launcher.ts`：健康 existing/reattach 路径在 getter 前返回；fresh 路径复用原有 executable verification、profile holder/stop 边界，等 cache cleanup 后、legacy corrupt-preferences repair 前调用新 helper。仅 verified managed Chromium155 可以新写 `2`；unsafe canary 不作为已验证 runtime。
- 其它已验证 Chromium 复用该目录时按 `browser-default` 撤销本产品已有 override，不把关闭策略带入 CloakBrowser；不存在记录时快速返回。当前公开 Store 已禁止 profile runtime 原地更换，另覆盖 restored/migrated legacy DB 的防御分支。Firefox 不应用此 Chromium 策略。

不新增 executable hash 或另一套授权体系，不更改 proxy preflight、全局网络、安全更新、TLS、沙箱或其它后台 flags。

## 偏好文件事务

独立 helper 为 `chromium-preloading-preferences.ts`。调用方负责已验证内核、停机证明和 profile 生命周期互斥，helper 只负责安全处理一个偏好叶子。

1. `browser-default` 且无本产品记录时不打开 Preferences、不创建目录，不因 legacy 损坏文件改变原先正常启动行为。
2. 首次写 `net.network_prediction_options=2` 前先原子保存 `.maobu-preloading-override.json` prepared 记录，保存原字段是否存在、原值及原 net 对象是否存在。Preferences 通过同目录独占临时文件、fsync、rename 替换，随后将记录标记 applied。没有删除整个浏览器配置文件。
3. 恢复只触碰这个叶子；浏览器后来增加的 net/顶层字段保留。只有原 net 不存在、恢复后 net 为空时才移除空 net，绝不把整个旧 net 对象写回来，也不一刀写默认 `1`。
4. 原本已为 `2` 的用户设置不被本产品认领。用户在应用后把该叶子改成其它值时保留手改；显式关闭模式拒绝声称已应用，并提示选择“保持浏览器默认”。默认模式清理本产品记录而不覆盖手改。
5. prepared-before-write、written-before-applied、restored-before-record-removal 都可以安全重试；损坏/不兼容 Preferences、损坏恢复记录、文件过大、路径越界、junction/symlink/hardlink、读写失败保留原文件并返回固定失败分类。每次替换前核对读取快照，减少并发修改被覆盖的机会；这不替代调用方的停机/lifecycle lock。

显式关闭或有待恢复记录时，helper 在 legacy `repairCorruptPrefs` 前拒绝损坏文件，避免新功能通过重置文件掩盖恢复失败。原有默认无记录路径仍保留原来的 legacy repair 行为。

## 验证

真实文件系统 helper 用例覆盖恢复 `0/1/3/null/false/string/object`、原本 `2` 不认领、保留新字段、只移除自己引入的空 net、损坏文件、超大记录、prepared 恢复窗口、后续手改和路径/link 边界。

Launcher 接入用例覆盖真实 HTTP settings PATCH → 下一次 fresh start 的文件结果、恢复原值、跨工作区/CSRF schema、坏文件在 legacy repair 前拒绝、无记录默认兼容、手改保护、155→另一已验证 Chromium 的撤销与失败拒绝，以及 healthy reattach 零 getter/零文件触碰。fake-spawner 用例仅 stub 原有 authority 边界并返回可证明未执行的 spawnFailed，未放宽生产 gate 或执行测试二进制。

界面 actual DOM 用例覆盖保存、旧服务响应、恢复默认、加载重试、保存失败、服务端未确认、同一 tick 双击互斥、卸载后晚回包；只保存所选字段，不打开/停止浏览器或增加轮询。

最终集中回归：**402 pass / 2 平台 skip / 0 fail，2207 assertions，16 文件，58.55 秒**，见[日志](../../node_modules/.cache/preloading-round13-regression.log)。包括两套 Launcher、Firefox、helper、QA 工具、workspace backup、feature settings HTTP/API 及新旧 settings 实际 DOM 交互。新增生产接入和 QA 源码严格 TypeScript 检查、Node 页面 helper 语法检查通过；三个 QA 文档本地链接均可解析。

## 当前 pinned Chromium 的真实验证

实际命令（单独 PowerShell 子进程，TEMP/TMP 指向该次新建缓存目录；不持久化环境变量）：

```powershell
$env:TEMP = '<project>\node_modules\.cache\preloading-setting-9b499ef4\temp'
$env:TMP = $env:TEMP
$env:MAOBU_ENGINE_QA = '1'
$env:ALIASMODE_PLAYWRIGHT_RUNTIME = ''
$env:ALIASMODE_SESSION_LAUNCH = '0'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
bun --no-env-file test engine-preloading-smoke.test.ts --timeout 120000
```

2026-11-10 北京时间 15:17:58–15:18:03，**1 pass / 39 assertions，4.719 秒**。[日志](../../node_modules/.cache/preloading-setting-9b499ef4/run.log)、[新证据](../../reports/network-background-qa/preloading-setting-UyFszI/evidence.json)。执行只使用原已验证 Chromium155 archive/executable，重新核对 release/manifest/pin；新建 synthetic profile/db/settings，严格认证 loopback proxy 只转发自有 origin，host resolver 拒绝外部目标。未启动真实用户环境、下载内核或修改系统设置。

- 原本保存的浏览器预加载值为 Extended `3`。workspace disabled 经新 production 接入启动后，浏览器 settingsPrivate 实际读回 `2`。
- 运行时把 workspace 保存为 browser-default，再 Open 返回同一 WS/PID，getter 与 preflight 仍各一次，实际读回仍为 `2`，证明没有改动 live session。
- 关闭后重新启动，实际读回原值 `3`、本产品 record 已移除，无关 net 字段保留；getter/preflight 累计各两次。
- 两次真实 Canvas/Audio 一致，当前 profile+launch provenance 匹配，重启 launch digest 改变，certifiedActive 通过，两记录 PID 已关闭。本次不把 workspace 意图加入旧 persona/proxy capture digest，也不宣称它是网络策略的运行时 attestation；实际预加载值在证据中单列。
- 另按本次自有 run 路径只读检查 Chromium 子进程，剩余为 0，见[进程复核](../../reports/network-background-qa/preloading-setting-UyFszI/post-run-process-check.json)。

流量减少证据和性能/适用边界见[前一轮三对 A/B](2026-11-10-background-network-ab.md)。这里验证生产设置能正确应用/恢复，不外推为零后台联网、DNS/WebRTC 防泄漏或所有第三方反检测通过。
