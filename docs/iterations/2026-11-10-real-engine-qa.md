# 2026-11-10 真实内核隔离验收

本轮针对当前源码重新运行五项真实内核测试：**5 pass、0 fail、202 次断言，29.82 秒**。运行时间为 2026-11-10 14:32:12–14:32:42（Asia/Shanghai），Bun 1.3.13，Windows x64。本轮没有下载或安装内核，没有启动用户环境、读取用户数据库或使用外部代理。

这里的“通过”只指下述合成本机测试范围，不代表所有指纹检测网站、公网 DNS/WebRTC 隔离或代理信誉已经通过。

## 资源和隔离范围

测试开始前只读计算了以下现有文件的 SHA-256，四者均与源码固定值匹配。测试还核对本地保留的 release JSON、checksum manifest 与 archive/executable pin，一致后才会启动内核。

| 资源（相对于 `reports/engine-qa/`） | SHA-256 |
| --- | --- |
| `aliasmode-chromium-155.0.8059.85-windows-x64/chrome.exe` | `0ef4de1bef7c12534031318e07ac89fa7942916a3abc89057985aafefbca619f` |
| `aliasmode-chromium-155.0.8059.85-windows-x64.zip` | `52ab2c6a616813bd95f5473fd73c492b7ee333ae4f0e57c4a366da956b2a7b8c` |
| `firefox-156.0.1-beta.36/aliasmode.exe` | `1a031ad448359f65b299634dd6fd0027c556f4c7807c2e0fb17f48a76fba7337` |
| `aliasmode-156.0.1-beta.36-win.x86_64.zip` | `23d2531f5a72dbfde049319259bcee55407a2ba7afc570398446da5c1f20cfcb` |

- 全部测试使用 headless 模式。Node worker 使用本机 `C:/Program Files/nodejs/node.exe` 与当前源码中的 Playwright/Firefox worker。
- 每项测试各自新建 `reports/engine-qa/run-*`，数据库为其中的 `synthetic.sqlite`，profile、runtime cache、独立 `app-settings.json` 与证据也在该测试目录内。
- `TEMP`/`TMP` 独立指向本轮新建的 `node_modules/.cache/engine-qa-20261110-a6f72c40/temp`。没有复用桌面应用的状态根目录。
- 服务端与认证代理均绑定 `127.0.0.1` 随机端口。代理只允许 `maobu-engine-qa.test:<该测试 origin 端口>`，实际转发目的地固定为自己的 `127.0.0.1`；其他目的地一律拒绝。
- 关闭 GeoIP 查询、账号自动导航与会话恢复；Firefox 使用 Windows persona 的本机字体，不下载字体包。没有设置 `unsafeDisableIdentityGates`，生产可执行文件 pin、所有权和 proxy preflight 检查继续生效。
- Chromium 的测试参数额外关闭后台联网/组件更新等，并限制 hostname resolver；Firefox 的测试偏好额外关闭预取、推测连接、captive portal/connectivity 探测及 TRR。因此本轮不是生产默认网络行为的完整验收。

## 实际命令和执行记录

工作目录为项目根目录。以下为本轮实际命令的环境参数展开；环境变量只在该 PowerShell 子进程内设置，并在 `finally` 中恢复原值。

```powershell
$env:TEMP = 'C:\Users\20269\Desktop\项目文件夹\猫步指纹浏览器\node_modules\.cache\engine-qa-20261110-a6f72c40\temp'
$env:TMP = $env:TEMP
$env:MAOBU_ENGINE_QA = '1'
$env:MAOBU_ENGINE_QA_REALM = '0'
$env:ALIASMODE_PLAYWRIGHT_RUNTIME = ''
$env:ALIASMODE_SESSION_LAUNCH = '0'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
bun --no-env-file test engine-smoke.test.ts engine-firefox-smoke.test.ts engine-firefox-cap-smoke.test.ts --timeout 180000
```

环境路径在实际调用中为解析后的绝对路径。运行前记录已有 `run-*` 名称；运行后只将新目录加入 manifest，并核验其绝对路径属于 `reports/engine-qa/`。本轮未执行目录删除，也未覆盖既有日志、证据或已验证 binary。

