# 选项参考

## 机制：选项是一份声明式 schema

选项不是「散落的一堆布尔」，而是一份声明式描述，位于 `src/types.ts` 的 `ENCRYPT_GROUPS` / `PACKAGE_GROUPS`。
每个字段带：

| 属性 | 含义 |
| --- | --- |
| `key` | `EncryptOptions` / `PackageOptions` 上的字段名 |
| `kind` | `bool` / `enum` / `number` / `text` / `path` —— 决定渲染成什么控件 |
| `label` / `hint` | 名称与适用场景说明（`hint` 是「什么情况下用它、代价是什么」） |
| `def` | 默认值。界面上标注「默认 X」，改过之后变色；「恢复默认」按钮按它整组重置 |
| `choices` / `min` / `max` / `unit` | 枚举取值、数值范围与单位 |
| `when` | 条件显示：只在主开关处于给定取值时才出现（`negate` 用于「填了内容才出现」） |
| `writes` | 该选项会写进模板的什么内容，渲染成选项行的悬停提示 |

界面按这份描述渲染，回归探针也按它断言 —— **加一个选项 = 在 schema 里加一条，不需要动渲染代码**。

取值最终由 Rust 侧收敛：不认识的枚举值一律退回默认值（`defaults.rs::pick`），
`elements` 会被规整成 `S`/`N`/`P`/`I` 的子集。这样即使有人手改工程 JSON 写错一个字母，
也不会把一句看不懂的语法错误甩给 ConfuserEx / ISCC。

---

## 加密选项（ConfuserEx）

共 36 项，按加密算法的三个族分成 5 组。

### 组 1 · 保护强度预设

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `preset` | `normal` | 写进 `<rule preset="…">`。显式开启的 protection 会覆盖预设里的同名项，所以它更像「兜底强度」。可选 `none` / `minimum` / `normal` / `aggressive` / `maximum` |

四档一键预设（`ENCRYPT_PRESETS`）会一次性把下面一组开关摆到合理位置，之后仍可逐项微调：

| 预设 | 定位 |
| --- | --- |
| 不加密 | 只做合并与打包，加密阶段自动跳过 |
| 基础 | 内部工具、快速验证：重命名（letters）+ 常量加密，几乎不影响启动速度 |
| 标准（推荐） | 常规商业分发：重命名 + 常量加密 + 控制流 + 反调试，兼容性风险低 |
| 严格 | 高价值授权软件：再加反篡改、防转储、强化。可能有兼容性风险，务必回归测试 |

### 组 2 · 反编译与防篡改

目标是「让静态分析变贵、让改动被发现」。这几项对启动速度的影响都很小。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `antiIldasm` | 关 | 阻止 ILDASM 等工具直接打开程序集。零成本 |
| `antiDebug` | 关 | 检测调试器 / 分析器并阻止附加。对使用性能分析工具的场景不友好 |
| `debugMode` | `safe` | 反调试引擎：`safe` 走托管 API（兼容性最好）/ `win32` 走 WinAPI（仅 Windows）/ `antinet` 最强但不兼容 Mono |
| `antiTamper` | 关 | 用整个模块的校验和加密方法体：任何字节被改动程序就加载不起来。副作用是反编译器里方法体全是空的，且会产生不可验证的模块 |
| `tamperMode` | `normal` | 校验时机：`normal` 启动时校验一次 / `jit` 每次方法编译前校验（更难绕过、兼容性差） |
| `tamperKey` | `normal` | 密钥派生：`normal` 静态算法 / `dynamic` 动态生成算法 |
| `antiDump` | 关 | 阻止把解密后的程序集从内存 dump 出来。依赖 WinAPI，仅 Windows |
| `invalidMetadata` | 关 | 写入畸形元数据让反编译器解析出错。对运行时无影响，但某些扫描工具会误报 |
| `harden` | 关 | 加固其它 protection 的运行时，显著提高「脱壳」成本。只在同时启用了别的保护时才有意义 |

