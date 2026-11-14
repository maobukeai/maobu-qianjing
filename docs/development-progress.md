# 持续迭代记录

更新日期：2026-11-09（Asia/Shanghai）。本文记录这一轮的实现、可复查的验证节点和未验收范围。竞品对照以功能及公开文档为依据。

## 当前源码能力

| 功能 | 已实现内容与边界 |
| --- | --- |
| 本地 AI 工作台 | 独立导航页，通过 Ollama 本地 API 读取模型、真实生成问答、计划和脚本草稿；构造服务和打开页面不请求模型，不自动安装、拉模型、运行脚本或调用工具。对话仅在界面会话中保留。 |
| 匿名 AI 上下文 | 默认关闭；显式开启后只追加环境、运行状态、引擎、代理配置和匿名分组计数。默认路径不读取工作区概览；账户、Cookie、真实名称和控制地址均不发送。 |
| AI 取消 | 浏览器 AbortSignal 与显式 UUID 取消接口并用；只能取消同一 ProfileStore 的请求，重复活动 ID 拒绝，结束后释放 ID 和生成锁。取消恢复草稿，无法确认取消时显示错误。 |
| 命令面板 | Ctrl / ⌘ + K 打开、搜索、方向键和 Enter 执行、Esc 关闭；可跳转页面、打开设置或触发常用环境操作，避免抢占输入法及已有对话框。 |
| 新建环境预设 | 最多 100 项，仅保存浏览器、内核、操作系统、屏幕和平台五项配置；差异预览后显式应用，保留其他草稿输入，再由现有创建流程生成新的 ID 和指纹身份。提供 CRUD、版本冲突保护与备份恢复校验；Auto 意图与强制内核策略分开，创建中阻止关闭和重复提交。 |
| 编辑环境 | 完整详情成功加载后才允许保存。加载失败可重试，同一环境关闭重开也会丢弃旧响应；保存中的重复点击、关闭和 Escape 均被阻止。保存失败保留草稿。 |
| 桌面代理检查 | 支持 IPv4/IPv6 回环与最多 16 个自定义端口；输入通过校验后才探测。区分 TCP 监听、SOCKS5 握手及单独触发的出口验证，提供官方代理资源链接。 |
| 从代理结果新建环境 | 将指定协议、回环地址与端口填入现有的新建草稿，凭据留空。说明监听、SOCKS5 协商或认证要求，端点改变时清除该说明；打开草稿不验证出口、启动或保存。取消后保留发现结果并恢复焦点。 |
| 本机代理启动前检查 | 已实现并接入源码，默认关闭；每次新启动前只检查环境已配置的回环端口，800 毫秒预算，HTTP(S) TCP 监听和 SOCKS5 方法协商，不发凭据、CONNECT 或外网请求。同端点仅合并进行中的检查，完成后不缓存；远程、直连和已认证现有实例保持原行为。 |
| 明确网络路由 | 独立 HTTP/HTTPS/SOCKS 传输与回环 JSON 传输，不依赖全局 fetch 或 HTTP_PROXY/NO_PROXY；失败不转直连，TLS 验证保持启用。系统 VPN/TUN 仍可影响系统路由。 |
| 指纹检查 | 配置一致性、既有样本质量及运行中浏览器显式重采样；检查浏览器与环境身份，拒绝过期、空或失败样本覆盖有效记录，显示待重启状态。中英质量文案、安全证据对照和仅关注项筛选已接入；未知项目不计通过。 |
| 报告编辑与历史对照 | 报告直接打开选中的环境编辑器；保存刷新离线报告并保留选择、筛选及键盘操作位置。选中环境已删除时允许改选，避免编辑到其他环境。列表的历史导入徽标仅显示计数、安全字段名与合法时间；异常旧数据按缺失处理，保留原始存储。 |
| 报告说明草稿 | 将有限的检查类别、状态和计数带到本地 AI 工作台，预览后显式追加到当前草稿，不包含名称、ID、原始样本或实际配置值；只在手动发送时调用模型。 |
| GitHub 版本浏览 | 用户指定仓库、稳定/测试频道、启动检查开关；变更仓库后旧结果失效。启动检查只查 GitHub 列表，不自动安装。 |
| 原生签名更新 | 官方 Tauri updater，构建期固定公钥和 HTTPS 来源、限定 IPC。工作区可开启启动后一次检查，发现版本在当前页提醒并直达更新设置；由用户选择安装，验签后才关闭会话并启动安装。未配置发布者时禁用，备份恢复到新工作区后须重新开启启动检查。另有离线验签和手动草稿发布流程。 |
| 加密文件夹快照 | AES-256-GCM + scrypt、历史保留、脱敏预览和事务导入；默认跳过现有、回收站及运行中环境。仅配置、账户、Cookie 和已保存便携会话，不复制运行中浏览器目录、扩展安装文件或脚本库。 |
| 完整工作区备份 | 包括数据库、浏览器存储、扩展、脚本、app-settings.json 和严格校验的环境预设；恢复到新工作区。备份包本身不加密；恢复时禁用文件夹同步并保留原路径待核对，避免自动写入旧设备路径。 |
| MCP 接入 | 客户端配置生成、资源检查、限时握手和工具目录诊断；目录现有 12 项工具，含只读离线指纹报告与受限 loopback 发现。报告不探测进程存活；发现不检查外网出口。注册失败保留原客户端配置，生成配置与实际调用工具分别呈现。 |
| 设置与外链交互 | 切换设置页签回到内容顶部；外部文档及发布页经来源校验和 HTTPS 目标白名单的原生命令处理，不提供任意命令/本地文件打开能力。Chrome 中的外链桥接为模拟，Rust 验证允许/拒绝规则，尚未验收真实 OS 浏览器启动。 |
| 设置失败恢复 | 更新历史与仓库配置独立读取，重试历史不会覆盖编辑中的草稿；更新与同步设置首次失败可在当前页面重试，切页后旧响应不再触发后续操作。 |
| 浏览器内核清单 | 在应用更新页展示固定版本、主机支持及默认策略。首次读取不访问缓存；手动刷新只读固定路径，发现文件标为未校验。外部配置显示来源与版本未测。 |
| 下载可靠性 | Python 和 Firefox 字体共用有界续传，校验范围、处理短写并清理异常流。Firefox 主归档限制 1 GiB、180 秒下载期限和八次 HTTPS 跳转；Chromium 与旧版 CloakBrowser 也限制写入字节、HTTPS 跳转、尝试次数和时间，保留固定哈希校验。未知总大小时显示不定进度。 |

