# 自有签名更新与发布

桌面更新有两条独立路径：设置中心的 GitHub 仓库用于浏览 Releases；安装按钮只使用编译时固定的自有发布端点和公钥。改动设置中的仓库不能改变安装信任。源码默认没有公钥，显示禁用状态，普通 CI 仍可正常构建。

可信通道配置后，可在「应用更新」开启启动时检查，默认关闭。启用后，应用在工作区启动时请求一次清单，发现版本即显示可关闭的提醒。下载和安装由更新页按钮触发。偏好在同一工作区重开时保留；备份恢复为新工作区时默认关闭。

## 发布者配置

使用官方 Tauri CLI 在仓库以外的安全位置生成并备份自己的签名密钥。不要将私钥放进源码、配置文件、`.env`、聊天记录或构建产物。密钥的生成和托管属于发布者的持久身份；本项目不会自动生成一个临时密钥充当生产发布者。

- `MAOBU_UPDATE_PUBLIC_KEY`：官方 Tauri signer 生成的 `.pub` 文件内容，可公开。作为 GitHub 仓库或 `release` 环境变量配置。
- `MAOBU_UPDATE_ENDPOINT`：编译时固定的 HTTPS 更新清单地址，不允许用户名、密码、查询参数或片段。自有 GitHub 稳定通道通常为 `https://github.com/maobukeai/maobu-qianjing/releases/latest/download/latest.json`。
- `TAURI_SIGNING_PRIVATE_KEY`：官方 signer 生成的私钥内容，只存为 GitHub `release` 环境 secret，或在本机受控进程环境中短暂提供。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码，同样使用 secret。

至少配置公钥和端点，桌面构建才会注册官方 `tauri-plugin-updater`。安装权限仅授予主窗口的已验证回环来源；不暴露插件的通用下载命令，不接受网页指定公钥、URL 或安装路径。

## Windows 代码签名

发布者在 Windows 构建账户的个人证书存储 `Cert:\CurrentUser\My` 配置可访问私钥的代码签名证书，并安装包含 SignTool 的 Windows SDK。下面两项环境变量用于生成本次构建的 Tauri 配置。

- `MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT` 填写证书的 40 位十六进制 SHA-1 指纹。构建使用 SHA-256 对安装包签名。
- `MAOBU_WINDOWS_TIMESTAMP_URL` 填写证书提供商的 HTTP 或 HTTPS 时间戳地址，地址应使用公开端点格式。
- `MAOBU_WINDOWS_TIMESTAMP_PROTOCOL` 可选。默认 `rfc3161`，传统 Authenticode 时间戳服务可使用 `authenticode`。

启用 Windows 签名后，脚本检查构建账户可用的证书和私钥。Tauri 构建并签署安装器，脚本再验证最终文件的嵌入式签名、发布者指纹和时间戳，然后为同一个文件生成 Tauri 更新签名及 SHA-256。成功结果中 `updaterSigned` 表示更新签名已验，`authenticodeVerified` 表示 Windows 代码签名也已验。

仅配置 Tauri 更新密钥时，可以生成用于内部测试的更新签名草稿。`bun run desktop:build:nsis` 可准备未签名的本地安装包。公开发布前仍需用长期发布者证书和隔离 Windows 环境验证实际安装、升级与恢复。

## 构建与草稿

先将 `version.ts`、`package.json`、`src-tauri/tauri.conf.json`、Cargo 包及 lock 中的本地包版本、`agent/runtime-client.mjs` 的后备版本更新一致并通过测试。发布脚本会校验这六处值，不替你改版本。

本机设置上述进程环境后，可运行：

```powershell
./scripts/release-build-windows.ps1 -ReleaseVersion 0.1.0-local.1 -Repository maobukeai/maobu-qianjing -NotesFile path/to/release-notes.md
```

脚本准备运行时、构建 NSIS 安装包，将其命名为 `MaobuBrowser_<version>_x64-setup.exe`，再通过官方 Tauri signer 签名。随后生成 `latest.json` 和 `SHA256SUMS.txt`，运行结构、版本、来源和校验和检查，并用与官方 updater 相同的 Minisign 库离线验证真实签名。它不会上传、发布或运行该安装包。

`.github/workflows/release-draft.yml` 只接受手动 `workflow_dispatch`，仅在 `main` 执行。它使用固定提交的 Actions、Bun 1.3.13 与 Rust 1.95.0，并在缺少更新签名密钥时停止。请将仓库的 `release` 环境限制到受保护的发布分支，按工作流提供签名密钥。

Actions artifact 和 GitHub **草稿**共用一份文件清单，包含安装包、对应签名、`latest.json`、`SHA256SUMS.txt`、`LICENSE` 和 `NOTICE`。上传前重新检查清单和校验和，缺失或链接的预期文件会终止工作流。输出目录中的其他文件留在本地。工作流发现同名发布时会停止。维护者检查草稿资产后，再按自身发布流程发布。启用 GitHub 不可变发布时，资产需要在发布草稿前全部上传。

当前发布流程生成 Windows x64 的更新清单。预发布草稿可以生成，但 GitHub 的 `/releases/latest/` 稳定入口不会选择预发布版本；原生安装通道与 UI 的“包含预发布”浏览设置相互独立。

## 安装完整性与恢复

原生安装先通过官方 updater 下载并验证签名，再保存浏览器会话并安全关闭后台服务，最后交给官方安装器。下载、签名或版本绑定失败时保留现有程序与会话；如果服务已经关闭而安装器启动失败，应用自动重启，恢复本地管理服务。若无法确认会话安全关闭，则取消安装并走现有关闭失败流程。

仅接受 HTTPS，包含重定向后的网络请求。下载限制为 512 MiB。当前固定 CLI 的签名 trusted comment 含文件名，因此安装时还要求它与清单版本和标准安装包名一致，防止用旧的有效签名包冒充更高版本。签名和全局 trusted comment 的真实性都由官方 updater/其 Minisign 库验证；项目不自行解析可执行文件或绕过签名。

Tauri 更新签名保护应用内下载的发行资产，Windows Authenticode 为安装器提供发布者身份。首次真实升级须使用长期更新密钥、发布端点和隔离测试安装完成验证。

[Tauri Updater](https://v2.tauri.app/plugin/updater/) · [Tauri Windows 代码签名](https://v2.tauri.app/distribute/sign/windows/) · [Microsoft Authenticode 验证](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature) · [Tauri CLI 更新签名实现](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-cli/src/helpers/updater_signature.rs) · [GitHub 发布草稿](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
