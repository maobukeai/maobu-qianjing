# 原生窗口关闭与未保存草稿

原生 `CloseRequested` 仍由 Rust 独占处理并立即 `prevent_close`。标题栏 X、Alt+F4、任务栏关闭都会先发同一带 session/request/delivery token 的自定义意图，不会仅依据“运行浏览器数为零”直接退出。

## Shell 接入

```tsx
const closeRegistry = useDesktopCloseRegistry();
useDesktopCloseDraft("profile-create", { dirty: createDirty, busy: creating, active: showCreate }, closeRegistry);
useDesktopCloseDraft("workspace-task", { dirty: false, busy: workspaceWriting }, closeRegistry);

return <DesktopCloseRegistryProvider registry={closeRegistry}>
  <DesktopCloseHost registry={closeRegistry} />
  {shell}
</DesktopCloseRegistryProvider>;
```

registry 和 Host 应覆盖 Shell 整个生命期，包括 loading/error 壳，不能随标签页或工作区 key 反复创建。App 自身的 hook 可显式传 registry；子面板从 Provider 获取：

```tsx
useDesktopCloseDraft("sync-settings", { dirty, busy: operationWritesData });
```

固定标签目前只有 `profile-create`、`profile-edit`、`extension-install`、`extension-defaults`、`sync-settings`、`update-settings`、`workspace-task`。API只接受固定key与dirty/busy/active布尔值；不传用户名、表单、密码、代理字符串、字段列表、任务ID。registry仅在内存中保存标签与布尔值，owner卸载自动释放。

`active` 表示这个草稿会话仍然存在，不等于页面可见。隐藏但仍保留的设置草稿，以及 App 持有的扩展草稿仍应保护。只有会话结束、真正不再持有草稿或工作区重置时才设false。

## 真实关闭流程

1. Rust保持窗口打开，将close-intent发往受信任main窗口；Host先以hold确认接收。
2. dirty时打开应用级alertdialog，默认“继续编辑”；busy时不提供退出按钮。完成保存不会自动退出。
3. Keep/Esc只请求取消。输入法合成中的Esc不会退出；Tab局限于当前确认层。原页面与其他portal临时inert/aria-hidden，属性在取消时恢复原值，输入节点不卸载。
4. Discard只发proceed，不清表单、不自动保存。Rust只消费匹配的token一次，然后沿用实际浏览器数量确认、会话保存、sidecar清理和退出。若后续原生浏览器确认取消，close-resolved恢复原焦点与全部草稿。
5. 重复X合并为同一request，并重新确认投递。8秒仅用于检测未收到接收ACK，绝不作为用户确认倒计时。已ACK且正在阅读确认层的用户不会被计时退出。
6. 未register、投递失败或重复关闭发现renderer失联时，显示归属main窗口的原生恢复警告。默认首项“继续使用”，Esc/取消也保留；只有精确选择“仍然退出”才继续现有cleanup。没有timeout自动批准。

命令register/unregister/resolve均经过main窗口及精确loopback origin验证。页面重挂、旧session、旧request、迟到ACK/resolve、卸载后的回调均不能批准后续关闭。Host不调用SDK `onCloseRequested` 或 `destroy()`，也不通过延时或动画决定退出。

动画只由现有MotionPresence保留不可交互的退出视觉；Reduced立即撤掉。IPC失败显示固定错误，不宣称已经关闭，不清草稿，也不显示原始底层错误。

## 验证与范围

`web/desktop-close-state.test.ts` 覆盖内存registry与协议竞态，`web/desktop-close.test.ts` 通过真实Host/Provider/hook的独立DOM进程验证交互与焦点。Rust单测覆盖单次token、旧session、重投递ACK、超时不批准、恢复按钮及现有关闭/更新互斥。

本模块需要Shell及真实dirty/busy owner注册才能保护业务草稿；独立Host测试不等于整个App已接入。系统强制结束、崩溃、OS关机以及已有显式restart/update路径不属于本次窗口关闭保护。最小化不销毁WebView，不需要草稿确认；目前没有托盘退出入口，未来增加时应接入同一协调器。

本轮仅运行Rust library测试与DOM测试，不执行cargo build，也不启动或操作现有原生验收实例。真实Alt+F4验收需Root在下一轮统一构建后另行完成。
