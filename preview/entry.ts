// 预览入口。
//
// 为什么需要它：Vite 的 MPA 构建里，如果两个 HTML 引用同一个入口模块，
// 第二个 HTML 只会拿到 `<link rel="modulepreload">`，**不会真的执行它** ——
// 预览页会渲染出一片空白（只剩 mock 在跑，界面代码从未启动）。
// 所以预览页改成引用这个唯一入口。
//
// 为什么 main 必须用动态 import：静态 import 会被提升到模块顶部，
// 打包时 main 会被拆成独立 chunk 并优先求值，于是界面先跑、mock 后装，
// bootstrap() 里 `window.__TAURI_INTERNALS__.invoke` 直接炸掉
// （dev 下 ESM 原生按声明顺序求值，看不出这个问题，只有构建产物会暴露）。
// 动态 import 保证 mock 的安装先完成，再启动界面。
import "./mock";

void import("../src/main");
