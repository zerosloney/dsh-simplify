/**
 * 类型定义：自 pi-simplify 原样迁移（src/types.ts），零改动。
 * 来源：https://github.com/nicobailon/pi-simplify（MIT）
 */

export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export interface ChangedFile {
  readonly path: string;
  readonly status: "modified" | "added" | "renamed" | "copied";
  /**
   * 重命名/复制的来源路径（`git diff --name-status` 的第二个路径）。
   * 取变更行时必须把新旧路径同时交给 pathspec，否则 git 的 rename 检测会因为
   * 找不到配对而把重命名降级成「新文件」，导致整个文件被误报为全文件变更。
   */
  readonly oldPath?: string;
  readonly changedLines?: readonly LineRange[];
}

export interface SimplifyOptions {
  readonly files: readonly string[];
  readonly ref: string;
  readonly staged: boolean;
}

export interface ChangedFilesResult {
  readonly files: readonly ChangedFile[];
  readonly fallbackRef?: string;
  /** git 失败时的单行用户可读错误（含 stderr 首行）；非空时 files 恒为空。 */
  readonly error?: string;
}