AI 地址只接受 HTTP(S) 的 127.0.0.1、localhost 或 [::1] 根地址；本机 JSON 请求有大小、超时、取消与并发限制，常见云模型和带远端元数据的模型会排除。应用不读取 API key、不持久化聊天；Ollama 自身是否完全本地仍需核对模型与服务配置，参见 [本地 AI 使用说明](local-ai.md)。

签名构建与草稿发布准备见 [自有签名更新文档](release-signing.md)。此次没有创建生产私钥、上传或发布远端 Release，也没有下载安装实际更新。竞品调研和后续候选功能见 [调研记录](research/product-roadmap-2026-11.md)，其中规划项不代表已交付。

## 可核对的验证节点

以下各阶段的结果存在覆盖重叠，不能相加。最新全量记录对应 2026-11-09 代理草稿、签名启动、下载保护与发布文件选择的交付节点。

- 交付节点 Bun 1.2.21 和 Bun 1.3.13 全量均 **1910 通过、32 跳过、0 失败**，共 1942 项、148 文件、18391 次 Bun 断言记录。日志分别为 `node_modules/.cache/delivery-full-bun-1.2.log`、`node_modules/.cache/delivery-full-bun-1.3.log`；TypeScript 和生成文档检查通过。
- 质量报告和内核清单节点两版 Bun 均 1884 通过、32 跳过、0 失败，共 1916 项、147 文件、18185 次断言。日志分别为 `node_modules/.cache/workflows-final-full-bun-1.2.log`、`node_modules/.cache/workflows-final-full-bun-1.3.log`。
- 上一个可靠性节点两版 Bun 均 1815 通过、32 跳过、0 失败，共 1847 项、140 文件、17756 次断言。日志为 `node_modules/.cache/reliability-final-full-bun-1.2.log` 和 `node_modules/.cache/reliability-final-full-bun-1.3.log`。
- 编辑及创建实际 App DOM 回归两版均 20 项通过（9 场编辑、5 场创建/设置导航及 6 项国际化检查）；更新、同步和代理按钮恢复专项两版均 16 项通过。下载专项两版均 45 项通过、298 次断言，使用内存响应和临时文件。
- 上一轮官方固定版本 Bun 1.2.21 全套节点 `node_modules/.cache/templates-final-full-bun-1.2.log`：1724 通过、32 跳过、0 失败，共 1756 项、128 文件。
- 上一轮 Bun 1.3.13 全套节点 `node_modules/.cache/templates-final-full-bun-1.3.log`：1717 通过、32 跳过、0 失败，共 1749 项、127 文件；相比上述节点少 7 项新辅助函数测试，这些测试已单独在两个版本验证。两份日志对应明确检查点，后续新功能仍需继续回归。
- 本地 AI 服务与回环传输专项：24 项通过、213 次断言，含真实隔离 HTTP/TLS 回环服务。服务响应由测试生成，未实际运行 Ollama 模型推理。
- AI 路由、网页客户端、历史和 SSR 专项：29 项通过、327 次断言，验证同源与请求头约束、匿名上下文、错误映射、取消作用域、重复请求 ID、模型及回答校验；另有 3 个 DOM 交互场景通过。
- 工作区备份与偏好专项：20 项通过、221 次断言，包含 app-settings.json 恢复、同步默认禁用和非法配置拒绝。
- 模板后端、模板路由及完整备份专项：34 项通过、682 次断言；真实 handleUiRequest 模板集成另有 9 项通过、218 次断言，验证守卫先行、跨工作区隔离、流式体积上限、秘密字段拒绝及旧版本冲突。
- 模板创建回归节点 `node_modules/.cache/template-creation-regression.log`：60 项通过、820 次断言，覆盖仪表盘结构、模板真实路由及创建内核辅助函数；它不是完整模板交互和全套回归的替代。
- Rust 原生库 40 项通过（`node_modules/.cache/evidence-preflight-rust-test.log`），含受限外链、窗口权限和更新关闭协调。早期的 1 项 MCP helper 测试及 3 项离线验签测试亦已分别通过。
- 签名启动和自定义代理节点：Rust 原生库 **41 项通过、0 失败**（`node_modules/.cache/startup-network-rust-full.log`）。两版 Bun 的签名专项各 61 项、网络及其 UI 专项各 48 项、Firefox 与续传专项各 63 项通过；部分覆盖重叠。
- 代理草稿集成后的 React 预览冒烟通过，包括 1,000 个合成环境的目录读取、新建、备份下载摘要校验与恢复至独立工作区。日志为 `node_modules/.cache/delivery-preview-smoke.log` 和 `node_modules/.cache/delivery-preview-1000-smoke.log`。
- 发布文件选择专项两版各 7 项通过。隔离 PowerShell 实跑工作流的选择步骤，Actions artifact 与 GitHub 草稿的文件列表一致，旁带日志未列入。验收不使用真实签名密钥或 GitHub 发布。
- 交付前回归发现 Excel 导入导出的旧调用允许空选项，补回该兼容路径；两项合成工作簿测试复验通过。Firefox 预设测试改用固定不同身份、模拟 ID 碰撞并检验实际启动种子，避免把随机硬件值恰好相同视为身份复用。
- 已用真实 Chrome 检查隔离设置 UI；本机 7890 端口 SOCKS5 握手成功，使用真实隔离 SQLite 数据创建 12 环境加密快照，预览显示 12 个冲突并阻止重复导入。
- 真实 Chrome 中已操作模拟 AI 完整链路：初始不连接且概览默认关闭，连接显示 1 个本地模型并排除 1 个远端模型，示例草稿与 Ctrl+Enter 发送、回答文本、取消恢复草稿、概览标记、导航后保留历史、新对话撤销均已检查。截图见 [模拟 AI 交互验收](../reports/ui-qa/airy-IBAORd/local-ai-verified.jpg)；回答仍是夹具模拟，并非实际模型推理。
- 真实 Chrome 的环境预设验收已操作真实 SQLite 持久化、Auto 差异预览和应用、保留名称与代理草稿、撤销删除，以及实际创建第 13 个隔离环境并重新打开弹窗加载预设。截图见 [预设交互验收](../reports/ui-qa/airy-E5SGA0/profile-presets-verified.jpg)。
- 真实内核回归 `reports/engine-qa/workflows-current-kernels.log`：5 项通过、202 次断言、44.76 秒。四个 Chromium 155 / Firefox 156 的 HTTP/SOCKS5 场景启用了本机代理启动前检查，验证正确认证、错误凭据阻断、采样来源及关闭/重开；第五项验证 Firefox 32 核配置在 20 核主机上的 worker、页面和质量判断一致。五项真实测试在普通全套中按 opt-in 跳过，需要单独运行。
- 签名启动和自定义代理节点的真实内核复验 `reports/engine-qa/startup-network-current-kernels.log`：**5 项通过、0 失败、202 次断言、47.51 秒**。使用之前验过固定哈希的内核文件和新的隔离环境。
- Firefox Canvas/Audio 跨 realm 探测已用 DataView 读取实际摘要字节及音频样本；真实测试确认 64 个十六进制字符的 SHA-256 值及重启稳定性，没有关闭 Xray 保护或代填摘要。处理器期望复用实际启动策略，保存核数不变，缺配置或非法结果仍为未知。详见 [内核验收说明](../test-fixtures/ENGINE-QA.md)。