### 组 3 · 代码混淆

目标是「反编译出来的代码读不懂、也编译不回去」。重命名最有效，但对反射密集的程序有风险。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `rename` | 关 | 把类名、方法名改成无意义字符。注意：按名字反射查找、或通过序列化跨程序集通信的程序可能被破坏 |
| `renameMode` | `unicode` | `unicode` 最难读但反射会失效 / `letters` 兼容性最好 / `sequential` 输出 `symbols.map` 便于用崩溃日志里的名字反查 / `decodable` 可解码 + `symbols.map` / `reversible` 用口令加密符号名 / `retain` 不重命名 |
| `renamePassword` | 空 | 仅 `reversible` 下生效。上线后收到崩溃日志可用它把混淆名还原成原始名 |
| `renameArgs` | **开** | 连方法参数名一起重命名（参数名会出现在堆栈与反射结果里） |
| `renEnum` | 关 | 重命名枚举成员。枚举成员名常被当作字符串序列化或写进配置，开启前要确认没有依赖名字的地方 |
| `renPublic` | 关 | 重命名公开成员。供外部调用的类库**不要**开 —— 调用方是按名字找的 |
| `controlFlow` | 关 | 打乱方法内部的控制流。体积会明显增大，执行也变慢 |
| `cfType` | `switch` | `switch` 用状态机重排（推荐）/ `jump` 插入跳转制造面条代码，会产生不可验证的模块 |
| `cfPredicate` | `normal` | 状态变量存放方式：`normal` 直接存 / `expression` 用动态表达式编码 / `x86` 用原生 x86 表达式（会破坏 AnyCPU） |
| `cfIntensity` | `60` | 0–100。数值越小，每个基本块被切得越碎、越难读，但执行越慢 |
| `cfDepth` | `4` | 1–16，仅在状态变量用 `expression` / `x86` 时生效。越深越难还原，编译越慢 |
| `cfJunk` | 关 | 在方法里塞入永不执行的代码干扰阅读。明显增大体积，且会产生不可验证的模块 |
| `refProxy` | 关 | 把字段 / 方法的直接引用改成间接调用，隐藏「谁调用了谁」 |
| `refMode` | `mild` | `mild` 加一层间接方法（轻量）/ `strong` 用动态委托（更难还原但更慢） |
| `refInternal` | 关 | 默认只代理跨程序集调用；打开后程序集内部的调用也走代理 |

### 组 4 · 数据加密（对称）

把常量与内嵌资源编码后存放，运行时再解码 —— 这是 .NET 程序集里最直接的「对称加密」落点，
密钥由 ConfuserEx 随机生成并藏进解码器。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `constants` | 关 | 加密字符串与数字常量，让反编译出来的代码里看不到关键字、接口地址、密钥片段 |
| `constMode` | `normal` | `normal` 带随机参数的静态算法 / `dynamic` 现场生成算法 / `x86` 生成原生 x86 表达式（最强，但破坏 AnyCPU） |
| `constElements` | `SI` | 加密哪些常量：`S` 字符串、`N` 数字、`P` 常用值（0/1/-1）、`I` 数组初始化器，可组合。`P` 必须与 `S` 或 `N` 同时出现 |
| `constCfg` | 关 | 把解码过程绑定到控制流状态变量上，静态还原难度大幅提高，代价是运行时性能有可感知下降 |
| `resources` | 关 | 加密内嵌资源（图标、配置文件、内嵌脚本）。资源在加载时解码，启动会稍慢。若已开压缩器，可只留一项以免重复压缩 |
| `resMode` | `normal` | `normal` 静态算法 + 随机参数 / `dynamic` 现场生成算法 |

