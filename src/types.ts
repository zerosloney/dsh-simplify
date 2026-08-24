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
