/**
 * 桌面化行为层。
 *
 * WebView2 默认带着一整套浏览器行为，这些是「网页感」最直接的来源：
 *   - Ctrl+R / F5 刷新、Ctrl+P 打印、Ctrl+F 查找、Ctrl+U 看源码、F12 开发者工具；
 *   - Ctrl +/-/0 与 Ctrl+滚轮缩放整个界面；
 *   - 把界面文字/图片拖出去、把文件拖进来触发导航；
 *   - 右键弹出 WebView2 的原生菜单；
 *   - Backspace 在没有焦点时触发「后退」。
 *
 * 本地程序不该有这些。本模块统一关掉，并提供一个平台无关的快捷键注册表，
 * 让快捷键在界面里可见、可用、可预期（Windows 用 Ctrl，macOS 用 Cmd）。
 */

import { showWindow } from "./api";

// ---------------------------------------------------------------- 快捷键注册表

type ShortcutHandler = (event: KeyboardEvent) => void;

const registry = new Map<string, ShortcutHandler>();
let shortcutsInstalled = false;

/** macOS 用 Cmd，其它平台用 Ctrl；两处都写 `mod` 即可。 */
const isMac = /mac/i.test(navigator.userAgent);
const hasMod = (event: KeyboardEvent) => (isMac ? event.metaKey : event.ctrlKey);

/** 界面上展示快捷键时用的文案，如 `Ctrl+W` / `⌘W`。 */
export function shortcutLabel(key: string): string {
  return isMac ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

function normalize(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (hasMod(event)) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(event.key.toLowerCase());
  return parts.join("+");
}

function onShortcutKeydown(event: KeyboardEvent): void {
  const handler = registry.get(normalize(event));
  if (!handler) return;
  event.preventDefault();
  // 刻意**不** stopPropagation：快捷键表是「全局兜底」，不该抢走浮层自己要处理的键。
  // 之前这里调了 stopPropagation，而它在 window 的捕获阶段跑，
  // 于是 Esc 永远到不了 document 上的监听 —— 对话框按 Esc 关不掉。
  // 阻止浏览器默认行为用 preventDefault 就够了。
  handler(event);
}

/** 注册快捷键，返回取消注册函数。全局只有一个 keydown 监听。 */
export function registerShortcut(combo: string, handler: ShortcutHandler): () => void {
  if (!shortcutsInstalled) {
    window.addEventListener("keydown", onShortcutKeydown, { capture: true });
    shortcutsInstalled = true;
  }
  const key = combo.toLowerCase();
  registry.set(key, handler);
  return () => {
    registry.delete(key);
  };
}

// ---------------------------------------------------------------- 关闭浏览器行为

/** 这些组合键在 WebView2 里对应浏览器功能，一律拦掉。 */
const BLOCKED_MOD_KEYS = new Set(["r", "p", "f", "u", "g", "j", "o", "s", "d", "l"]);
const BLOCKED_KEYS = new Set(["F5", "F7", "F12"]);

function onKeydownBlock(event: KeyboardEvent): void {
  const mod = hasMod(event);
  const key = event.key;

  if (BLOCKED_KEYS.has(key)) {
    event.preventDefault();
    return;
  }

  // Ctrl+Shift+I / J / C：开发者工具与元素检查
  if (mod && event.shiftKey && ["i", "j", "c"].includes(key.toLowerCase())) {
    event.preventDefault();
    return;
  }

  // 浏览器缩放：Ctrl + 加/减/0
  if (mod && ["+", "-", "=", "0"].includes(key)) {
    event.preventDefault();
    return;
  }

  if (mod && BLOCKED_MOD_KEYS.has(key.toLowerCase())) {
    event.preventDefault();
    return;
  }

  // Backspace 在没有输入焦点时不该「后退」
  if (key === "Backspace") {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName ?? "";
    if (tag !== "INPUT" && tag !== "TEXTAREA" && !target?.isContentEditable) {
      event.preventDefault();
    }
  }
}

/**
 * 装上所有桌面化行为。应在应用启动时调用一次。
 * 返回卸载函数（仅用于测试）。
 */
export function installDesktopBehaviour(): () => void {
  // 1. 拦掉浏览器快捷键（capture 阶段，先于业务快捷键判断）
  window.addEventListener("keydown", onKeydownBlock, { capture: true });

  // 2. Ctrl + 滚轮缩放整个界面 → 拦掉
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) event.preventDefault();
  };
  window.addEventListener("wheel", onWheel, { passive: false });

  // 3. 禁止把界面里的东西拖出去（拖动 = 网页行为）
  const onDragStart = (event: DragEvent) => event.preventDefault();
  window.addEventListener("dragstart", onDragStart);

  // 4. 禁止把文件拖进窗口触发导航。留出 .drop-target 作为将来的文件拖放入口。
  const onDragOver = (event: DragEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(".drop-target")) return;
    event.preventDefault();
  };
  const onDrop = (event: DragEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(".drop-target")) return;
    event.preventDefault();
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);

  // 5. 右键菜单：默认全部禁用；具体区域（工程行、文件树、输入框、日志）
  //    由 context-menu 模块自己挂监听并弹出应用内菜单。
  const onContextMenu = (event: MouseEvent) => event.preventDefault();
  window.addEventListener("contextmenu", onContextMenu);

  // 6. 双击空白处选中文字、三击全选段落这类行为在界面上没意义，交给 CSS 的 user-select 处理

  return () => {
    window.removeEventListener("keydown", onKeydownBlock, { capture: true });
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("dragstart", onDragStart);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("drop", onDrop);
    window.removeEventListener("contextmenu", onContextMenu);
  };
}

// ---------------------------------------------------------------- 窗口生命周期

/**
 * 首帧绘制完成后显示窗口。窗口在 tauri.conf.json 里以 `visible: false` 创建，
 * 这样「写皮肤 → 绘制 → 显示」的顺序保证用户第一眼看到的就是正确皮肤，不闪白底。
 * Rust 侧另有一个 1.5s 的兜底显示，前端脚本出错也不会让窗口永不出现。
 */
export function revealWindowWhenReady(): void {
  // 两帧 rAF：确保样式已应用、首帧已提交
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void showWindow().catch(() => {});
    });
  });
}