### 组 5 · 签名与复现（非对称 / 哈希）

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `snKeyPath` | 空 | 强名称密钥（`.snk` / `.pfx`）。用 RSA 私钥给程序集签名，运行时可验证未被替换。留空则不签名。生成密钥：`sn -k app.snk` |
| `snKeyPass` | 空 | 仅当上面给的是 `.pfx` 容器时才需要。`.snk` 一般没有口令 |
| `seed` | 空 | ConfuserEx 的加密参数是随机的。填一个固定值，同样的输入就能得到字节一致的输出，便于「同一版本重新打包应完全一致」这类校验 |
| `debugSymbols` | 关 | 保留 `.pdb`。线上排障需要它来还原堆栈行号，但发布给用户的包里通常不该带 |
| `compress` | **开** | 把程序集压缩后加载，体积更小、加载稍慢。与「资源加密」同时开启会压缩两次，二选一即可 |

---

## 打包选项（Inno Setup）

共 19 项，分 5 组。

### 组 1 · 压缩格式

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `compression` | `lzma2/max` | Inno 的压缩格式是「算法 + 等级」写成一个值。可选 `lzma2/max` / `lzma2/normal` / `lzma2/fast` / `lzma/max` / `lzma/normal` / `lzma/fast` / `zip` / `bzip` / `none` |
| `solidCompression` | **开** | 把多个文件放在一起联合压缩，压缩率更高；文件很多时编译明显变慢。不压缩时该项无效 |
| `lzmaDictionarySize` | `0` | 单位 KB。0 表示不写这一行、交给 Inno 按压缩等级自动决定（推荐）。有效范围 4–3932160（64 位编译器），低于 4 的值会被 ISCC 拒绝所以不写入 |
| `lzmaNumBlockThreads` | `0` | 0 表示不写这一行，Inno 用它自己的默认值 1。官方范围 1–256。切块并行会略微降低压缩率，且每个块线程理想上需要两个处理器核心 |
| `lzmaMatchFinder` | `bt` | `BT`（二叉树）压缩率更高但更吃内存 / `HC`（哈希链）省内存、略快 |
| `lzmaUseSeparateProcess` | 关 | 32 位编译器在用了大字典 + 多线程后报「内存不足」时打开它 |
| `packagingMode` | `single` | `single` 标准安装程序 / `portable` 免安装绿色版（不写注册表、不生成卸载程序、不建快捷方式）/ `multi_volume` 拆成 `Setup-*.bin` 分卷（压缩后超过 4.2GB 时 Inno 会强制要求） |
| `diskSliceSize` | `0` | 单位字节。官方有效范围 262144–9223372036800000000，低于下界的值不写入。0 表示用 Inno 默认的 2100000000（约 2GB） |
| `slicesPerDisk` | `1` | 官方范围 1–26。大于 1 时文件命名为 `Setup-xy.bin` |

### 组 2 · 打包模式

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `requireAdmin` | 关 | 打开后装到 `Program Files`（安装时弹 UAC）；关闭则装到当前用户目录，全程不需要提权 |
| `wizardStyle` | `modern` | `modern` 是 Inno 6 的新式向导（推荐）/ `classic` 是旧版经典样式（Inno 自己的默认）。官方还支持 `dark` / `dynamic` 等外观模式，本工具只暴露两档基础样式 |

### 组 3 · 安装包加密与签名

加密用 XChaCha20 对称加密，密钥由口令经 PBKDF2-HMAC-SHA256 派生；签名用 Authenticode 证书，属于非对称加密。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `encryption` | `yes` | `yes` 只加密文件内容，安装时弹框输入口令 / `full` 连安装界面一起加密，因此运行时没有输入框可用，必须用 `安装包.exe /PASSWORD=口令` 启动 / `no` 不加密。口令取自工程设置里的「安装包密码」。**Inno 自己的默认是 `no`，SealPack 默认选 `yes`** |
| `kdfIterations` | `220000` | PBKDF2-HMAC-SHA256 的迭代次数，官方范围 1–2147483647，默认 220000。越高越难暴力破解口令，但安装时校验口令也越慢 |
| `signTool` | 空 | Inno 编译器里配置好的 SignTool 名称（如 `signtool`），留空则不签名。签名让 Windows 不再弹「未知发布者」 |
| `signedUninstaller` | 关 | 连卸载程序一起签名，避免卸载时被拦。需要先配好签名工具 |

