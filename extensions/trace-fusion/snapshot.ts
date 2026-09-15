/**
 * trace-fusion/snapshot.ts — synthetic base snapshot（trace-fusion C5，设计稿 §13–§14.2）
 *
 * 用户常在 HEAD + staged + unstaged + untracked 状态下启动；三个 worktree 若只从
 * HEAD 建会看不到当前修改。本模块构造一个【不移动任何用户 ref、不碰用户 index】
 * 的合成提交：
 *
 *   GIT_INDEX_FILE=<runBase>/base.index
 *   git read-tree HEAD          # 从 HEAD 展开到临时 index
 *   git add -A                  # 折叠当前全部可见内容（ignored 除外）
 *   TREE=$(git write-tree)
 *   BASE=$(git commit-tree $TREE -p HEAD)
 *
 * 该提交进入 object database，可被 worktree add --detach 使用；cleanup 后成为
 * unreachable object 由 git gc 回收。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execGit, SNAPSHOT_IDENTITY_ENV } from "./git.ts";

export interface SnapshotInfo {
	/** 合成 base 提交（三条 lane 与 supervisor 的共同祖先）。 */
	baseCommit: string;
	/** 快照前用户的 HEAD（重建/对照用）。 */
	headBefore: string;
	/** 临时 index 文件路径（cleanup 时可删）。 */
	indexFile: string;
	/** porcelain 记录（base/status.txt）。 */
	porcelain: string;
}

export function createSyntheticSnapshot(repoRoot: string, runBaseDir: string): SnapshotInfo {
	// review 修正（Luna major）：run 目录在仓库内时，add -A 会把 snapshot 自身的
	// base.index / 产物扫进 tree——强制 artifact 目录位于仓库外部。
	const normRepo = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const normBase = runBaseDir.replace(/\\/g, "/").toLowerCase();
	if (normBase === normRepo || normBase.startsWith(normRepo + "/")) {
		throw new Error(`run 目录不得位于仓库内部（snapshot 会自吸产物）：${runBaseDir}`);
	}
	const head = execGit(["rev-parse", "HEAD"], { cwd: repoRoot });
	if (head.status !== 0) throw new Error(`HEAD 不可解析：${head.stderr}`);
	const headBefore = head.stdout;

	mkdirSync(runBaseDir, { recursive: true });
	const indexFile = join(runBaseDir, "base.index");
	const indexEnv = { GIT_INDEX_FILE: indexFile, ...SNAPSHOT_IDENTITY_ENV };

	const readTree = execGit(["read-tree", "HEAD"], { cwd: repoRoot, env: indexEnv });
	if (readTree.status !== 0) throw new Error(`read-tree 失败：${readTree.stderr}`);

	const addAll = execGit(["add", "-A", "--"], { cwd: repoRoot, env: indexEnv });
	if (addAll.status !== 0) throw new Error(`add -A 失败：${addAll.stderr}`);

	const writeTree = execGit(["write-tree"], { cwd: repoRoot, env: indexEnv });
	if (writeTree.status !== 0) throw new Error(`write-tree 失败：${writeTree.stderr}`);
	const tree = writeTree.stdout;

	const commitTree = execGit(["commit-tree", tree, "-p", headBefore], {
		cwd: repoRoot,
		env: indexEnv,
		input: "pi trace-fusion base snapshot (synthetic; touches no user ref)\n",
	});
	if (commitTree.status !== 0) throw new Error(`commit-tree 失败：${commitTree.stderr}`);
	const baseCommit = commitTree.stdout;

	// 自证：commit 对象确实可解析
	const verify = execGit(["cat-file", "-e", `${baseCommit}^{commit}`], { cwd: repoRoot });
	if (verify.status !== 0) throw new Error(`合成提交自证失败：${verify.stderr}`);

	// 磁盘契约（§24.1：磁盘是唯一真相源；base/ 三件套）
	const st = execGit(["status", "--porcelain=v1"], { cwd: repoRoot });
	const porcelain = st.status === 0 ? st.stdout : "";
	writeFileSync(join(runBaseDir, "base-commit.txt"), baseCommit + "\n", "utf8");
	writeFileSync(join(runBaseDir, "status.txt"), porcelain, "utf8");
	writeFileSync(
		join(runBaseDir, "snapshot.json"),
		JSON.stringify({ baseCommit, headBefore, createdAt: new Date().toISOString(), repoRoot }, null, 2) + "\n",
		"utf8",
	);

	return { baseCommit, headBefore, indexFile, porcelain };
}

/**
 * 重启恢复（§24.1）：从磁盘读回 base commit 并验证对象仍可解析（gc 安全窗口内）。
 * 不可解析 / 无记录 → null，调用方降级为 artifacts-only 报告。
 */
export function resolveBaseCommit(repoRoot: string, runBaseDir: string): string | null {
	const commitFile = join(runBaseDir, "base-commit.txt");
	if (!existsSync(commitFile)) return null;
	const baseCommit = readFileSync(commitFile, "utf8").trim();
	if (!baseCommit) return null;
	const verify = execGit(["cat-file", "-e", `${baseCommit}^{commit}`], { cwd: repoRoot });
	return verify.status === 0 ? baseCommit : null;
}
