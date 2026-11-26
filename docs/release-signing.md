# 自有签名更新与发布

桌面更新有两条独立路径：设置中心的 GitHub 仓库用于浏览 Releases；安装按钮只使用编译时固定的自有发布端点和公钥。改动设置中的仓库不能改变安装信任。源码默认没有公钥，显示禁用状态，普通 CI 仍可正常构建。

可信通道配置后，可在「应用更新」开启启动时检查，默认关闭。启用后，应用在工作区启动时请求一次清单，发现版本即显示可关闭的提醒。下载和安装由更新页按钮触发。偏好在同一工作区重开时保留；备份恢复为新工作区时默认关闭。

## 候选包（Release Candidate）本地构建（无证书期验收）

在尚未配置正式代码签名证书或长期 Minisign 密钥时，可通过 `scripts/build-windows-installer.ps1` 构建标准未签名 NSIS 候选包用于 Windows 10/11 验收测试：

```powershell
./scripts/build-windows-installer.ps1
```

脚本执行以下强门禁与产出规范：

1. **六处版本号强一致预检**：构建前调用 `scripts/release-utils.mjs` 的 `validateProjectVersions`，验证 `version.ts`、`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`agent/runtime-client.mjs` 六处版本号完全一致，发现漂移立即终止构建。
2. **标准候选输出目录 `dist/rc-<version>/`**：
   - `MaobuBrowser_<version>_x64-setup.exe`（NSIS `currentUser` 安装器，按需下载浏览器内核）
   - `SHA256SUMS.txt`（安装器、许可文件和构建清单的 SHA-256 摘要）
   - `LICENSE` 与 `NOTICE`
   - `CANDIDATE-BUILD.json`（记录签名状态、Git 基准提交、工作树是否有未提交改动、构建源码摘要和安装器摘要）

候选脚本在构建前后比对源码摘要，要求安装器由当次构建生成，并检查 Windows 产品版本和签名状态。若要保留标准目录中的旧包，可用 `-OutputDirectory dist/rc-review` 写入独立目录。

```powershell
node scripts/candidate-build.mjs verify --assets-dir dist/rc-0.20.0 --version 0.20.0
node scripts/candidate-build.mjs verify --assets-dir dist/rc-0.20.0 --project .
```

第一条命令离线校验候选包文件。第二条还会核对当前工作树与构建清单中的源码摘要。

## 证书与 Minisign 公钥精确注入位（零代码改动切换正式签名）

以下所有注入位均已在源码和脚本中就绪；后期拿到正式密钥与代码签名证书后，无需修改业务逻辑即可直接切换为全量正式签名构建：

### 1. Tauri Minisign 自动更新通道注入位

使用官方 Tauri CLI 在仓库以外的安全位置生成并备份自己的签名密钥。不要将私钥放进源码、配置文件、`.env`、聊天记录或构建产物。密钥的生成和托管属于发布者的持久身份；本项目不会自动生成一个临时密钥充当生产发布者。

| 环境变量 / 机密 | 类型 | 源码 / 脚本消费位置 | 作用 |
| :--- | :--- | :--- | :--- |
| `MAOBU_UPDATE_PUBLIC_KEY` | 公开变量（Base64 `.pub`） | `src-tauri/src/signed_updates.rs`（`option_env!` 编译期嵌入）<br>`scripts/release-config.mjs` | 固化应用内更新验签公钥，网页设置不可覆盖 |
| `MAOBU_UPDATE_ENDPOINT` | 公开变量（纯 HTTPS URL） | `src-tauri/src/signed_updates.rs`<br>`scripts/release-config.mjs` | 编译期固定更新清单地址，禁止账号密码/查询参数/片段（如 `https://github.com/maobukeai/maobu-qianjing/releases/latest/download/latest.json`） |
| `TAURI_SIGNING_PRIVATE_KEY` | Secret（仅 `release` 环境） | `scripts/release-build-windows.ps1`（在 `desktop:prepare` 期间从子进程环境变量剥离，仅在 `tauri build` / `tauri signer sign` 阶段传入） | 对 `MaobuBrowser_<version>_x64-setup.exe` 签发 `.sig` 并写入 `latest.json` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Secret（可选） | `scripts/release-build-windows.ps1` | 私钥口令 |

离线验签入口：`scripts/release-verify.rs`（`cargo run --locked --release --manifest-path src-tauri/Cargo.toml --features release-tools --bin maobu-release-verify -- <installer> <version>`）使用与官方 updater 相同的 Minisign 库对安装包及 `trusted comment` 文件名绑定执行真实离线验签。

至少配置公钥和端点，桌面构建才会注册官方 `tauri-plugin-updater`。安装权限仅授予主窗口的已验证回环来源；不暴露插件的通用下载命令，不接受网页指定公钥、URL 或安装路径。

### 2. Windows Authenticode 代码签名证书注入位

发布者在 Windows 构建账户的个人证书存储 `Cert:\CurrentUser\My` 配置可访问私钥的代码签名证书（OV/EV 或受管云签名 CSP/KSP），并安装包含 SignTool 的 Windows SDK。以下环境变量会自动注入 Tauri 构建配置：