### 组 4 · 安装行为

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `appId` | 空（自动推导） | **应用标识（Inno 的 `AppId`）**，决定「重新打包后是覆盖升级还是全新安装」。留空则由主程序的产品身份自动推导，详见下文「应用标识与覆盖安装」 |
| `desktopIcon` | **开** | 在向导里提供一个「创建桌面图标」的勾选项（默认不勾）。绿色版模式下该项无效 |
| `runAfterInstall` | **开** | 安装结束时提供「立即运行」选项。绿色版模式下该项无效 |
| `uninstallable` | **开** | 关闭后「应用和功能」里不会出现本程序，也无法常规卸载。绿色版模式固定不生成 |

## 应用标识与覆盖安装（AppId）

这是打包里最容易踩坑、又最不容易发现的一处。

### Inno 怎么判断「升级」还是「新装」

Inno 靠 `AppId` 认出一个应用之前装过没有（它写在
`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<AppId>_is1`）：

- **AppId 相同** → 视为同一个应用的新版本：覆盖安装、更新卸载键里的版本号、
  向导默认装到上次的目录（`UsePreviousAppDir` 默认 `yes`）；
- **AppId 不同** → 视为另一个应用：全新安装，两个版本在「应用和功能」里并存。

所以 **AppId 必须在「同一个产品的所有构建」之间保持一致**。

### 为什么不能用工程 ID

工程 ID 是「新建工程」时随机生成的 UUID。用它当 AppId 的话：

- 同一个工程反复打包 → AppId 不变 → **能**覆盖升级；
- 但换一个工程（哪怕选的是同一份 exe）→ AppId 变了 → **全新安装、两个版本并存**。

这正是「我明明只改了几行代码重新打包，装出来却是两个软件」的原因。

### 现在是怎么做的

`AppId` 由**主程序的产品身份**推导：版本资源里的
`ProductName` + `CompanyName` + `OriginalFilename`（拿不到就退到文件名），
拼接后做一次确定性哈希，摆成 UUIDv5 的形状。

- 同一份主程序**重新编译、重新打包、换台机器打包** → 同一个 AppId；
- `ProductName` 或 `CompanyName` 改了 → AppId 跟着变 —— 那本来就该当成另一个应用；
- 推导结果填在「应用标识」里，**可以手工改**（比如要强行当成另一个应用，或要接回旧的 AppId）。

推导逻辑（`commands.rs::detect_app_id`）有单测钉住：确定性、不同产品得到不同值、
UUID 形状合法、只改大小写不算换产品、字段之间不会串味。

### 两个容易忽略的前提

1. **`PrivilegesRequired` 不能在两次构建之间变**。它决定 Inno 把卸载键写在 HKCU 还是 HKLM；
   上一次是「当前用户」、这一次改成「需要管理员」，第二次就找不到第一次的安装 → 全新安装。
2. **绿色版（`packagingMode=portable`）没有升级这件事**：它写 `Uninstallable=no` 与
   `CreateUninstallRegKey=no`，Inno 没有可查的记录，每次都是全新解压。这是有意的。

### 实测

用 Inno Setup 6.7 真机验证过（同一个 AppId、两份不同版本的脚本，工程 ID 故意不同）：
装 v1.0.0.0 → 卸载键 `{6f3a…}_is1`，`DisplayVersion=1.0.0.0`；
再装 v1.1.0.0 → **卸载键仍是 1 个**、`DisplayVersion=1.1.0.0`，没有出现两个并存。

> **注意**：AppId 的取值方式在 v0.1.1 改过一次（v0.1.0 用的是工程 ID）。
> 因此「v0.1.0 构建的安装包」与「v0.1.1 之后构建的安装包」AppId 不同，不会互相升级 ——
> 只会发生一次。想接回旧 AppId，在「应用标识」里手工填入旧值即可。

