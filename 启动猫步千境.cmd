@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [猫步·千境] 正在同步最新前端与后端代码...
call bun --no-env-file run desktop:prepare
if errorlevel 1 (
  echo [猫步·千境] 准备本地运行资源失败。
  pause
  exit /b 1
)
echo [猫步·千境] 正在增量同步桌面端程序...
cargo build --manifest-path src-tauri\Cargo.toml
if errorlevel 1 (
  echo [猫步·千境] 编译桌面端程序失败。
  pause
  exit /b 1
)
echo [猫步·千境] 正在启动本地桌面版...
node scripts\run-local-desktop.mjs
if errorlevel 1 pause
