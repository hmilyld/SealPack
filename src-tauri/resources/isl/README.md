# Inno Setup 语言包

这里放**官方发行版里没有、但生成的安装包需要**的语言文件。

## 为什么需要它

生成的 `.iss` 里有一行：

```
[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"
```

`ChineseSimplified.isl`（简体中文）**不在 Inno Setup 的官方发行版里** ——
官方 `Languages\` 目录只带 29 种语言，中文属于「用户贡献的翻译」，
要从 <https://jrsoftware.org/files/istrans/> 单独下载。

所以如果按 `compiler:Languages\ChineseSimplified.isl` 去引用，
在任何标准安装上都会编译失败（`Couldn't open include file`），
只有在手工往 Inno 目录里放过这个文件、或者本机恰好有一份旧版 Inno 的机器上才能跑通。

改成「随本应用分发一份、用相对路径引用」之后，就不依赖 Inno 的安装目录长什么样了：
打包阶段会把这份文件复制到临时脚本旁边，ISCC 按脚本所在目录解析相对路径。

## 文件来源

`ChineseSimplified.isl` 取自 Inno Setup 官方翻译页列出的用户贡献翻译
（<https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation>），
文件头标注为适配 **Inno Setup 6.5.0+**。本应用声明下载的 Inno 版本是 6.7.3，在范围内。

> 实测：用 Inno Setup 6.7 编译时，这份翻译**零警告**。
> 若将来升级 Inno 到引入了新消息键的版本，需要同步换一份更新的翻译，
> 否则编译会输出 `A message named "…" has not been defined` 警告（会回退到英文，不致命）。