### 组 5 · 完整性校验（哈希）

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `checksum` | `none` | 打包完成后在输出目录生成 `checksums-<算法>.txt`。`sha256`（推荐）/ `sha1` / `md5`（后两者只在与旧系统对接时才用，都已被证明可构造碰撞） |

---

## 模板：生成、自定义与占位符

### 模板只有一份定义

`.crproj` 与 `.iss` 的内容由 Rust 侧的 `defaults.rs`（`encrypt_config` / `package_script`）生成，
前端只负责收集开关并调用 `render_encrypt_config` / `render_package_script` 重建它。

工程里用 `generated: bool` 区分「由选项托管」与「用户手工改过」：

- `generated == true` —— 选项是唯一事实源，每次改开关都重新生成模板；
- `generated == false` —— 你在「高级」里手工改过，模板为准，一个字都不动。界面会给出提示条与
  「用当前选项覆盖模板」按钮，随时可以交回开关管理。

「恢复默认选项」与「恢复默认模板」都会把 `generated` 置回 `true`。

### 占位符

模板里用 `${key}` 语法引用工程的实际值，**执行阶段**才替换（不是在编辑模板时）。
采用 `${key}` 而非 `{key}`，是为了避开 Inno 自身的 `{app}`、`{#define}` 常量语法。

| 占位符 | 含义 |
| --- | --- |
| `${id}` | 工程标识（GUID） |
| `${name}` | 工程名称 |
| `${root}` | 主程序所在目录 |
| `${exe}` | 主程序文件名（含扩展名） |
| `${exe_stem}` | 主程序文件名（不含扩展名） |
| `${exe_path}` | 主程序完整路径 |
| `${output}` | 安装包输出目录 |
| `${version}` | 版本号 |
| `${password}` | 安装包口令 |
| `${ignore}` | 打包排除项（待合并程序集 + 主程序备份，逗号分隔） |

高级区顶部有可点击的占位符 chip，点一下插入到光标处。

### 打包脚本的关键结构

生成的 `.iss` 里有两行 `Source`：

```
Source: "${root}\${exe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "${root}\*"; Excludes: "${ignore},${exe}"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
```

第二行必须把主程序本身排除掉（`${exe}`），否则同一个文件会进包两次 —— Inno 会报重复文件，
体积统计也会重复计数。`${ignore}` 至少含主程序备份，所以不会拼出以逗号开头的空项。

---

## 三处容易写错、已用断言钉住的细节

1. **`snKey` / `snKeyPass` 是 `<module>` 的属性，不是 `<project>` 的** ——
   写到 `project` 上 ConfuserEx 会静默忽略，签名看起来「配了但没生效」。
2. **`Encryption=full` 仍然要写 `Password`** —— 密钥在**编译期**由 `Password` 派生（ISCC 并没有 `/PASSWORD=` 这个开关）；
   `/PASSWORD=` 是**运行安装包**时用的，因为整包加密后连输入口令的界面都读不到。两件事不冲突。
3. **取值一律走白名单收敛** —— 不认识的枚举值退回默认值，`elements` 规整成 `S`/`N`/`P`/`I` 的子集。

---

## 附录 A · Inno Setup 指令与边界值（对照官方文档核实）

以下结论逐条核对了 Inno Setup 官方帮助（`https://jrsoftware.org/ishelp/`，`topic_setup_*`），
并用 **Inno Setup 6.7 实际编译**验证过（见上文「端到端实证」）。
代码里对应的常量都在 `src-tauri/src/defaults.rs` 顶部集中声明，改动前请回去核对一遍。

### 指令拼写：全部正确

