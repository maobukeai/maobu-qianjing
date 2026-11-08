# 猫步·千境 · 本地版

当前版本：`0.1.0-local.1`。

猫步·千境指纹浏览器是基于 AliasMode 修改的本地专用桌面应用，打开后直接管理本机环境，无需原作者账号。保留环境导入导出、分组、代理、会话保存、本地脚本、AdsPower 兼容 API 和本机 MCP。

## 已移除的功能

原作者的 Cloud 登录与注册、环境同步、团队管理、远程 MCP、代理商城与钱包、推广、远程服务列表、公共云脚本库及发布入口均已移除。对应云客户端、鉴权、同步队列、远程隧道、云数据封装源码及专属测试已从仓库删除；原作者的桌面自动更新和云凭据读写接口也已删除。

旧配置、旧环境变量和旧云 API 路由不能重新启用这些功能。本地 MCP 的协议名和 `aliasmode-mcp` 文件名继续保留，供现有本机自动化客户端使用。

## Windows 桌面启动

已完成编译时，在项目目录双击 **启动猫步千境.cmd**，或运行：

```powershell
node scripts/run-local-desktop.mjs
```

旧入口 **启动猫步浏览器.cmd** 继续转到新入口。启动器使用本项目编译的程序，复制到英文临时路径后运行，以避开 Bun 1.2.21 对中文资源路径的兼容问题。临时目录路径需要全英文；必要时通过 `MAOBU_RUNTIME_DIR` 指定。启动器不下载原作者的桌面应用。

Windows 新建环境默认使用 Chromium 155。浏览器内核在首次打开相应环境时下载、校验并缓存；仅打开管理界面不会下载内核。Firefox 和 CloakBrowser 按环境选择使用。默认按需下载的内核和所需字体使用源码固定的版本、下载地址与 SHA-256，校验失败会停止使用该下载。

可选的离线 Firefox 打包由构建者显式设置 `MAOBU_BUNDLE_FIREFOX=1`，并通过 `ALIASMODE_FIREFOX_ARCHIVE`、`ALIASMODE_FIREFOX_ARCHIVE_SHA256`、`ALIASMODE_FIREFOX_EXECUTABLE_SHA256` 提供指定版本的压缩包和审核过的校验值。该构建选项信任构建者提供的预期哈希，不是应用自动更新通道。

桌面版使用独立的数据目录 `%APPDATA%\com.maobu.local`。旧版数据和 Windows 凭据保留原处，不会自动迁入或上传；需要的环境可显式导入。

## 从源码构建

Windows x64 需要 Bun **1.2.21**（与本地 CI 一致）、Node.js、Rust MSVC 工具链、Visual Studio C++ Build Tools 和 WebView2。

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run desktop:prepare
cargo build --locked --manifest-path src-tauri/Cargo.toml
node scripts/run-local-desktop.mjs
```

`desktop:prepare` 编译 sidecar、准备经过校验的 Node 与 Playwright 资源，并生成桌面元数据；它会重建 `src-tauri/resources` 下相应的生成资源目录，请勿在其中保存个人文件。Windows 中文项目路径需要使用上述英文路径启动器。

调试源码网页界面时，可显式准备开发运行时，再启动本地服务：

```powershell
bun cli.ts setup --state-root node_modules/.cache/local-dev
bun cli.ts start --state-root node_modules/.cache/local-dev
```

`setup` 会下载并校验源码调试所需的 Node、CloakBrowser 和 Firefox。网页地址默认是 `http://127.0.0.1:50400`；源码状态保存在指定目录，与桌面数据目录分开。已有正确运行时配置时无需重复 `setup`。

## 本地自动化

AdsPower 兼容 API 使用本机回环地址，默认端口为 `50400`。它没有账号鉴权，不应通过端口转发或反向代理暴露到外部。接口文档位于 [Local API](docs/public/local-api.openapi.json)。

MCP 使用 stdio 启动本地 `aliasmode-mcp.exe`，保留环境列表、新建、编辑、换代理和浏览器自动化。可运行以下命令准备英文运行目录，不启动桌面窗口：

```powershell
node scripts/run-local-desktop.mjs --prepare-only --json
```

把输出 `runtimeRoot` 内 `aliasmode-mcp.exe` 的绝对路径配置为 MCP 命令，无需参数。它只发现本地版 `com.maobu.local` 运行时。当前工具目录见 [MCP catalog](docs/public/mcp-tools/current-source.json)；文档可用 `bun run docs:public:check` 校验。

## 数据与联网边界

环境、代理、分组、脚本与会话保存在电脑。数据库未整体加密；环境中的密码、Cookie、代理密码与 2FA 种子属于敏感资料，请保护系统账号、数据目录、导出文件和备份。

本地版仍会按实际功能联网：浏览器引擎与字体下载、Node/Python 运行时准备、扩展下载、代理 IP/时区检测、搜索引擎及用户打开的网站。Python 依赖仅在运行 Python 脚本或点击重试时准备；启动、查看及保存脚本均不触发下载。以上不经过已删除的作者账号、同步或商城服务。内核下载仍依赖上游发布仓库，固定哈希校验不能替代浏览器版本本身的安全维护；本项目没有自动更新通道。

## 许可证与来源

保留 [LICENSE](LICENSE) 和 [NOTICE](NOTICE) 中的 Apache-2.0 许可证与原作者署名。原始桌面应用来自 AliasMode / Xreacher；浏览器引擎与第三方组件继续遵循各自许可证。本地专用修改不代表上游提供支持或安全担保。贡献与安全说明见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。
