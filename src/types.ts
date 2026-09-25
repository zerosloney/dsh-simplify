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