| 指令 | SealPack 的写法 | 官方文档 | 结论 |
| --- | --- | --- | --- |
| `Compression` | `lzma2/max` 等 9 档 | 默认 `lzma2/max`；还支持 `lzma/ultra`、`lzma2/ultra64`、`zip/1`–`zip/9`、`bzip/1`–`bzip/9` | ✅ 取值合法（子集，见下） |
| `SolidCompression` | `yes` | 布尔 | ✅ |
| `LZMADictionarySize` | `N`（KB） | `4`–`3932160`（64 位编译器） | ✅ |
| `LZMANumBlockThreads` | `N` | `1`–`256`，默认 `1` | ✅ |
| `LZMAMatchFinder` | `BT` / `HC` | 同 | ✅ |
| `LZMAUseSeparateProcess` | `yes` | 同 | ✅ |
| `DiskSpanning` | `yes` | 同 | ✅ |
| `DiskSliceSize` | `N` | `262144`–`9223372036800000000` 或字面量 `max`，默认 `2100000000` | ✅ |
| `SlicesPerDisk` | `N` | `1`–`26`，默认 `1` | ✅ |
| `Encryption` | `yes` / `full` | `yes` / `no` / `full`，默认 `no` | ✅ |
| `EncryptionKeyDerivation` | `pbkdf2/N` | `pbkdf2` 或 `pbkdf2/1`–`pbkdf2/2147483647`，默认 `pbkdf2/220000` | ✅ |
| `Password` | 明文 | 同 | ✅ |
| `/PASSWORD=` | 注释里说明的运行期参数 | 官方明确「the password must be specified using the `/PASSWORD=` command-line parameter」 | ✅ |
| `PrivilegesRequired` | `admin` / `lowest` | 同，默认 `admin` | ✅ |
| `WizardStyle` | `modern` / `classic` | 同（还有 `dark` / `dynamic` / `polar` 等） | ✅ |
| `SignTool` / `SignedUninstaller` / `Uninstallable` / `CreateUninstallRegKey` / `DisableProgramGroupPage` / `DefaultDirName` / `OutputDir` / `OutputBaseFilename` / `AppId` / `AppName` / `AppVersion` / `AppPublisher*` | 标准指令 | 同 | ✅ |

### 边界值：核实后修正了 3 处

| 项 | 原值 | 官方值 | 处理 |
| --- | --- | --- | --- |
| `DiskSliceSize` 上限 | `9223372036854775807`（i64::MAX） | `9223372036800000000` | 界面 `max` 与生成器的 clamp 都改为官方值。超出 JS 安全整数范围，但它的最短往返表示恰好还是这串数字，所以两侧拼出的字符串一致 |
| `LZMADictionarySize` 下界判断 | `> 0` 才写入 | 有效范围从 `4` 起 | 改为 `>= 4` 才写入 —— 填 1–3 会被 ISCC 直接拒绝 |
| `LZMANumBlockThreads` 文案 | 「0 表示自动」 | 默认值是 `1`，不是自动探测 | 文案改为「0 表示不写这一行，Inno 用它自己的默认值 1」 |

另外两处文案也顺手改准了：`Encryption` 的「默认」明确为「SealPack 默认」（Inno 自己的默认是 `no`）；
`WizardStyle` 的说明补上「官方还支持 dark / dynamic 等外观模式」。

### 为什么 `Compression` 只列 9 档

官方还支持 `lzma/ultra`、`lzma/ultra64`、`lzma2/ultra`、`lzma2/ultra64` 与 `zip/1`–`zip/9`、`bzip/1`–`bzip/9`。
不列 ultra 档是因为它们的字典默认值分别是 32 MB / 64 MB，压缩时内存要 **374 MB / 742 MB** ——
摆在界面上更像陷阱而不是选项。需要时可在高级区直接改模板。

`bzip` 不写等级时 Inno 默认按 9 处理；`zip` 默认按 7 处理。

### 端到端实证

除了对文档，六种典型配置还用 **Inno Setup 6.7 真实编译过一遍**（脚本由本项目的生成器产出、
占位符替换为实际路径）：

