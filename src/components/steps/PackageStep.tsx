import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Input,
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowClockwiseRegular,
  DismissRegular,
  LockClosedRegular,
} from "@fluentui/react-icons";

import { api, pickDirectory, pickFile } from "@/api";
import { Page } from "@/components/common/Page";
import { Panel } from "@/components/common/Panel";
import { useToast } from "@/components/feedback/ToastProvider";
import { PackageOptions } from "@/components/options/PackageOptions";
import { FileTree } from "@/components/tree/FileTree";
import { UpgradePanel } from "@/components/upgrade/UpgradePanel";
import { formatBytes } from "@/lib/format";
import type { LockInfo, TreeStats } from "@/lib/fileTree";
import { useBuildStore } from "@/stores/buildStore";
import { useProjectStore } from "@/stores/projectStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { ArtifactKind, FileNode, UpgradePlan } from "@/types";
import { relativeTo } from "@/util";

const useStyles = makeStyles({
  split: {
    display: "flex",
    gap: "var(--app-space-4)",
    height: "var(--app-split-h)",
    minHeight: "260px",
  },
  treePane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  side: {
    width: "var(--app-side-w)",
    flexShrink: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  sideBody: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-3)",
    flex: 1,
    minHeight: 0,
    padding: "var(--app-space-2) var(--app-space-3)",
    overflow: "auto",
  },
  artifactBox: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--app-space-2)",
    paddingBottom: "var(--app-space-3)",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  artifactHint: {
    fontSize: "var(--app-font-meta)",
    lineHeight: "var(--app-line-meta)",
    color: tokens.colorNeutralForeground3,
  },
  stat: {
    display: "grid",
    gridTemplateColumns: "max-content minmax(0, 1fr)",
    gap: "var(--app-space-1) var(--app-space-3)",
    fontSize: "var(--app-font-small)",
    color: tokens.colorNeutralForeground3,
  },
  statValue: {
    color: tokens.colorNeutralForeground1,
    fontVariantNumeric: "tabular-nums",
  },
  globRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--app-space-2)",
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--app-space-1)",
  },
  ruleChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--app-space-1)",
    padding: "0 var(--app-space-1) 0 var(--app-space-2)",
    borderRadius: "var(--app-radius-sm)",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
    fontSize: "var(--app-font-meta)",
  },
  autoChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--app-space-1)",
    padding: "0 var(--app-space-2)",
    borderRadius: "var(--app-radius-sm)",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-meta)",
  },
  code: {
    margin: 0,
    padding: "var(--app-space-2)",
    borderRadius: "var(--app-radius-sm)",
    background: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "var(--app-font-meta)",
    lineHeight: "var(--app-line-small)",
    maxHeight: "96px",
    overflow: "auto",
    wordBreak: "break-all",
    whiteSpace: "pre-wrap",
    userSelect: "text",
  },
  sectionTitle: {
    fontSize: "var(--app-font-meta)",
    fontWeight: 600,
    color: tokens.colorNeutralForeground2,
  },
  center: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--app-space-2)",
    height: "180px",
    color: tokens.colorNeutralForeground3,
    fontSize: "var(--app-font-small)",
  },
  errorBox: {
    padding: "var(--app-space-4)",
  },
  errorAction: {
    marginTop: "var(--app-space-3)",
  },
  sectionBody: {
    marginTop: "var(--app-space-2)",
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
});

function collectFiles(node: FileNode, out: FileNode[] = []): FileNode[] {
  if (node.isDir) {
    for (const child of node.children) collectFiles(child, out);
  } else {
    out.push(node);
  }
  return out;
}

function isRule(path: string): boolean {
  return path.includes("*") || path.includes("?");
}

