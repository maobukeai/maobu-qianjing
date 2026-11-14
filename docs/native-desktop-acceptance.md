# 原生桌面隔离验收

这个入口只用于 Windows **debug 构建**的真实窗口、布局、导航、新建和编辑表单验收。业务验收仍使用 `scripts/verify-local-desktop.mjs`。这里使用新建 synthetic 工作区，不导入用户资料。

## 准备与校验（不启动窗口）

从项目根目录执行；先完成当前阶段资源准备与 debug 构建：

```powershell
bun run desktop:prepare
cargo build --offline --manifest-path src-tauri/Cargo.toml --bin aliasmode
node scripts/native-desktop-acceptance.mjs --prepare-only --json
```

最后一条命令只复制已校验 runtime 并在系统 Temp 新建独占目录。返回 `manifestPath`，其 manifest 列出全部路径、主程序 SHA-256、argv 和隔离环境。默认省略 `--prepare-only` 也仅准备，不会启动桌面。不可使用 `scripts/run-local-desktop.mjs` 的普通启动入口执行隔离验收。

```powershell
node scripts/native-desktop-acceptance.mjs --validate-only --manifest '<manifestPath>' --json
node scripts/native-desktop-acceptance.mjs --validate-native --manifest '<manifestPath>' --json
```

`--validate-only` 只读取 marker、manifest 和已准备 executable。`--validate-native` 会运行已确认支持此协议的 debug 主程序，但在 Tauri Builder、插件、单例和 sidecar 创建前完成校验并退出；不创建窗口、数据库或 runtime descriptor。

这两步通过只代表预检通过，不能作为 sidecar 成功启动或真实 UI 已显示的证据。第一次真实启动曾因 synthetic catalog 的颜色不在业务 allowlist 中失败，尚未显示窗口；launcher 已改为合法 `#8169c8`，纯测试现通过真实 `WorkspaceCatalog` 读取整份种子数据，防止仅验 JSON 格式而遗漏业务 schema。

## 启动真实验收窗口

只有下面这个显式命令会请求启动窗口。它先执行前述 native preflight；命令返回 PID 表示已产生进程，不代表窗口已就绪，需实际观察界面：

```powershell
node scripts/native-desktop-acceptance.mjs --launch --manifest '<manifestPath>' --json
```

操作系统窗口标题带“隔离验收”。launcher 通过既有工作区 catalog schema 将 default 工作区命名为“原生隔离验收”，因此无边框窗口的产品栏和工作区菜单也能辨认。产品 UI 无需 QA 分支。

```text
<system Temp>/maobu-native-acceptance-<unique>/
  acceptance-marker.json       # 有界、版本化、24小时有效的本次所有权标记
  acceptance-manifest.json     # 路径、argv、环境和已校验native SHA
  acceptance.lock              # 当前实例独占，正常退出释放；崩溃后使用新root
  roaming/com.maobu.local/     # backend home、catalog、SQLite、profiles、descriptor
  local/com.maobu.local/webview/ # 唯一WebView UserData
  temp/                       # 预检通过后，本进程及sidecar的TEMP/TMP
  artifacts/                  # 本次截图/验收记录
```

## 边界

- QA 参数在 Builder 创建前解析。release 构建看到 QA 参数明确退出；缺参数、未知/重复参数、与 import/background 混用或无效路径均退出，绝不回退真实 home。
- 只接受系统 Temp 的规范绝对本地路径直属子目录、固定前缀、新鲜普通 marker、匹配 proof，以及所有固定子目录无 symlink/junction/reparse 的布局。不会替缺失目录或损坏 marker 创建兜底数据。
- QA 完全跳过生产单例插件，不向真实实例发送参数或显示真实窗口。每个 QA root 使用独占 lock；不得复用已锁或崩溃遗留 root。两个新建 root 互不相干。
- backend home 与 WebView 数据目录显式绑定，APPDATA/LOCALAPPDATA/TEMP/TMP 只在 QA 子进程中指向自有目录；不修改 HOME、USERPROFILE、CODEX_HOME 或父进程环境。native 先以原始系统 Temp 验证根，再切换 TEMP/TMP，防止自我引用验证。
- MCP descriptor 显式指向 QA home。后台自动拉起目标是本 root 下必须不存在的禁用路径，连接失败不能启动无 QA 参数的真实桌面。
- 允许读取已安装 OS/WebView 运行库及其安装发现注册表。禁止真实 `com.maobu.local` 业务数据和浏览器 UserData。此功能不是恶意代码沙箱，不应在验收中执行自定义脚本或接入真实账户。
- QA 不注册 updater；状态明确 disabled，check/install、原生 restart、外部链接/Explorer 打开、备份 SaveDialog 都在动作前拒绝。WebView 下载也被取消，不能写真实 Downloads。真实最小化、最大化、拖动和关闭仍可验收。
- QA 不开放 CDP、remote-debugging-port 或 debugger pipe。保留普通 WebView 默认参数，旧调试环境分支仅限普通 debug 启动，QA 分支明确拒绝它。
- launcher 静态确认 debug 专属协议标识及 ready manifest 的 native hash后，才允许执行主程序；防止旧 exe 忽略 QA 参数后进入真实 home。manifest/hash/argv被改动后校验失败。
- WebView 预检只读检查环境及 HKLM/HKCU 两种 registry view 中命中 AUMID、exe 文件名或 `*` 的 loader override（UserDataFolder、AdditionalBrowserArguments、BrowserExecutableFolder、版本/渠道选择，含旧 LoaderOverride 字段）。存在覆盖或无法安全读取即拒绝；不会写入、删除或修复用户 registry。普通安装发现不属于此拒绝项。覆盖规则依据 [微软 WebView2 环境文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl?view=webview2-1.0.4258.31)和[官方 loader policy 文档](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-webview-policies)。

## 检查

```powershell
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib
cargo fmt --manifest-path src-tauri/Cargo.toml --check
bun test scripts/native-desktop-acceptance.test.ts
bun run typecheck
```

Rust 测试验证 release 拒绝策略、参数冲突、所有权/有效期、目录与 marker 损坏、环境覆盖、root lock 及更新禁用。CLI 测试使用自有 cache 下 synthetic fixture 验证准备、无隐式启动、旧 exe 拒绝、路径/marker/hash/argv变更、MCP隔离和真实 junction 拒绝。Windows 沙箱若禁止 MSVC 临时链接或创建测试 junction，需要让这些编译/测试进程取得相应本地文件系统权限；不得通过改 HOME/USERPROFILE 规避。

清理应在确认对应 native/sidecar 已退出后，只删除已解析并确认属于本次 marker 的 root。不要按通配符删除整个 Temp，也不要触碰普通应用 home。
