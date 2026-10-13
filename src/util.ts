/**
 * 跨模块共用的小工具。
 *
 * 这三件事原本在 `main.ts` 与 `components/file-picker.ts` 里各写了一份
 * （HTML 转义、取文件名、相对路径），两份实现会各自漂移。尤其 `relativeTo`
 * 必须与 Rust 侧 `model::relative_to` 保持同一套语义 —— 只留一份才谈得上「一致」。
 */

/** HTML 转义。所有拼进 `innerHTML` 的动态文本都必须先过它。 */
export const esc = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** 路径末段（文件名或目录名）。 */
export const baseName = (path: string): string => path.replace(/^.*[\\/]/, "");

/**
 * 把绝对路径转成相对 `root` 的路径；不在 `root` 下则原样返回。
 *
 * 与 Rust 侧 `model::relative_to` 的约定（两边必须一致）：
 *   · 分隔符统一成 `\` —— Inno 的 `Excludes` 用的是 Windows 写法；
 *   · 大小写不敏感 —— Windows 上 `D:\App` 与 `d:\app` 是同一个目录，
 *     而 Rust 的 `Path::strip_prefix` 是逐字节比较的，不显式忽略大小写就会
 *     把 `d:\app\lib.dll` 判成「不在 root 下」，于是 `Excludes` 里写进一条
 *     绝对路径、永远匹配不上，等于没排除。
 */
export function relativeTo(root: string, full: string): string {
  const norm = (s: string) => s.replace(/\//g, "\\").replace(/\\+$/, "");
  const r = norm(root);
  const f = norm(full);
  if (r && f.length > r.length && f.slice(0, r.length).toLowerCase() === r.toLowerCase()) {
    return f[r.length] === "\\" ? f.slice(r.length + 1) : f;
  }
  return f;
}

/**
 * 该路径是否位于 `root` 之下（大小写不敏感，用于判断合并项是否仍有效）。
 *
 * 多要求一位分隔符，避免把 `D:\AppExtra\x.dll` 误判成在 `D:\App` 之下。
 */
export function isUnder(root: string, full: string): boolean {
  const norm = (s: string) => s.replace(/\//g, "\\").replace(/\\+$/, "");
  const r = norm(root);
  const f = norm(full);
  if (!r || f.length <= r.length) return false;
  if (f.slice(0, r.length).toLowerCase() !== r.toLowerCase()) return false;
  return f[r.length] === "\\";
}
