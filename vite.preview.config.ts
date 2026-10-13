import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

/**
 * 预览专用构建配置。
 *
 * 为什么不把 preview.html 直接加进主配置：Tauri 的 frontendDist 指向 dist/，
 * 主构建里多一个 preview.html 就等于把一个「假的 Tauri IPC 层」打进安装包。
 * 所以预览走独立配置 + 独立输出目录，只在本地验证界面时使用。
 *
 * 用 `pnpm run build:preview` 生成 dist-preview/，然后可以直接用 file:// 打开
 * （`base: "./"` 让资源引用变成相对路径），不需要起 dev server。
 */
export default mergeConfig(
  base,
  defineConfig({
    base: "./",
    build: {
      outDir: "dist-preview",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: "index.html",
          preview: "preview.html",
        },
      },
    },
  }),
);