`scripts/preview-airy-ui.ts` 使用实际 React 和隔离 SQLite，但浏览器生命周期、代理发现、出口检查、定位、外部扩展下载及 AI 模型回答由夹具模拟。`--signed-update` 模拟可信通道和版本提醒，拒绝安装。真实 Chrome 用于验证交互；真实 Ollama 推理、指纹采样、外部代理出口和签名安装的证据需分别取得。

本轮 [报告证据样本截图](../reports/ui-qa/airy-9plDJJ/fingerprint-evidence-synthetic.jpg) 明确使用模拟观测，展示中英报告、安全核数/系统/语言/屏幕/时区对照及筛选布局，不作为真实指纹通过的证据。真实内核验收仍以独立的 `reports/engine-qa` 记录为准。外链的 Chrome 桥接也只记录模拟调用，Rust 规则验证不等同于实际打开 OS 浏览器。

[质量报告编辑截图](../reports/ui-qa/airy-b88oIr/quality-profile-edit-verified.jpg) 使用模拟样本和真实隔离 SQLite，验证正确环境、取消焦点、保存回显和筛选保留。[匿名草稿预览截图](../reports/ui-qa/airy-gyuwXd/anonymous-fingerprint-draft-min-size.jpg) 使用同类模拟报告，真实 Chrome 在 960×640 下完成预览、追加、原草稿保留和未连接模型检查。内核清单同尺寸下无横向溢出，显式检查空缓存未触发下载。

