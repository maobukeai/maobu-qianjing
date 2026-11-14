# 高频工作流调研与实现顺序

查阅日期：2026-11-09。范围：AdsPower、GoLogin、Multilogin 官方帮助中心与官方更新记录；结合当前仓库只读审计。未登录竞品账户，也未把营销中的匿名性、成功率或 IP 信誉说法当作验证结果。

## 2026-11-12 补查 · 恢复、代理与批量配置

本次补查覆盖 Dolphin Anty、Incogniton 和 Kameleo。以下竞品行为来自各自公开文档，猫步状态来自本轮本地构建与验收。

- **回收站**。Dolphin Anty 文档提供按选中项恢复，在支持的套餐内有保留时间。猫步这一轮补齐了搜索跨页保留勾选、恢复确认、逐项回执和失败项重试。恢复任务可切页后继续查看。可继续研究长列表中的回收时间筛选与恢复后定位。 [Dolphin Anty 恢复文档](https://docs.dolphin-anty.com/en/working-with-profiles/deleting-and-restoring-profiles-in-dolphin-anty)
- **代理**。Dolphin Anty 在独立页维护代理条目，并提供搜索、逐项和批量连接检查。猫步本轮的代理来源是已保存的环境和显式探测的本机监听端口，支持从一条检测结果准备替换、审阅实际目标、返回回执并继续处理其余问题。独立命名代理库及历史检测时间是后续可验证的差距。公网信誉需独立证据。 [Dolphin Anty 代理页概览](https://docs.dolphin-anty.com/en/interface-dolphin-anty/application-interface-dolphin-anty)
- **扩展批量分配**。Incogniton 文档展示了上传自定义 CRX 和对已选环境应用扩展。猫步实现了分组默认值、筛选外勾选保留、逐项变更审阅和提交前并发核对。临时给多个跨组环境追加同一扩展仍可作为独立流程研究。 [Incogniton 自定义扩展](https://docs.incogniton.com/extra-features/extension-manager/custom-extensions)
- **备份和迁移**。Kameleo 公开文档支持选中多个环境导出，以及从文件浏览器或拖入文件导入，并列出导出的数据种类。Incogniton 公开文档提供单环境本地恢复入口。猫步的完整工作区备份和文件夹加密快照分别有恢复路径。快照已支持预览冲突和逐项定位导入结果。按用户选择导出一组加密环境是明确的功能差距。 [Kameleo 导入导出](https://help.kameleo.io/article/68-import-export-profiles) · [Incogniton 本地备份](https://docs.incogniton.com/account-management/cloud-saving/backup-locally-saved-data)
- **AI 与 MCP**。Incogniton 发布说明列出 MCP 的管理能力及批量写入后果。猫步本轮提供本机模型工作台、草稿、对话查找、MCP 连接检查和工具目录。真实 MCP 烟测核对本机协议及只读调用。后续若增加写入流程，需求应包含清楚的工作区范围、实际预览、用户应用动作和逐项回执。 [Incogniton MCP 发布说明](https://incogniton.com/blog/incogniton-mcp-manage-and-launch-isolated-browser-profiles-with-ai/)

## 已有能力，避免重复开发

- 环境已有分组、全文搜索、运行/停止筛选、列显隐、分页、批量启动/停止、导入导出与回收站。
- 创建表单已有安全预设、当前分组继承、代理粘贴解析、代理连通性检查，以及默认协调的指纹设置。
- 代理页已有按组检查、重复代理去重、逐行替换预览、流式进度、失败重试和问题筛选。
- 已有 Ctrl/Cmd+K 命令面板、运行环境筛选、工作区备份、扩展分配和本地 AI 草稿。
- 刚落地的环境检查页已能连接网络出口、指纹证据、编辑、AI 和返回原报告。不要再新建一份同用途报告页。

## 建议优先级

实现成本是基于现有代码的估计；“建议”是对本产品的设计判断，不表示竞品具有同名功能。

| 优先级 | 改进 | 当前证据与具体落点 | 预期收益 / 成本 |
| --- | --- | --- | --- |
| P0 | 收藏、最近使用、保存视图 | `web/app.tsx` 目前仅保留分组/状态/文本筛选，缺少常用集合；`UiProfile.lastOpenAt` 已有但未用于用户可见的最近列表。收藏加本地工作区持久化，保存视图记住筛选与排序，恢复时不改变环境配置。 | 高频查找减少重复操作；低到中 |
| P0 | 行内改名与独立标签筛选 | 名称只能进入完整编辑框；标签已经存储、显示和参与全文搜索，但缺少标签选择器与“标签任一/全部”语义。复用 `updateProfile` 的单字段更新，保留 Enter 保存、Esc 取消和失败时草稿。 | 每次整理少开一次复杂表单；低 |
| P0 | 批量环境任务结果面板 | `bulkRun` 已有限并发，但过程主要靠行级 busy，完成后把所有问题拼成一个字符串；用户无法看到队列、每项完成状态或只重试失败项。复用代理页已有的“保留完成结果、失败重试”交互模式。 | 让批量操作可信、可恢复；中 |
| P1 | 已存代理复用与单环境快速编辑 | `web/proxies.tsx` 是检查/替换工具；代理保存在环境里，创建仍需重新粘贴。先提供可命名的连接预设、已使用次数、上次检查时间，避免把连通性解释为信誉。凭据默认隐藏。 | 避免重复输入与选错连接；中 |
| P1 | 快速创建、继续创建和实时概览 | 当前创建一直进入完整模态表单；安全预设在表单的折叠区内。提供“常用设置快速创建 / 完整设置”两条入口，以及创建后继续填写下一份的选项；不自动启动浏览器。 | 新手可理解、熟练用户可更快；中 |
| P1 | 从现有环境复用配置创建 | 当前有手工预设，但没有从某个环境直接带入可复用设置的入口。名称采用“复用配置”，明确会创建新的身份与空白会话；具体安全字段见下文。 | 避免反复抄写配置；中 |
| P1 | 最近操作与启动失败上下文 | 现在主要有全局错误和详细日志；元数据有创建/上次启动时间，但无面向用户的单环境操作时间线。先记录本次会话的启动、停止、失败、配置变更；错误附“检查网络/查看日志/重试”对应操作。 | 用户知道刚才发生了什么；中 |
| P2 | 快捷键帮助与可发现性 | Ctrl/Cmd+K 已存在，缺少独立快捷键速查和常用项的显示。帮助入口列出适用页面、组合键和动作，输入框、模态框、IME 输入期间不抢快捷键。 | 学习成本低、反馈明显；低 |
| P2 | 首次使用清单与有动作的空状态 | 当前无环境时只有创建/导入两个入口，启动加载页不等同于入门引导。建议以真实状态驱动“创建环境→可选配置代理→检查→启动”，已完成项由已有数据判断，可关闭且不阻塞熟练用户。 | 降低首次使用的不确定性；低到中 |

本轮已与主任务协调：优先做收藏/最近使用/保存视图；批量任务面板放到下一轮。后续根据验收结果调整，而非一次塞入所有入口。

## 官方依据与适用边界

1. **常用环境收藏**：Multilogin 官方说明行星标记、单独 Favorites 列表、自动记住收藏；克隆后的环境不会自动继承收藏。可据此采用独立的用户组织偏好，而不是修改浏览器身份数据。[How to favorite profiles](https://multilogin.com/help/favorite-profiles)
2. **快捷编辑**：AdsPower 官方列出逐字段快捷改名、代理、备注和标签；也提供可选择复制内容的环境复制流程。我们应先减少改一个字段时的表单负担。[Edit Profile](https://help.adspower.com/docs/editing)
3. **标签组织**：Multilogin 官方将标签作为可复用、可筛选的工作区组织工具，并说明多标签筛选的匹配规则。我们已有标签字符串，可先把筛选语义做清楚。[How to use tags](https://multilogin.com/help/en_US/how-to-use-profile-tags)
4. **代理管理入口**：GoLogin 官方说明可从环境列表快速编辑代理，也可在独立代理页导入、在批量操作中更新；本文只借鉴操作路径，不采用其内置代理的信誉宣传。[Adding and managing proxies](https://support.gologin.com/en/articles/14810002-adding-and-managing-proxies)
5. **快速创建**：AdsPower 官方创建文档提供单个和多个环境的快速创建；其 2026 年 9 月官方更新进一步描述一键创建沿用偏好和当前分组。我们的当前分组继承已存在，不再算新增功能。[Create a profile](https://help.adspower.com/docs/creating_browser_profiles)、[September 2026 update](https://www.adspower.com/blog/what-is-new-in-adspower-browser-september-2026)
6. **模板复用**：Multilogin 官方支持从现有环境另存模板、默认模板和从模板新建。模板变更不会追溯修改已创建环境；它也说明不同模板模式对新指纹值的影响。因此本产品的“复用配置”需明确身份重新生成。[Browser profile templates](https://multilogin.com/help/profile-template-manager)
7. **操作记录**：AdsPower 官方 Action Logs 按操作类别、时间范围和关键词筛选记录。我们可先做本次会话内、按环境可读的最小任务记录，不必直接复制完整团队审计系统。[Action Logs](https://help.adspower.com/docs/action_logs)
8. **快捷键速查**：Multilogin 官方提供按任务分类的快捷键帮助，并写明部分快捷键只在相关视图生效。适用于我们已有命令面板的补充。[Keyboard shortcuts](https://multilogin.com/help/en_US/how-to-use-keyboard-shortcuts)
9. **空状态引导**：AdsPower 官方更新说明在无数据页面加入用途说明、上手提示和快捷动作。我们可将相同原则落实为状态驱动清单，而不是增加大篇教程。[September 2026 update](https://www.adspower.com/blog/what-is-new-in-adspower-browser-september-2026)
10. **GoLogin 的 Pin / History 来源边界**：该官方文档明确写的是 **Android 界面**，因此只能证明 GoLogin Android 提供 Pin、Notes、History 菜单，不能据此声称其桌面版也有相同能力。本报告关于桌面收藏的依据使用 Multilogin 文档。[Creating and managing profiles](https://support.gologin.com/en/articles/14816694-creating-and-managing-profiles)

## 后续实现提案：复用配置创建

### 产品语义

- 菜单名称用“复用配置创建”，不要把它叫完整克隆。
- 用户点击后打开可审阅的新建草稿，不马上落盘，也不启动浏览器。
- 草稿顶部说明来源环境和“新的指纹身份、空白会话”；来源名称只在本机显示，不写进 AI 请求。
- 初版只支持创建一个环境。需要批量时再接入带进度和逐项结果的任务流程。

### 初版允许带入的字段

| 字段 | 建议规则 |
| --- | --- |
| `engine` | 复制真实浏览器引擎，仍接受本机可用性检查。 |
| `chromiumRuntime` | 源环境为 Chromium 才复制；必须保持 CloakBrowser 与 AliasMode 的明确区分，不能把缺省值无意换成另一内核。 |
| `platformOs` | 复制有效的桌面 OS 配置；如果源为导入的移动身份或无可确认值，转到普通新建并让用户明确选择，不猜。 |
| `screen` | 复制合法配置值，保留现有分辨率校验。允许用户切回自动。 |
| `platform` | 复制规范化的平台域名。 |
| `group` | 草稿默认源分组，可改；如果分组已不可用，要求重新选择或回到未分组。 |
| `name` | 建议名称可编辑，例如“源名称 · 新环境”；不复用源 ID 或自定义编号。 |

### 默认不复制

`id`、`customNo`、`fingerprintSeed`、UA、硬件种子、Firefox 完整配置、导入指纹预期/观测、Cookies、会话文件、浏览器数据目录、账号用户名/密码/邮箱/2FA、代理凭据、上次启动时间、运行状态、收藏和任务记录。初版也不隐式复制源环境的扩展分配；仍遵循目标分组的新建默认值。

代理复用应作为单独且明确的选择。初版最稳妥的做法是保留当前新建草稿中的代理输入或留空，不通过模板保存密钥。后续需要“沿用源代理”时，使用受控服务端读取与明确的摘要预览，避免为了拿五个安全字段把整个编辑详情（含账号秘密）加载到前端。

### 与现有 API 的衔接

实施进度：2026-11-09 已完成只读来源接口 `GET /ui/api/profiles/:id/reuse`、严格校验客户端 `web/profile-reuse-api.ts` 与环境行菜单“复用配置创建”。读取成功后只打开普通新建草稿，继续由用户检查并提交；不直接创建。下述原始设计中的 `reusable-settings` 是示意名称，实际路由采用 `/reuse`。

1. 新增只读的安全配置视图，例如 `GET /ui/api/profiles/:id/reusable-settings`，返回上表中的 allowlist 与来源名称；不复用目前包含全部账号秘密的 `fetchProfileEdit` 响应。
2. 前端只把安全视图映射到 `BLANK_FORM`，来源身份字段从不进入草稿对象；新的读取需有代际/Abort 保护，迟到结果不能覆盖已打开的另一份草稿。
3. 提交继续走已有 `createProfile(NewProfileInput)` → `POST /ui/api/profiles` → `buildNewProfile`。该路径已生成新的 ID，并据新 ID 计算 `deterministicSeed(id)`，初始化 `cookies: []` 与 `seeded: false`。
4. 不把源 seed 放进 `NewProfileInput`；它本来就没有这个输入字段。Firefox 也通过新 ID 重新生成持久化配置，不能直接复制源 `firefox.config`。
5. 若需要将来源保存成预设，可复用 `ProfileTemplateSettings` 的严格五字段模型。它已明确拒绝额外字段，并不会带上身份或秘密；但目标分组与建议名称仍是草稿层信息。
6. `deterministicSeed` 是 32 位散列，不是数学上的一一映射。不要把“新 ID”宣传为绝不重复的所有指纹值；如果此入口明确承诺 seed 与源不同，应在服务端比较并有界重试生成，不能复用源 seed 后仅改 ID。

### 必须验证的行为

- 源环境带着所有秘密字段时，安全配置响应与新建请求均不含这些字段。
- 新环境生成新 ID，并按普通新建流程生成身份，不传入或复制源 seed；Cookie/运行记录为空；源环境和源文件完全不变。数值 seed 不作全局唯一承诺。
- Chromium 内核与 Firefox 引擎不会在映射时悄悄互换。
- 旧读取、源环境被删、分组消失、非法旧分辨率均有明确错误，不覆盖当前草稿。
- 取消不创建；双击只创建一次；失败保留可修改草稿。

## 代码审计位置

- `web/app.tsx`：`COLUMNS`、`matchingProfiles`、`beginCreate`、`submitCreate`、`bulkRun`、`paletteCommands`、创建/编辑模态框。
- `web/proxies.tsx`：现成的流式进度、失败重试、预览与受影响环境展示。
- `web/api.ts` / `ui.ts`：已有 `lastOpenAt`、创建 API、带秘密的编辑详情与已脱敏 roster。
- `create.ts`：新 ID、固定种子、空 Cookie 与 Firefox 配置生成。
- `profile-templates.ts` / `web/profile-templates.tsx`：安全五字段模板与现有预览。

最初的调研阶段未修改产品代码。随后单独实施的安全复用迭代已完成后端、客户端与真实 App 草稿入口；全程不复制账号、代理认证、Cookie、会话或原指纹身份。

### 安全复用的交付验证

- 来源接口按 allowlist 返回安全配置，覆盖两个浏览器引擎、非法 ID、404、移动身份拒绝与秘密不泄漏。
- 实际 App 的成功场景验证提交前无创建请求，且普通创建 payload 仅带安全配置与空账号/代理字段；下一份普通草稿不残留来源信息。
- 读取失败显示固定安全消息并可重试；导航离开或手动打开另一草稿会取消请求，模拟不遵守 Abort 的迟到响应也不能抢开或覆盖草稿。
- CloakBrowser 来源在此电脑强制 AliasMode 时明确显示内核变化，最终按本机要求创建；电脑仅默认不同内核时则保留来源选择。
- `bun test ./web/app-create.test.ts ./web/app-edit.test.ts ./web/profile-reuse-api.test.ts ./ui.test.ts`：125 通过，0 失败。交互测试保留完整动效，查询活动对话框时排除不可交互的退出快照。