| 配置 | 覆盖点 | 结果 |
| --- | --- | --- |
| 单文件 + 全部 LZMA 参数 | `Compression=lzma2/max`、`SolidCompression`、`LZMADictionarySize`、`LZMANumBlockThreads`、`LZMAMatchFinder`、`LZMAUseSeparateProcess` | 编译成功、0 警告 |
| `Encryption=full` | 整包加密 + `Password` + `EncryptionKeyDerivation` | 编译成功、0 警告 |
| 分卷 | `DiskSpanning`、`DiskSliceSize=1566000000`、`SlicesPerDisk=3` | 编译成功、0 警告 |
| 绿色版 | `Uninstallable=no`、`CreateUninstallRegKey=no`，且不生成 `[Icons]` / `[Tasks]` / `[Run]` | 编译成功、0 警告 |
| 不压缩 | `Compression=none`，且不写 `SolidCompression` / LZMA 参数 | 编译成功、0 警告 |
| 未知取值 | `compression=rar/9`、`wizardStyle=nope`、`encryption=bogus` → 全部退回默认值 | 编译成功、0 警告 |

`[Files]` 里主程序只被收录一次（若 `*` 那行重复收录，ISCC 会报重复文件 —— 实测无警告）。

### 语言包：不能用 `compiler:` 引用中文

生成的脚本里这行：

```
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"
```

**不能**写成 `compiler:Languages\ChineseSimplified.isl`。原因：Inno Setup 的官方发行版
`Languages\` 目录只带 29 种语言，**简体中文属于用户贡献的翻译**，需要单独下载
（<https://jrsoftware.org/files/istrans/>）。用 `compiler:` 前缀的话，在任何标准安装上都会以
`Couldn't open include file` 失败 —— 只有手工往 Inno 目录里放过该文件的机器才能跑通。

所以本应用**自带一份**适配 Inno 6.5+ 的翻译（`src-tauri/resources/isl/ChineseSimplified.isl`，
来源见同目录的 README），打包阶段把它复制到临时脚本旁边，用相对路径引用
（ISCC 按**脚本所在目录**解析相对路径，与 Inno 装在哪儿无关）。

> 升级 Inno 版本时注意：若新版本引入了新的消息键，旧翻译会输出
> `A message named "…" has not been defined` 警告（回退到英文，不致命），换一份更新的翻译即可。


---

## 附录 B · ConfuserEx 配置的生成规则

`<rule>` 里每个 protection 按固定顺序输出（`model.rs::enabled_protections`），
界面上的摘要与生成的模板用的是同一个顺序，对照起来不会串行：

```
anti ildasm → anti debug → anti dump → anti tamper → constants
→ ctrl flow → invalid metadata → rename → harden → ref proxy → resources
```

带参数的 protection 会输出 `<argument>`，且**即使取值等于 ConfuserEx 自己的默认值也照样显式写出来** ——
这个工具的立场是「界面上的选项就是唯一事实源」，模板要能一眼看出每个开关产生了什么：

| protection | 参数 |
| --- | --- |
| `anti debug` | `mode` |
| `anti tamper` | `mode`、`key` |
| `constants` | `mode`、`elements`、`cfg` |
| `ctrl flow` | `type`、`predicate`（仅 `switch`）、`depth`（仅 `expression`/`x86`）、`intensity`、`junk` |
| `rename` | `mode`、`password`（仅 `reversible` 且非空）、`renameArgs`、`renEnum`、`renPublic` |
| `ref proxy` | `mode`、`internal` |
| `resources` | `mode` |
| 其余（`anti ildasm` / `anti dump` / `invalid metadata` / `harden`） | 无参数，自闭合 `<protection id="…" />` |

`<module>` 上写 `path` 与可选的 `snKey` / `snKeyPass`；`<project>` 上写 `outputDir` / `baseDir` /
可选的 `seed` / `debug`；`<packer id="compressor" />` 在 `compress` 开启时输出。