function normalize(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function ruleMatches(relative: string, rule: string): boolean {
  const r = normalize(rule);
  const p = normalize(relative);
  const target = r.includes("\\") ? p : (p.split("\\").pop() ?? p);
  const pattern = r.includes("\\") ? r : r;
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, ".*")
    .replace(/\\\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`).test(target);
  } catch {
    return false;
  }
}

export function PackageStep() {
  const styles = useStyles();
  const toast = useToast();
  const project = useProjectStore((state) => state.current);
  const update = useProjectStore((state) => state.update);
  const tree = useWorkspaceStore((state) => state.tree);
  const treeError = useWorkspaceStore((state) => state.treeError);
  const scanning = useWorkspaceStore((state) => state.scanning);
  const ignores = useWorkspaceStore((state) => state.ignores);
  const ensureTree = useWorkspaceStore((state) => state.ensureTree);
  const rescan = useWorkspaceStore((state) => state.rescan);
  const refreshIgnores = useWorkspaceStore((state) => state.refreshIgnores);
  const [stats, setStats] = useState<TreeStats | null>(null);
  const [glob, setGlob] = useState("");
  const running = useBuildStore((state) => state.running);
  const updateBuildOptions = useProjectStore((state) => state.updateBuildOptions);
  const [plan, setPlan] = useState<UpgradePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState("");
  const planRequest = useRef(0);
  const artifact: ArtifactKind = project?.buildOptions?.artifact ?? "installer";

  const refreshPlan = useCallback(() => {
    const current = useProjectStore.getState().current;
    const epoch = ++planRequest.current;
    if (!current || current.buildOptions?.artifact === "installer") {
      setPlan(null);
      setPlanError("");
      setPlanLoading(false);
      return;
    }
    setPlanLoading(true);
    setPlanError("");
    void api
      .planUpgrade(current)
      .then((next) => {
        if (epoch === planRequest.current) setPlan(next);
      })
      .catch((error) => {
        if (epoch !== planRequest.current) return;
        setPlan(null);
        setPlanError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (epoch === planRequest.current) setPlanLoading(false);
      });
  }, []);

  useEffect(
    () => () => {
      // 卸载时让在途请求失效，避免把结果写回已经离开的页面
      planRequest.current += 1;
    },
    [],
  );

  useEffect(() => {
    // 勾选文件会改变完整包内容，进而改变升级差异；哈希整个目录比较贵，
    // 连续勾选时合并成一次。
    const timer = window.setTimeout(refreshPlan, 250);
    return () => window.clearTimeout(timer);
  }, [
    refreshPlan,
    project?.id,
    artifact,
    project?.buildOptions?.baselinePath,
    project?.version,
    project?.outputDir,
    project?.rootPath,
    project?.exeFile,
    project?.mergeDlls,
    project?.excludePaths,
    project?.packageOptions?.appId,
    project?.packageOptions?.requireAdmin,
    project?.packageOptions?.packagingMode,
    project?.packageOptions?.uninstallable,
  ]);

  useEffect(() => {
    if (!tree && !scanning) void ensureTree();
    // 只在首次挂载时兜底
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allFiles = useMemo(() => (tree ? collectFiles(tree) : []), [tree]);
  const rules = useMemo(
    () => (project?.excludePaths ?? []).filter(isRule),
    [project?.excludePaths],
  );
  const concrete = useMemo(
    () =>
      new Set(
        (project?.excludePaths ?? [])
          .filter((path) => !isRule(path))
          .map((path) => normalize(path)),
      ),
    [project?.excludePaths],
  );

  const locked = useMemo(() => {
    const map = new Map<string, LockInfo>();
    if (!project) return map;

    // 主程序始终打包
    if (project.exeFile) {
      map.set(project.exeFile, { state: "on", reason: "always" });
    }

    // 合并项 / 备份 / 输出目录：自动排除
    for (const item of ignores?.auto ?? []) {
      if (isRule(item)) {
        for (const file of allFiles) {
          const relative = relativeTo(project.rootPath, file.path);
          if (ruleMatches(relative, item) && !map.has(file.path)) {
            map.set(file.path, { state: "off", reason: "auto" });
          }
        }
      } else {
        const abs = `${project.rootPath}\\${item.replace(/\//g, "\\")}`;
        if (!map.has(abs)) map.set(abs, { state: "off", reason: "auto" });
      }
    }

    // 通配符 / 文件夹规则：规则排除
    if (ignores?.ruleMatched && ignores.ruleMatched.length > 0) {
      for (const relative of ignores.ruleMatched) {
        const abs = `${project.rootPath}\\${relative.replace(/\//g, "\\")}`;
        if (!map.has(abs)) map.set(abs, { state: "off", reason: "rule" });
      }
    } else if (project.rootPath) {
      for (const file of allFiles) {
        const relative = relativeTo(project.rootPath, file.path);
        if (rules.some((rule) => ruleMatches(relative, rule))) {
          if (!map.has(file.path)) {
            map.set(file.path, { state: "off", reason: "rule" });
          }
        }
      }
    }

    return map;
  }, [project, ignores?.auto, ignores?.ruleMatched, rules, allFiles]);

  const checked = useMemo(() => {
    const set = new Set<string>();
    if (!project) return set;
    for (const file of allFiles) {
      const lock = locked.get(file.path);
      if (lock?.state === "off") continue;
      const relative = relativeTo(project.rootPath, file.path);
      if (concrete.has(normalize(relative))) continue;
      set.add(file.path);
    }
    return set;
  }, [allFiles, locked, concrete, project]);

  if (!project) return null;

  const toggle = (paths: string[], value: boolean) => {
    const next = new Set(project.excludePaths);
    for (const path of paths) {
      const relative = relativeTo(project.rootPath, path);
      const normalized = normalize(relative);
      if (value) {
        for (const item of [...next]) {
          if (!isRule(item) && normalize(item) === normalized) next.delete(item);
        }
      } else if (![...next].some((item) => !isRule(item) && normalize(item) === normalized)) {
        next.add(relative);
      }
    }
    update({ excludePaths: [...next] });
    void refreshIgnores();
  };

  const addGlob = () => {
    const value = glob.trim();
    if (!value) return;
    if (value.includes(",")) {
      toast("不能包含逗号；需要排除多项请分别添加", "error");
      return;
    }
    if (!value.includes("*") && !value.includes("?")) {
      toast("请包含 * 或 ? 通配符；具体文件请在左侧树里取消勾选", "error");
      return;
    }
    if (project.excludePaths.some((item) => normalize(item) === normalize(value))) {
      toast("这条规则已经在排除列表里了", "info");
      return;
    }
    update({ excludePaths: [...project.excludePaths, value] });
    setGlob("");
    void refreshIgnores();
  };

  const removeRule = (rule: string) => {
    update({ excludePaths: project.excludePaths.filter((item) => item !== rule) });
    void refreshIgnores();
  };

  const setArtifact = (value: string) => {
    updateBuildOptions({ artifact: value as ArtifactKind });
  };

  const pickManifest = async () => {
    try {
      const path = await pickFile("选择基线清单", [
        { name: "SealPack 基线清单", extensions: ["json"] },
      ]);
      if (path) updateBuildOptions({ baselinePath: path });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const pickBaselineDir = async () => {
    try {
      const path = await pickDirectory("选择旧版本目录");
      if (path) updateBuildOptions({ baselinePath: path });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const autoBaseline = () => updateBuildOptions({ baselinePath: "" });

  const customCount = project.excludePaths.length;
  const autoCount = ignores?.auto.length ?? 0;
  // Rust 的计数覆盖整棵树（含折叠目录与规则命中）；树表统计只用于「当前显示」。
  const packedCount = ignores?.packedCount ?? stats?.checked ?? 0;
  const packedBytes = ignores?.packedBytes ?? stats?.checkedBytes ?? 0;
  const excludedCount = ignores?.excludedCount ?? autoCount + customCount;

  return (
    <Page
      title="安装包打包"
      description={
        artifact === "installer"
          ? "勾选的文件会进入安装包；取消勾选即排除。自动排除项由前两步推导，不能在这里删除。"
          : "左侧树决定完整包内容；升级包按基线自动计算变更，未变化文件不重复打包。"
      }
      wide
      actions={
        <Button
          appearance="secondary"
          size="small"
          icon={<ArrowClockwiseRegular />}
          disabled={scanning}
          onClick={() => void rescan()}
        >
          {scanning ? "扫描中…" : "重新扫描"}
        </Button>
      }
    >
      <div className={styles.split}>
        <div className={styles.treePane}>
          <Panel fill flush>
            {treeError ? (
              <div className={styles.errorBox}>
                <MessageBar intent="error">
                  <MessageBarBody>扫描目录失败：{treeError}</MessageBarBody>
                </MessageBar>
                <Button
                  appearance="secondary"
                  size="small"
                  className={styles.errorAction}
                  onClick={() => void rescan()}
                >
                  重试
                </Button>
              </div>
            ) : tree ? (
              <FileTree
                root={tree}
                mode="pack"
                checked={checked}
                locked={locked}
                loading={scanning}
                onToggle={toggle}
                onStats={setStats}
                emptyText="这个目录里没有可打包的文件"
              />
            ) : (
              <div className={styles.center}>
                <Spinner size="tiny" />
                正在扫描目录…
              </div>
            )}
          </Panel>
        </div>

        <aside className={styles.side}>
          <Panel
            fill
            flush
            title="打包摘要"
            description="勾选 = 进入完整包；升级包按基线自动计算，未变化文件不重复打包。"
          >
            <div className={styles.sideBody}>
              <div className={styles.artifactBox}>
                <span className={styles.sectionTitle}>产物</span>
                <RadioGroup
                  value={artifact}
                  disabled={running}
                  onChange={(_, data) => setArtifact(data.value)}
                >
                  <Radio value="installer" label="完整安装包" />
                  <Radio value="upgrade" label="升级包" />
                  <Radio value="both" label="两者" />
                </RadioGroup>
                <span className={styles.artifactHint}>
                  {artifact === "installer"
                    ? "生成包含全部勾选文件的完整安装包。"
                    : "升级包只包含相对基线的变更；删除项会写入 [InstallDelete]。"}
                </span>
              </div>

              <div className={styles.stat}>
                <span>打包</span>
                <span className={styles.statValue}>
                  {packedCount} 个文件 · {formatBytes(packedBytes)}
                </span>
                <span>自动排除</span>
                <span className={styles.statValue}>{autoCount} 项</span>
                <span>自定义排除</span>
                <span className={styles.statValue}>{customCount} 项</span>
                <span>排除合计</span>
                <span className={styles.statValue}>{excludedCount} 项</span>
                <span>扫描状态</span>
                <span className={styles.statValue}>
                  {ignores?.truncated ? "目录过大，计数可能不完整" : "正常"}
                </span>
                {artifact !== "installer" ? (
                  <>
                    <span>升级包</span>
                    <span className={styles.statValue}>
                      {planLoading
                        ? "计算中…"
                        : plan
                          ? `${plan.newCount + plan.modifiedCount} 个文件 · ${formatBytes(plan.totalBytes)}`
                          : "—"}
                    </span>
                    <span>删除</span>
                    <span className={styles.statValue}>
                      {plan ? `${plan.deletedCount} 项` : "—"}
                    </span>
                  </>
                ) : null}
              </div>

              <div>
                <span className={styles.sectionTitle}>通配符 / 文件夹规则</span>
                <div className={mergeClasses(styles.globRow, styles.sectionBody)}>
                  <Input
                    className={styles.grow}
                    size="small"
                    value={glob}
                    onChange={(_, data) => setGlob(data.value)}
                    placeholder="例如 *.pdb 或 docs\*"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") addGlob();
                    }}
                  />
                  <Button
                    appearance="secondary"
                    size="small"
                    icon={<AddRegular />}
                    onClick={addGlob}
                  >
                    添加
                  </Button>
                </div>
                <div className={mergeClasses(styles.chips, styles.sectionBody)}>
                  {rules.length === 0 ? (
                    <Text size={100} className={styles.muted}>
                      暂无规则；具体文件请直接在左侧树里取消勾选。
                    </Text>
                  ) : (
                    rules.map((rule) => (
                      <span key={rule} className={styles.ruleChip}>
                        {rule}
                        <Button
                          appearance="subtle"
                          size="small"
                          icon={<DismissRegular />}
                          aria-label={`移除规则 ${rule}`}
                          onClick={() => removeRule(rule)}
                        />
                      </span>
                    ))
                  )}
                </div>
              </div>

              <div>
                <span className={styles.sectionTitle}>自动排除（只读）</span>
                <div className={mergeClasses(styles.chips, styles.sectionBody)}>
                  {autoCount === 0 ? (
                    <Text size={100} className={styles.muted}>
                      暂无自动排除项
                    </Text>
                  ) : (
                    (ignores?.auto ?? []).map((item) => (
                      <span key={item} className={styles.autoChip}>
                        <LockClosedRegular />
                        {item}
                      </span>
                    ))
                  )}
                </div>
              </div>

              <div>
                <span className={styles.sectionTitle}>完整包 Excludes</span>
                <pre className={mergeClasses(styles.code, styles.sectionBody)}>
                  {ignores?.combined || "—"}
                </pre>
              </div>
            </div>
          </Panel>
        </aside>
      </div>

      {artifact !== "installer" ? (
        <UpgradePanel
          plan={plan}
          loading={planLoading}
          error={planError}
          disabled={running}
          onRefresh={refreshPlan}
          onPickManifest={() => void pickManifest()}
          onPickDirectory={() => void pickBaselineDir()}
          onAuto={autoBaseline}
        />
      ) : null}

      <PackageOptions />
    </Page>
  );
}