- 首次受限运行：[manifest](../../node_modules/.cache/engine-qa-20261110-41d08878/run-manifest.json)、[日志](../../node_modules/.cache/engine-qa-20261110-41d08878/tests.log)。14:31:17–14:31:21，0 pass、5 fail：四项在 loopback proxy preflight 处失败，Firefox cap 项在 owner ready 前报告 `process_spawn`。这些失败证据保留，不能记作通过。
- 随后自动审批允许在提升执行环境中使用相同隔离和保护参数重跑：[manifest](../../node_modules/.cache/engine-qa-20261110-a6f72c40/run-manifest.json)、[成功日志](../../node_modules/.cache/engine-qa-20261110-a6f72c40/tests.log)。结果 5 pass、0 fail；没有通过放宽身份或 preflight 检查解决首跑限制。

| 测试 | 耗时 | 本轮新证据 |
| --- | --- | --- |
| Firefox 156 高于主机的保存核数封顶 | 3.750 秒 | [run-firefox-cap-HMdG8t](../../reports/engine-qa/run-firefox-cap-HMdG8t/evidence.json) |
| Chromium 155 HTTP 认证、捕获与关闭 | 4.704 秒 | [run-http-5qW4ra](../../reports/engine-qa/run-http-5qW4ra/evidence.json) |
| Chromium 155 SOCKS5 认证、捕获与关闭 | 4.625 秒 | [run-socks5-1r6g75](../../reports/engine-qa/run-socks5-1r6g75/evidence.json) |
| Firefox 156 HTTP 认证、捕获与关闭 | 8.093 秒 | [run-firefox-http-OpbgjM](../../reports/engine-qa/run-firefox-http-OpbgjM/evidence.json) |
| Firefox 156 SOCKS5 认证、捕获与关闭 | 8.235 秒 | [run-firefox-socks5-ma4ugL](../../reports/engine-qa/run-firefox-socks5-ma4ugL/evidence.json) |

## 测到了什么

四项 transport case 每项实际执行三次启动 preflight；测试认证 HTTP/SOCKS5、本机页面加载与中文 POST 往返、真实语言/时区/屏幕/核数、Canvas/Audio 的 64 个十六进制字符（32 字节）SHA-256 摘要及同一身份重启稳定性。保存的 capture source 与当前配置、实际 launch 一致，重启后 launch digest 改变；错误认证的导航无法到达 origin，origin 没有收到 proxy authorization。

Firefox cap case 保留保存值及 launch persona 的 32 核，送入 worker、浏览器采样与页面实际值均为该主机可用的 20 核，质量报告的 hardware check 为 `pass`。测试共确认 20 个自有 browser/Firefox-owner PID 已关闭。

真实引擎测试覆盖了正向所有权证明及跨启动代次的 provenance；陈旧样本、缺来源、配置被修改、profile incarnation 更换、缺字段保持 unknown 等拒绝规则仍主要由相应单元/集成测试覆盖。四个 transport case 没有验证整个安全报告 API 的输出白名单，cap case 也只断言 hardware check，不能据此声称每个质量检查都在实机通过。

## 非自有目标尝试与结论边界

两个 Chromium case 的代理记录分别包含 **36 / 33 次非自有 origin 目的地尝试**，均由 fixture 拒绝，没有被代理转发到外部。该字段在证据中名为 `blockedExternal`，其中也包含 synthetic `.invalid` 目标，不能把这个数字直接等同于公网泄漏次数。

| 非自有 origin hostname | Chromium HTTP | Chromium SOCKS5 |
| --- | ---: | ---: |
| `clients2.google.com` | 2 | 2 |
| `www.google.com` | 24 | 21 |
| `update.googleapis.com` | 2 | 2 |
| `accounts.google.com` | 2 | 2 |
| `fingerprint.aliasmode.invalid`（本项目合成探测地址） | 6 | 6 |

因此只能确认本机代理 fixture 严格拒绝了这些目的地，不能称浏览器“零联网尝试”。这些记录是代理所见的 hostname/port，没有 DNS resolver 或 UDP packet 观测，不能据此判断 DNS 泄漏。Firefox 两个 transport case 的同一计数为 0。

本轮没有测试公网出口/IP 信誉、真实代理供应商、远端 DNS、STUN/WebRTC 外泄、跨机器指纹熵/唯一性、真实账号登录、原生窗口交互或第三方反检测网站结论。`proxy-live.test.ts` 与自动填充浏览器测试没有启用。

另外，全仓常规回归的 32 skip 并非 32 项真实指纹验收：其中为上述 5 项本机 engine QA、4 项外部 proxy-live、1 项 autofill-browser、19 项 Windows 上跳过的 Bun-as-Node worker 用例及 3 项其他 OS 分支。