[签名启动提醒截图](../reports/ui-qa/airy-cdH18M/signed-startup-notice-simulated.jpg) 与 [IPv6 代理发现截图](../reports/ui-qa/airy-cdH18M/ipv6-proxy-discovery-simulated-min-size.jpg) 使用实际 React 和隔离夹具。Chrome 验证一次启动检查、提醒跳转与焦点、关闭启动检查后重载不再检查，以及 IPv6 自定义端口表单和 SOCKS5 握手结果。更新及网络面板在 960×640 下无横向溢出。截图中的发布版本和监听端口为模拟数据。

[代理草稿截图](../reports/ui-qa/airy-rB0dla/ipv6-proxy-to-new-profile-simulated.jpg) 记录真实 Chrome 从模拟 `[::1]:18080` 发现结果打开新建环境，确认主机字段为裸 `::1`、凭据为空，取消后返回原按钮。实际 App DOM 另验证了认证提示、变更端点后清除旧证据、已打开草稿不被覆盖，以及只有显式创建才发出保存请求。

质量报告与内核清单节点用固定版本 Bun 1.2.21 准备 508 个模块的 Windows 资源，并完成离线锁定 `cargo build`。准备和构建日志分别为 `node_modules/.cache/workflows-desktop-prepare.log`、`node_modules/.cache/workflows-desktop-cargo-build.log`，运行资源标识 `c8d8a02dec1f90f7`。这是一份调试构建。

