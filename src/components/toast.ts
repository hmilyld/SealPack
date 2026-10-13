type Kind = "info" | "success" | "error";

/**
 * 提示条的容器。
 *
 * 带上 `role="status" aria-live="polite"`：toast 是最主要的操作反馈通道
 * （保存失败、下载失败、阶段结果都走它），没有 live region 的话读屏用户
 * 完全感知不到。错误条自身再用 `role="alert"` 提升为「立即播报」。
 */
function host(): HTMLElement {
  let el = document.getElementById("toast-host");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-host";
    el.className = "toast-host";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  return el;
}

export function toast(message: string, kind: Kind = "info"): void {
  const el = document.createElement("div");
  el.className = kind === "info" ? "toast" : `toast is-${kind}`;
  el.textContent = message;
  if (kind === "error") el.setAttribute("role", "alert");
  host().appendChild(el);

  requestAnimationFrame(() => el.classList.add("is-in"));

  window.setTimeout(
    () => {
      el.classList.remove("is-in");
      window.setTimeout(() => el.remove(), 220);
    },
    kind === "error" ? 5200 : 3000,
  );
}