| 环境变量 | 格式要求 | 源码 / 脚本消费位置 | 作用 |
| :--- | :--- | :--- | :--- |
| `MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT` | 40 位十六进制 SHA-1 指纹（自动清理空格与 LRM） | `scripts/release-config.mjs`（生成 `bundle.windows.certificateThumbprint`）<br>`scripts/release-build-windows.ps1`（构建前检查 `Cert:\CurrentUser\My\<thumbprint>` 私钥可用性） | 启用 SHA-256 嵌入式 Authenticode 签名 |
| `MAOBU_WINDOWS_TIMESTAMP_URL` | 公开 HTTP/HTTPS TSA 地址（禁凭证/查询串/片段） | `scripts/release-config.mjs`（`bundle.windows.timestampUrl`） | 为嵌入式签名附加时间戳，证书过期后仍长期有效 |
| `MAOBU_WINDOWS_TIMESTAMP_PROTOCOL` | 可选：`rfc3161`（默认）或 `authenticode` | `scripts/release-config.mjs`（`bundle.windows.tsp`） | 指定时间戳协议 |

启用 Windows 签名后，`scripts/release-build-windows.ps1` 会在 Tauri 打包完成后调用 `Get-AuthenticodeSignature` 强制核验：
- 签名状态为 `Valid` 且类型为 `Authenticode`；
- 签名证书指纹与 `MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT` 严格一致；
- 存在有效 `TimeStamperCertificate` 时间戳证书；
- 随后才对该已签名文件执行 Tauri Minisign 更新签名与 SHA-256 计算，最终返回 `updaterSigned: true` 且 `authenticodeVerified: true`。

### 3. `.github/workflows/release-draft.yml` 接入 Authenticode 证书步骤

当前 `.github/workflows/release-draft.yml` 已完整接通 Tauri Minisign 更新签名与 6 资产校验发布草稿；未来在 GitHub Actions `release` 环境中接入 Windows Authenticode 代码签名时，按以下步骤扩展即可（零业务代码改动）：

1. **配置 `release` 环境机密与变量**：
   - Secret：`WINDOWS_CERT_PFX_BASE64`（或云签名服务凭证，例如 Azure Trusted Signing / AWS KMS / DigiCert KeyLocker）、`WINDOWS_CERT_PFX_PASSWORD`；
   - Variable：`MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT`（40 位 SHA-1 指纹）、`MAOBU_WINDOWS_TIMESTAMP_URL`（如 `http://timestamp.digicert.com` 或证书商 RFC 3161 TSA 地址）。
2. **在 `Build and verify signed release assets` 步骤前导入临时证书**（仅在 `Cert:\CurrentUser\My`）：
   - 将 Base64 PFX 解码到 `$env:RUNNER_TEMP`，通过 `Import-PfxCertificate -CertStoreLocation Cert:\CurrentUser\My` 导入并立即删除临时 `.pfx` 文件；
   - 将 `MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT` 与 `MAOBU_WINDOWS_TIMESTAMP_URL` 传入 `scripts/release-build-windows.ps1` 步骤的 `env:`。
3. **验证与清理**：
   - `scripts/release-build-windows.ps1` 会自动将配置写入 `tauri.signed.conf.json` 并强制通过 `Get-AuthenticodeSignature` 校验，输出 JSON 中应确认 `"authenticodeVerified": true`；
   - 在 `if: always()` 收尾步骤从 `Cert:\CurrentUser\My` 移除该临时证书，防止残留。

## 正式签名构建与草稿发布流程

