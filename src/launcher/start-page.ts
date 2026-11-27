import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Profile } from "../types.ts";
import { writeFileAtomic } from "./profile-bootstrap.ts";

export const START_PAGE_FILENAME = "maobu-start.html";

export interface StartPageInput {
  profile: Profile;
  serial?: number | null;
  exitIp?: string;
  engineLabel: string;
  kernelVersion?: string;
}

const TEST_SITES = [
  {
    name: "BrowserScan（中文）",
    url: "https://www.browserscan.net/zh",
    desc: "综合指纹 / IP / 时区 / WebRTC / 自动化检测（跨境首选）",
  },
  {
    name: "Ping0.cc",
    url: "https://ping0.cc/",
    desc: "原生 IP 纯净度 / 家宽与机房属性 / 风控值速查",
  },
  {
    name: "IPCheck.ing",
    url: "https://ipcheck.ing/",
    desc: "开源多源 IP 归属 / WebRTC 与 DNS 泄漏检测",
  },
  {
    name: "鸭啦啦 (Yalala)",
    url: "https://www.yalala.com/",
    desc: "全中文浏览器指纹防关联与环境一致性检测",
  },
  {
    name: "Whoer（中文）",
    url: "https://whoer.net/zh",
    desc: "经典伪装度评分 / 时区语言匹配 / 黑名单速查",
  },
] as const;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function sanitizeProxyLine(profile: Profile): { route: string; hasProxy: boolean } {
  if (!profile.proxy) {
    return { route: "直连 (未配置代理)", hasProxy: false };
  }
  const type = String(profile.proxy.type || "http").toLowerCase();
  const host = String(profile.proxy.host || "").trim();
  const port = String(profile.proxy.port ?? "").trim();
  // Security: intentionally omit username/password from persisted start-page HTML.
  return {
    route: host && port ? `${type}://${host}:${port}` : `${type} 代理`,
    hasProxy: true,
  };
}

function formatConfiguredOs(profile: Profile): string {
  const os = (profile.platformOs || "").trim().toLowerCase();
  if (os === "windows") return "Windows";
  if (os === "macos") return "macOS";
  if (os === "linux") return "Linux";
  return "自动 · 与本机一致";
}

export function renderStartPageHtml(input: StartPageInput): string {
  const { profile, serial, exitIp, engineLabel, kernelVersion } = input;
  const profileName = (profile.name || "未命名环境").trim();
  const serialBadge = profile.customNo?.trim()
    ? `#${profile.customNo.trim()}`
    : typeof serial === "number" && serial > 0
      ? `#${serial}`
      : "";
  const groupText = (profile.group || "").trim();
  const proxyInfo = sanitizeProxyLine(profile);
  const expectedTz = (profile.timezone || "").trim();
  const expectedLocale = (profile.locale || "").trim();
  const configuredOs = formatConfiguredOs(profile);
  const configuredScreen = profile.screenWidth && profile.screenHeight
    ? `${profile.screenWidth} × ${profile.screenHeight}`
    : "自动";
  const webRtcMode = proxyInfo.hasProxy
    ? (exitIp ? `代理感知 · 出口 ${exitIp}` : "代理感知 · 禁止 UDP 泄露")
    : "默认本地策略";

  const expectedPayload = escapeJsonForInlineScript({
    timezone: expectedTz,
    locale: expectedLocale,
    screenWidth: profile.screenWidth || 0,
    screenHeight: profile.screenHeight || 0,
  });

  const testSiteCards = TEST_SITES.map(
    (site) => `
      <a class="site-card" href="${escapeHtml(site.url)}" target="_blank" rel="noopener noreferrer">
        <div class="site-top">
          <strong>${escapeHtml(site.name)}</strong>
          <span class="site-arrow" aria-hidden="true">↗</span>
        </div>
        <p>${escapeHtml(site.desc)}</p>
      </a>
    `,
  ).join("");

  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(serialBadge ? `${serialBadge} ${profileName}` : profileName)} · 本机环境起始页</title>
