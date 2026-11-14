# 猫步·千境产品迭代调研

核验日期：2026-11-09（Asia/Shanghai）。以下以产品官方帮助中心、官方发布说明和协议文档为依据；功能存在不代表本机已经实现，也不作为排名或隐私保证。

## 同类产品的可借鉴能力

| 产品 | 官方证据 | 对猫步的启发 |
| --- | --- | --- |
| AdsPower | 全局设置支持选择同步数据类型，关闭环境后同步；还提供代理可用性、地域变更、扩展数据加载的启动条件。[Global Settings](https://help.adspower.com/docs/global_settings) | 同步必须呈现保存状态、冲突和失败原因；启动前检查应可配置，避免无提示直连。 |
| AdsPower | MCP 页面描述将 AI 与本机浏览器自动化连接；AI Agent 文档介绍 MCP/Skills 接入。[MCP](https://help.adspower.com/docs/MCP)、[AI Agent](https://help.adspower.com/docs/AI-Agent-Feature-Usage-Guide) | 先把已有本地 MCP 做成可复制、可诊断、可发现的入口，再考虑内置模型工作台。 |
| Multilogin | API 文档集中提供 CLI、脚本运行器、Playwright/Selenium/Puppeteer 和 AI 集成入口。[API](https://multilogin.com/help/en_US/api) | GUI 操作与自动化应共享校验、错误语义和能力目录，减少“界面能做、脚本不能做”的差异。 |
| Multilogin | `auto_update_core` 控制内核自动更新，也支持选定受支持的版本。[Core updates API](https://multilogin.com/help/en_US/script-runner-predefined-scripts/how-to-control-core-updates-via-api) | 将桌面版本更新与浏览器内核更新分开；记录当前版本、可用版本和变更，保留可解释的固定版本策略。 |
| GoLogin | 官方 MCP 面向环境创建、启动、停止与 AI 客户端连接。[Browser MCP](https://gologin.com/mcp/) | 把环境管理和页面操作分为明确能力；选择环境后再使用内核实际支持的页面工具。 |
| GoLogin | 2026 年 10 月发布说明包含默认代理设置、设置重置、禁止媒体加载和云环境 API。[October update](https://gologin.com/blog/gologin-in-october/) | 环境模板、恢复默认、带宽控制和清晰的默认值，比增加大量分散开关更优先。 |
| Dolphin Anty | 官方说明列出本地/云同步、同步操作、流程场景、批量操作和回收站。[Feature update](https://dolphin-anty.com/blog/en/free-plan-updates/) | 区分“环境数据同步”和“多个窗口同步操作”；以已有本地备份、批处理和回收站为起点逐步迭代。 |
| Kameleo | 发布说明提供事先安装环境内核的 SDK 方法，以及 Chroma 的实时指纹观察；开发者文档区分自动启动和显式启动，并提醒使用与内核匹配的 Playwright。[Release notes](https://kameleo.io/release-notes)、[Playwright](https://developer.kameleo.io/integrations/playwright/) | 内核清单下一步可提供用户主动下载及摘要复核；实时观察继续区分窗口采样、worker 采样、过期证据和未知项。 |
| MoreLogin | 窗口同步器支持选择参与窗口、停止和快捷键；本地 API 提供批量修改环境代理。[Browser Synchronizer](https://support.morelogin.com/en/articles/10137626-browser-synchronizer)、[Batch proxy API](https://guide.morelogin.com/api-reference/browser/local-api/profiles/setbrowserproxiesbatchlocal) | 批量操作优先提供影响范围和逐项结果；若加入窗口同步，应有清晰参与范围和立即停止。 |
| Incogniton | 代理管理支持文本和文件批量导入、分组及连通检查；入门文档另外列出内置共享代理和自带代理两种来源。[Integrating proxies](https://docs.incogniton.com/proxy-management/integrating-proxies)、[First profile](https://docs.incogniton.com/getting-started/create-your-first-browser-profile) | 用来源、证据和验证时间区分代理；共享代理仍需单独核对其用途、运营方和适用范围。 |
| Undetectable | 区分本地与云环境，文档描述自有服务器选项；环境管理器支持批量设置代理和存储迁移。[Creating and Launching](https://docs.undetectable.io/working-with-profiles/create-and-run/)、[Profile Manager](https://docs.undetectable.io/mass-management/profile-manager/) | 从现有加密快照向设备传输演进时，应先完善可预览的差异、冲突和恢复记录。 |

## 迭代顺序与验收要求

| 优先级 | 目标 | 最小完整验收 |
| --- | --- | --- |
| P0 | 设置中心分组：通用、更新、同步、网络、AI/MCP | 有真实读取/保存状态、加载/失败/空态；键盘可访问；窄窗口不横向溢出；深浅主题可读。 |
| P0 | GitHub Releases 更新检查 | owner/repo/channel 可配置；语义版本比较；有超时、缓存和限流说明；只接受预期 GitHub 链接；检查结果不等同于已安装。 |
| P0 | 本地 MCP 接入说明与资源检查 | 检查 helper、sidecar、Node 和协议模块；输出 JSON/TOML；明确客户端握手未验证；不输出 runtime nonce 或 CDP 地址。 |
| P0 | 本机桌面代理发现 | 只检查回环地址和受限端口；区分监听端口、协议识别和真实出口；不修改系统代理。 |
| P0 | 指纹质量报告 | 明确区分配置一致性、实测一致性和未知项；每项有证据与改善建议；不把未测项目显示为通过。 |
| P1 | 加密便携备份与同步目录 | 先输出完整可恢复的加密快照；校验版本/完整性；同源冲突可预览；恢复前备份；运行中的环境不能被覆盖。 |
| P1 | 安全的自动安装更新 | 自有发布仓库、稳定版本策略、签名验证与升级失败恢复齐备后，才启用自动替换安装。GitHub 下载和哈希不能单独证明发布者身份。 |
| P1 | 环境模板与启动前检查 | 模板能预览差异；设置代理后可选择刷新地域配置；失败提示给出具体项与重试，不回退直连。 |
| P1 | 任务运行与审计体验 | 本地脚本/智能体有任务状态、停止入口、错误、日志脱敏、使用的环境与实际工具能力。 |
| P2 | 内置模型工作台 | 用户配置提供商、模型与密钥后才联网；有流式响应、工具执行记录、取消和用量信息；不能用静态演示冒充已连接 AI。 |

上述优先级是本项目的工程判断，不是供应商的推荐。第一轮先实现独立模块，再接入真实设置页并做集成验收。

后续优先验证三个可度量的工作流：为受支持内核主动下载并核验固定哈希；用同一环境重复验证代理、区分稳定出口与轮换并标注未测项；允许用户从 AI 草案选择有限的本地动作并逐项预览、停止和追溯。所需基础已分别接入 [内核清单、代理检查与 MCP](../development-progress.md)，上述扩展仍在路线图中。

## 第一轮 AI/MCP 接入模块

`agent/integration-info.ts` 的 `getIntegrationInfo()` 是只读资源检查和配置生成器。它不启动进程、不修改第三方客户端，也不读取 `agent-runtime.json`。`status=ready` 只表示所需文件存在且父进程报告桌面服务就绪；`connectionVerified=false` 始终明确客户端握手未被此接口实测。

`agent/integration-probe.ts` 的 `probeMcpIntegration()` 用于显式连接检查：只在桌面和资源就绪时启动本机 helper，执行 MCP 初始化与工具列表读取，验证服务名称、版本和环境列表工具后关闭连接。它不调用工具；默认总超时 15 秒（最高 30 秒），工具分页和总数均受限，原始子进程错误不会返回 UI。

- 配置类型：通用 `mcpServers` JSON（Claude Desktop / Cursor）、Codex TOML、VS Code `servers` JSON。
- Codex 使用 `mcp_servers.aliasmode`、`command`、`args`；180 秒启动超时对应本项目桌面发现等待时间。[OpenAI Docs：MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- JSON 配置结构依据官方 MCP SDK 的宿主连接说明与 VS Code 配置说明。[MCP hosts](https://py.sdk.modelcontextprotocol.io/get-started/real-host/)、[VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- 工具名和注解来自仓库生成的 `docs/public/mcp-tools/current-source.json`，保持与当前源码目录一致。
- Firefox 与 Chromium 共同提供环境管理和基础页面操作；CDP/PDF 只列为 Chromium 能力。

## 可展示的官方代理资源

这些资源用于了解协议、会话与接入方式。产品不能从供应商名称、一次连通检查或一份地理数据就声称 IP“纯净”、稳定可用或不可关联；也没有自动购买、注册或导入未知公共代理。

| 资源 | 已核实能力 | 适合 UI 的说明 |
| --- | --- | --- |
| [Mihomo proxy ports](https://wiki.metacubex.one/en/config/inbound/port/) | 分别配置 HTTP(S)、SOCKS 与同时接受两类协议的 mixed 监听端口。 | 桌面代理接入：查看本机客户端端口，并在猫步中检查协议与出口。文档示例端口不代表用户实际配置。 |
| [Bright Data proxy infrastructure](https://docs.brightdata.com/left-over/proxy-networks-introduction) | 住宅、ISP、数据中心代理类别及会话/地理定位控制；提供 Proxy Manager。 | 代理类型与管理文档：选择前了解地址类别和会话策略。 |
| [Oxylabs supported protocols](https://developers.oxylabs.io/help-center/products-and-features/supported-protocols) | 按代理产品列出 HTTP、HTTPS、SOCKS5 等协议支持。 | 协议与产品文档：按购买产品核对可用协议及认证方式。 |
| [Oxylabs session control](https://developers.oxylabs.io/help-center/products-and-features/how-to-use-session-control) | 通过认证串的会话参数保持请求使用同一会话，具体支持随产品不同。 | 会话控制：使用现有代理凭据规划粘性或轮换策略。 |
| [Decodo session types](https://help.decodo.com/docs/residential-proxy-session-types) | 住宅代理提供粘性会话与按请求轮换会话。 | 会话策略文档：先选固定会话或轮换，再验证实际出口。 |
| [Tor Project：network speed](https://support.torproject.org/tor-browser/general/tor-browser-speed/) | Tor 通过多处中继转发流量，网络负载与路径可能增加延迟。 | 了解 Tor 的网络特点；不要把普通浏览器接入 SOCKS 端口描述为获得完整 Tor Browser 隐私特性。 |

UI 链接使用明确名称、外部链接提示与 `rel="noopener noreferrer"`；不展示价格、优惠和供应商背书。后续可增加用户自行配置的供应商入口，而不捆绑推广或共享凭据。

## 已发现的后续工程缺口

1. 已修复 `agent/setup.ts` 在添加 MCP 配置前先删除旧项的缺陷。现在直接使用客户端原生 add/upsert；若客户端拒绝同名项则报告失败，并保留供手动核对的配置，不会预先删除工作中的项。后续可针对客户端支持的原子更新接口提供更完整的配置差异预览。
2. 现有 MCP 的浏览器工具受选择环境和内核影响。设置页不应仅用固定数字概括“全部功能可用”；客户端列表才是当前会话的真实工具集。
3. 备份与数据同步需要区分操作系统保护的秘密和可跨设备恢复的数据；在明确密码学与恢复格式前，不能直接复制运行中的 SQLite 文件作为同步。
4. 指纹一致性检查应同时展示采样时间、实际内核、预期值和观察值，并在修改配置后标注报告过期。