扩展桌面校验器已针对实际编译 sidecar 通过（`node_modules/.cache/workflows-desktop-verify.log`）。它验证网页初始化、本地边界、真实加密快照、模板与网络偏好随备份恢复、工作区隔离、隔离 Ollama 协议及取消、内核清单无下载无目录创建，以及四次正常关闭。打包 MCP helper 经过真实 stdio 握手，发现 43 项工具（含 12 项本地工具），实际调用离线指纹报告与本机端口发现。报告未推断进程存活；发现只发送 SOCKS 方法协商，没有执行认证或 CONNECT，也没有打开环境或下载内核。

签名启动和自定义代理节点重新准备了 508 个模块、完成 Windows 调试构建，资源标识 `12948fcf44a9920a`。编译校验 `node_modules/.cache/startup-network-desktop-verify.log` 复验上述链路，并确认签名启动偏好按工作区保存、恢复到新工作区时关闭，以及实际 IPv6 发现只连接由夹具创建的端口、交换 SOCKS5 方法并断开。验收未发送凭据、执行 CONNECT 或访问外部站点。

代理草稿与兼容修复后的 Windows 调试构建资源标识 `3d91c65c71f9b79b`，重新编译 508 个模块。编译校验再次通过，日志见 `node_modules/.cache/delivery-desktop-prepare.log`、`node_modules/.cache/delivery-desktop-cargo-build.log`、`node_modules/.cache/delivery-desktop-verify.log`。

独立标识的原生 QA 应用启动就绪，确认其隔离工作区内有 0 个环境、0 项下载。界面控制工具的应用授权等待超时，因此未进行原生表单、窗口控件或真实 OS 外链验收；仅清理了该测试进程树，证据见 `node_modules/.cache/native-window-qa-cleanup.json`。旧应用未被操作。外部代理服务、真实模型推理、原生交互和实际更新安装仍需分别验收；生产签名密钥与发布资产尚未配置。

## 环境与测试限制

本机为 Windows，Bun 1.3.13、Node 24.14.0、Rust 1.95.0；现有 CI 固定 Bun 1.2.21，打包资源使用 Node 22.23.2。沙箱默认临时目录出现过不存在的重复路径，测试应将临时目录放在项目缓存；仅修改父进程环境在部分 Bun 版本中不足以修正，需要 preload。

可在忽略目录建立 `node_modules/.cache/test-env.ts`，内容如下；这是测试环境文件，不作为产品运行配置：

```typescript
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const directory = resolve(process.cwd(), "node_modules/.cache/test-temp");
mkdirSync(directory, { recursive: true });
process.env.TEMP = directory;
process.env.TMP = directory;
process.env.TMPDIR = directory;
```

```powershell
bun test --preload ./node_modules/.cache/test-env.ts --timeout 10000
node node_modules/typescript/bin/tsc --noEmit
```

中文工作目录下 `bun run typecheck` 曾报 `CouldntReadCurrentDirectory`，直接运行上述 Node/TypeScript 命令可以避开该启动问题。涉及回环监听、子进程或 junction 的隔离测试在默认沙箱中可能遭权限拒绝，相关测试已在获自动审批的主机权限下验证；应区分环境权限失败和产品失败。上述全套检查点中的 32 项跳过包括真实内核与额外代理条件测试；其中上述 5 项真实内核场景已有单独通过记录，其余跳过不能计为已通过的端到端检查。