先将 `version.ts`、`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（本地包版本）以及 `agent/runtime-client.mjs` 的后备版本更新一致并通过测试。发布脚本会校验这六处值，不替你改版本。

本机设置上述进程环境后，可运行：

```powershell
./scripts/release-build-windows.ps1 -ReleaseVersion 0.20.0 -Repository maobukeai/maobu-qianjing -NotesFile path/to/release-notes.md
```

签名脚本从 Cargo 元数据定位实际构建目录，签名前确认安装器在本次打包开始后写入，且产品版本与发布版本一致。

脚本准备运行时、构建 NSIS 安装包，将其命名为 `MaobuBrowser_<version>_x64-setup.exe`，再通过官方 Tauri signer 签名。随后生成 `latest.json` 和 `SHA256SUMS.txt`，运行结构、版本、来源和校验和检查，并用与官方 updater 相同的 Minisign 库离线验证真实签名。它不会上传、发布或运行该安装包。

`.github/workflows/release-draft.yml` 只接受手动 `workflow_dispatch`，仅在 `main` 执行。它使用固定提交的 Actions、Bun 1.3.13 与 Rust 1.95.0，并在缺少更新签名密钥时停止。请将仓库的 `release` 环境限制到受保护的发布分支，按工作流提供签名密钥。

Actions artifact 和 GitHub **草稿**共用一份文件清单，包含安装包、对应签名、`latest.json`、`SHA256SUMS.txt`、`LICENSE` 和 `NOTICE`。上传前重新检查清单和校验和，缺失或链接的预期文件会终止工作流。输出目录中的其他文件留在本地。工作流发现同名发布时会停止。维护者检查草稿资产后，再按自身发布流程发布。启用 GitHub 不可变发布时，资产需要在发布草稿前全部上传。

当前发布流程生成 Windows x64 的更新清单。预发布草稿可以生成，但 GitHub 的 `/releases/latest/` 稳定入口不会选择预发布版本；原生安装通道与 UI 的“包含预发布”浏览设置相互独立。

## 安装完整性、隐私锁与数据保护边界

- **应用更新完整性**：原生安装先通过官方 updater 下载并验证签名，再保存浏览器会话并安全关闭后台服务，最后交给官方安装器。仅接受 HTTPS（含重定向），下载上限 512 MiB，且强制校验 Minisign `trusted comment` 中的文件名与标准安装包名一致。
- **本地应用主密码锁边界**：可选主密码锁是同机交互隐私锁（`scrypt(N=32768, r=8, p=1)` + 持久化防爆破冷却 + 后端 HTTP `423 Locked` 门禁），配置存于全局 `<workspaceHome>/app-lock.json`（不纳入单工作区备份）。它补充而非替代 `dpapi.ts` 的 SQLite 列级 AES-256-GCM + Windows DPAPI 静态加密；锁屏绝不强杀已打开的浏览器窗口。忘记密码时可在本机当前操作系统账户下关闭应用并删除 `app-lock.json` 重置，环境数据完好无损。

## 干净 Windows 10/11 发布验收清单

每次发布候选包或正式签名包前，必须在未安装开发工具链的干净 Windows 10（22H2+）与 Windows 11（23H2/24H2）环境中逐项完成以下验收：

- [ ] **免管理员与特殊路径安装**：使用非管理员标准账户，在含中文与空格路径下安装 `MaobuBrowser_<version>_x64-setup.exe`（`installMode: currentUser` 无 UAC 提权弹窗），校验 `SHA256SUMS.txt` 与安装器摘要一致（正式包另核对 `Get-AuthenticodeSignature` 为 `Valid`）
- [ ] **WebView2 冷启动与窗口材质**：WebView2 自动引导/冷启动成功，无边框标题栏控件与 Win11 Mica 材质（及 Win10 纯色降级）显示正常
- [ ] **30 秒首次上手清单**：首次进入零弹窗阻断，4 步清单随真实操作自动勾选，折叠/关闭状态重启后持久化，并可在「设置 → 常规」重新打开
- [ ] **双内核按需下载与安全关闭**：Chromium / Firefox 按需下载、SHA-256 校验与启停正常，关闭主窗口时触发浏览器会话安全落盘无孤儿进程
- [ ] **高频工作流闭环**：行内双击改名与快捷备注、多标签 OR/AND 筛选、单环境操作时间线与一键测代理正常
- [ ] **`.mqprofile` 加密导出与拖拽导入**：批量勾选导出加密环境包 → 拖拽/文件导入解密 → 冲突预览（跳过 / 克隆新 ID / 覆盖已关闭）完整闭环
- [ ] **本地 RPA 录制与模板工作台**：可视化录制（含密码字段自动脱敏）→ 在线编辑脚本源码 → 内置模板多环境并发队列运行 → 异常自动截图回执正常
- [ ] **AI 智能副驾受控提案**：提案卡片预览 → 反选部分环境 → 确认执行 → 急停按钮生效 → 核查确认未向模型外发任何明文凭证或代理密码
- [ ] **本地应用主密码锁**：启用主密码后冷启动锁屏、空闲自动锁屏、`Ctrl+Shift+L` 手动锁屏均生效；连续输错 5 次触发 30 秒冷却且重启后不重置；锁定时直连 `/ui/api/profiles`、`/card`、`/api/agent/v1/connect` 均返回 HTTP `423 Locked`；已运行浏览器窗口不被强杀
- [ ] **一键环境诊断箱与脱敏 ZIP**：6 项检测（WebView2/OS、端口健康、SQLite `quick_check`、内核 SHA-256、磁盘空间、MCP 资源/只读握手）通过，导出 ZIP（`<= 2 MiB`）并在导出前预览与解压人工检索确认 **0 明文密码 / Cookie / 代理认证 / 公网 IP / CDP URL / 本机用户名路径**
- [ ] **覆盖升级与干净卸载**：覆盖升级安装不丢失 SQLite 数据库与 Windows DPAPI 保护的凭证；卸载程序干净移除应用文件且不误删用户数据目录

[Tauri Updater](https://v2.tauri.app/plugin/updater/) · [Tauri Windows 代码签名](https://v2.tauri.app/distribute/sign/windows/) · [Microsoft Authenticode 验证](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature) · [Tauri CLI 更新签名实现](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-cli/src/helpers/updater_signature.rs) · [GitHub 发布草稿](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
