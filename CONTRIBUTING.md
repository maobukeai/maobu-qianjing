# 贡献说明

本仓库维护猫步·千境本地版。大改动请先与本地版本维护者讨论范围。

## 开发与验证

Windows 环境与桌面构建流程见 [README.md](README.md)。本地 CI 使用 Bun 1.3.13。安装依赖与验证命令如下。

```powershell
bun install --frozen-lockfile
bun run typecheck
bun test --timeout 10000
bun run docs:public:check
```

根据变更运行相关回归；修改本地 API 或 MCP 工具契约后，执行 `bun run docs:public` 并提交生成文档。桌面原生修改还应验证相应 Rust 测试和构建。

Windows CI 会运行 `bun run ui:qa`。本地需要 Node.js 和 Chrome，可用 `bun run ui:qa --rows 2000` 扩大合成工作区。回归覆盖环境列表、键盘导入、编辑、代理、检查报告、AI、脚本、扩展、回收站、设置和工作区备份。它使用独立 Chrome 上下文和合成 SQLite 数据，阻断外部请求，并留下截图与检查结果到 `reports/ui-qa/`。原生窗口和浏览器内核另有验收流程。

## 修改边界

- 保持应用本地专用。Cloud、同步队列、远程 MCP、商城、推广和公共脚本发布源码已物理删除，请勿通过兼容层或回退地址重新引入。
- 保留本地导入导出、会话、脚本、AdsPower API 与 MCP 的实际功能。兼容协议名和可执行文件名仍可能带有 `aliasmode`。
- 浏览器引擎按需下载；保留固定版本和哈希校验。修改引擎来源或版本时同步核对校验值、平台约束和许可证。
- 不提交环境数据库、浏览器用户目录、导出资料、密码、凭据、`.env`、未脱敏诊断或生成二进制。
- 不自动删除或迁移旧版用户数据；已有云缓存只用于迁移保护和拒绝误用。
- 保留 [LICENSE](LICENSE)、[NOTICE](NOTICE) 及第三方署名。

## 提交与版本

说明用户可见的行为变化、验证结果和已知限制，避免无关重构。版本变更需要同步项目包、桌面配置、Rust 包、本地 MCP 和公开文档。

发布者可在构建时配置签名更新通道。应用内安装需要用户确认和验签，草稿发布工作流由维护者手动触发。构建和验签步骤见 [发布签名说明](docs/release-signing.md)。分发修改后的程序时，应包含许可证、来源署名和必要的第三方许可说明。

安全问题按 [SECURITY.md](SECURITY.md) 处理。