<style>
  /* 与 猫步·千境 Folded Index 设计系统完全一致（默认浅色） */
  :root,
  html[data-theme="light"] {
    color-scheme: light;
    --bg: #f5f4f9;
    --header-bg: #f5f3f9;
    --surface: #ffffff;
    --surface-sunken: #f5f6fa;
    --surface-hover: #eef0f6;
    --surface-active: #e6e9f0;
    --ink: #17181c;
    --ink-soft: #383b45;
    --muted: #5f6473;
    --faint: #6f7585;
    --line: rgba(23, 24, 28, 0.08);
    --line-soft: rgba(23, 24, 28, 0.05);
    --line-strong: rgba(23, 24, 28, 0.14);
    --accent: #685ac9;
    --accent-ink: #5143a8;
    --accent-soft: rgba(104, 90, 201, 0.10);
    --accent-line: rgba(104, 90, 201, 0.25);
    --ok: #15803d;
    --ok-soft: rgba(22, 163, 74, 0.11);
    --warn: #b45309;
    --warn-soft: rgba(217, 119, 6, 0.12);
    --island-shadow: 0 4px 20px rgba(15, 17, 26, 0.05), 0 1px 2px rgba(15, 17, 26, 0.04);
    --island-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.85);
    --ctl-shadow: 0 1px 2px rgba(15, 17, 26, 0.08);
  }
  html[data-theme="dark"] {
    color-scheme: dark;
    --bg: #10121b;
    --header-bg: #151826;
    --surface: #181b2a;
    --surface-sunken: #131624;
    --surface-hover: #212539;
    --surface-active: #2a2f46;
    --ink: #f1f2f7;
    --ink-soft: #d2d5e3;
    --muted: #989db3;
    --faint: #6c728a;
    --line: rgba(255, 255, 255, 0.09);
    --line-soft: rgba(255, 255, 255, 0.05);
    --line-strong: rgba(255, 255, 255, 0.16);
    --accent: #8276e8;
    --accent-ink: #b5adff;
    --accent-soft: rgba(130, 118, 232, 0.16);
    --accent-line: rgba(130, 118, 232, 0.34);
    --ok: #4ade80;
    --ok-soft: rgba(34, 197, 94, 0.16);
    --warn: #fbbf24;
    --warn-soft: rgba(245, 158, 11, 0.16);
    --island-shadow: 0 8px 28px rgba(0, 0, 0, 0.38), 0 1px 2px rgba(0, 0, 0, 0.28);
    --island-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.06);
    --ctl-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Inter", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--ink);
    min-height: 100vh;
    padding: 24px 20px 44px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    transition: background-color 160ms ease, color 160ms ease;
  }
  .ico {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .wrap {
    max-width: 960px;
    margin: 0 auto;
    display: grid;
    gap: 14px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 16px 18px;
    box-shadow: var(--island-shadow), var(--island-highlight);
    transition: background-color 160ms ease, border-color 160ms ease;
  }
  .header-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px 16px;
  }
  .brand-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 9px;
  }
  .brand-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px 4px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    border: 1px solid var(--accent-line);
    color: var(--accent-ink);
    font-size: 12px;
    font-weight: 600;
  }
  .brand-logo {
    width: 16px;
    height: 16px;
    border-radius: 5px;
    background: var(--accent);
    color: #fff;
    display: grid;
    place-items: center;
  }
  h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid var(--line);
    background: var(--surface-sunken);
    color: var(--ink-soft);
  }
  .pill-ok {
    background: var(--ok-soft);
    border-color: transparent;
    color: var(--ok);
  }
  .pill-warn {
    background: var(--warn-soft);
    border-color: transparent;
    color: var(--warn);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  /* 与顶栏一致的太阳 / 月亮分段主题切换 */
  .theme-seg {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: 999px;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
  }
  .theme-btn {
    border: 0;
    background: transparent;
    color: var(--muted);
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 500;
    padding: 3px 9px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    transition: background-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
  }
  .theme-btn:hover { color: var(--ink); }
  .theme-btn[aria-checked="true"] {
    background: var(--surface);
    color: var(--ink);
    font-weight: 600;
    box-shadow: var(--ctl-shadow);
  }
  .theme-btn:focus-visible,
  .btn-copy:focus-visible,
  .site-card:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 13px 15px;
    box-shadow: var(--island-shadow), var(--island-highlight);
    display: grid;
    gap: 6px;
    align-content: start;
    transition: background-color 160ms ease, border-color 160ms ease;
  }
  .stat-label {
    font-size: 12px;
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .stat-label-title {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .stat-value {
    font-size: 14.5px;
    font-weight: 600;
    color: var(--ink);
    overflow-wrap: anywhere;
    font-variant-numeric: tabular-nums;
  }
  .stat-sub {
    font-size: 11.5px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .section-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    margin-bottom: 12px;
  }
  .section-head h2 {
    margin: 0;
    font-size: 14.5px;
    font-weight: 600;
    letter-spacing: -0.015em;
  }
  .section-head span {
    font-size: 12px;
    color: var(--muted);
  }
  /* 2x2 严密对称排布，避免 3+1 落单 */
  .kv-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 12px;
  }
  .kv-item {
    padding: 11px 13px;
    border-radius: 10px;
    background: var(--surface-sunken);
    border: 1px solid var(--line-soft);
    display: grid;
    gap: 4px;
  }
  .kv-item span { font-size: 11.5px; color: var(--muted); }
  .kv-item strong { font-size: 13px; font-weight: 600; color: var(--ink); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .ua-box {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--surface-sunken);
    border: 1px solid var(--line-soft);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .ua-text {
    min-width: 0;
    flex: 1;
    font-family: ui-monospace, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11.5px;
    color: var(--ink-soft);
    overflow-wrap: anywhere;
  }
  .btn-copy {
    flex: 0 0 auto;
    border: 1px solid var(--line-strong);
    background: var(--surface);
    color: var(--ink);
    font-family: inherit;
    font-size: 12px;
    font-weight: 550;
    padding: 5px 12px;
    border-radius: 8px;
    box-shadow: var(--ctl-shadow);
    cursor: pointer;
    transition: border-color 140ms ease, color 140ms ease, background-color 140ms ease;
  }
  .btn-copy:hover {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .sites-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 10px;
  }
  .site-card {
    display: grid;
    gap: 5px;
    align-content: start;
    padding: 11px 12px;
    border-radius: 10px;
    background: var(--surface-sunken);
    border: 1px solid var(--line-soft);
    color: inherit;
    text-decoration: none;
    transition: border-color 140ms ease, background-color 140ms ease, transform 140ms ease;
  }
  .site-card:hover {
    border-color: var(--accent-line);
    background: var(--surface-hover);
    transform: translateY(-1px);
  }
  .site-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .site-top strong { font-size: 13px; font-weight: 600; color: var(--ink); }
  .site-arrow {
    font-size: 13px;
    color: var(--accent-ink);
    transition: transform 140ms ease;
  }
  .site-card:hover .site-arrow { transform: translate(1.5px, -1.5px); }
  .site-card p { margin: 0; font-size: 11.5px; color: var(--muted); line-height: 1.45; }
  .foot-note {
    margin: 2px 0 0;
    text-align: center;
    font-size: 11.5px;
    color: var(--faint);
  }
  @media (max-width: 860px) {
    .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .sites-grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  }
  @media (max-width: 620px) {
    .kv-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 500px) {
    .summary-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <div class="header-row">
        <div class="brand-line">
          <span class="brand-tag">
            <span class="brand-logo" aria-hidden="true">
              <svg class="ico" style="width:11px;height:11px;stroke-width:2.2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18"/></svg>
            </span>
            猫步·千境
          </span>
          <h1>${escapeHtml(serialBadge ? `${serialBadge} · ${profileName}` : profileName)}</h1>
          ${groupText ? `<span class="pill">${escapeHtml(groupText)}</span>` : ""}
        </div>
        <div class="pills">
          <span class="pill">${escapeHtml(kernelVersion ? `${engineLabel} · ${kernelVersion}` : engineLabel)}</span>
          <span class="pill pill-ok"><span class="dot" aria-hidden="true"></span>本地零流量起始页 · 0 代理消耗</span>
          <div class="theme-seg" role="radiogroup" aria-label="起始页主题">
            <button type="button" class="theme-btn" role="radio" data-theme-choice="light" aria-checked="true">
              <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
              浅色
            </button>
            <button type="button" class="theme-btn" role="radio" data-theme-choice="dark" aria-checked="false">
              <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>
              深色
            </button>
          </div>
        </div>
      </div>
    </section>

    <section class="summary-grid" aria-label="环境状态概览">
      <div class="stat-card">
        <div class="stat-label">
          <span class="stat-label-title">
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
            代理线路
          </span>
        </div>
        <div class="stat-value">${escapeHtml(proxyInfo.route)}</div>
        <div class="stat-sub">${escapeHtml(exitIp ? `已匹配出口 IP：${exitIp}` : proxyInfo.hasProxy ? "不消耗额外外部探测流量" : "当前未启用代理")}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">
          <span class="stat-label-title">
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
            时区一致性
          </span>
          <span class="pill" id="tzBadge">检测中</span>
        </div>
        <div class="stat-value" id="actualTz">--</div>
        <div class="stat-sub">预期：${escapeHtml(expectedTz || "跟随系统 / 启动匹配")}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">
          <span class="stat-label-title">
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6"/></svg>
            语言一致性
          </span>
          <span class="pill" id="langBadge">检测中</span>
        </div>
        <div class="stat-value" id="actualLang">--</div>
        <div class="stat-sub">预期：${escapeHtml(expectedLocale || "自动跟随")}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">
          <span class="stat-label-title">
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5.5 3.4 9.8 8 11 4.6-1.2 8-5.5 8-11V5l-8-3z"/><path d="m9 12 2 2 4-4"/></svg>
            系统与 WebRTC
          </span>
        </div>
        <div class="stat-value">${escapeHtml(configuredOs)}</div>
        <div class="stat-sub">${escapeHtml(webRtcMode)}</div>
      </div>
    </section>

    <section class="card" aria-label="浏览器实测指纹">
      <div class="section-head">
        <h2>浏览器实时读取（离线本机自检）</h2>
        <span>配置屏幕：${escapeHtml(configuredScreen)}</span>
      </div>
      <div class="kv-grid">
        <div class="kv-item"><span>实测屏幕与缩放 (Screen / DPR)</span><strong id="fpScreen">--</strong></div>
        <div class="kv-item"><span>实测处理器核数 (CPU)</span><strong id="fpCores">--</strong></div>
        <div class="kv-item"><span>实测平台 (navigator.platform)</span><strong id="fpPlatform">--</strong></div>
        <div class="kv-item"><span>实测图形渲染器 (WebGL Renderer)</span><strong id="fpWebgl">--</strong></div>
      </div>
      <div class="ua-box">
        <div class="ua-text" id="fpUa">--</div>
        <button type="button" class="btn-copy" id="btnCopyUa">复制 UA</button>
      </div>
    </section>

    <section class="card" aria-label="按需外部检测站">
      <div class="section-head">
        <h2>按需外网体检（点击才打开，平时零流量）</h2>
        <span>建议新代理或新环境抽检 1 次，日常业务号无需每次打开</span>
      </div>
      <div class="sites-grid">${testSiteCards}</div>
    </section>

    <p class="foot-note">本页由本地离线渲染，不产生任何网络请求；可在「设置 → 网络与代理 → 浏览器启动」随时关闭。</p>
  </main>

<script>
  const THEME_KEY = "maobu.startPage.theme";
  const applyStartPageTheme = (choice) => {
    const next = choice === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
      btn.setAttribute("aria-checked", btn.getAttribute("data-theme-choice") === next ? "true" : "false");
    });
  };
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") applyStartPageTheme(saved);
    else applyStartPageTheme("light");
  } catch {
    applyStartPageTheme("light");
  }
  document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const choice = btn.getAttribute("data-theme-choice") === "dark" ? "dark" : "light";
      applyStartPageTheme(choice);
      try { localStorage.setItem(THEME_KEY, choice); } catch {}
    });
  });

  const EXPECTED = ${expectedPayload};
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const setBadge = (id, ok, text) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = "pill " + (ok === true ? "pill-ok" : ok === false ? "pill-warn" : "");
  };

  let actualTz = "";
  try { actualTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch {}
  setText("actualTz", actualTz || "未知");
  if (!EXPECTED.timezone) {
    setBadge("tzBadge", null, "自动");
  } else if (actualTz === EXPECTED.timezone) {
    setBadge("tzBadge", true, "一致");
  } else {
    setBadge("tzBadge", false, "不一致");
  }

  const actualLang = navigator.language || "";
  const langs = Array.isArray(navigator.languages) ? navigator.languages.join(", ") : actualLang;
  setText("actualLang", langs || "未知");
  if (!EXPECTED.locale) {
    setBadge("langBadge", null, "自动");
  } else if (actualLang.toLowerCase() === EXPECTED.locale.toLowerCase()) {
    setBadge("langBadge", true, "一致");
  } else {
    setBadge("langBadge", false, "已覆盖");
  }

  setText("fpScreen", screen.width + " × " + screen.height + " · @" + (window.devicePixelRatio || 1) + "x");
  setText("fpCores", navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) + " 核" : "未知");
  setText("fpPlatform", navigator.platform || "未知");
  setText("fpUa", navigator.userAgent || "未知");

  let webglRenderer = "未暴露 / 已禁用";
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      if (raw) webglRenderer = String(raw);
    }
  } catch {}
  setText("fpWebgl", webglRenderer);

  const btnCopy = document.getElementById("btnCopyUa");
  if (btnCopy) {
    btnCopy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(navigator.userAgent || "");
        btnCopy.textContent = "已复制";
        setTimeout(() => { btnCopy.textContent = "复制 UA"; }, 1800);
      } catch {
        btnCopy.textContent = "复制失败";
        setTimeout(() => { btnCopy.textContent = "复制 UA"; }, 1800);
      }
    });
  }
</script>
</body>
</html>`;
}

export async function writeProfileStartPage(userDataDir: string, input: StartPageInput): Promise<string> {
  const filePath = join(userDataDir, START_PAGE_FILENAME);
  await writeFileAtomic(filePath, renderStartPageHtml(input));
  return pathToFileURL(filePath).href;
}
