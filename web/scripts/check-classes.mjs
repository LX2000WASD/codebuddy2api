#!/usr/bin/env node
/**
 * Fail the build when a component asks the CSS module for a class it never defines.
 *
 * A missing class fails silently: `s.skeletonRow` is undefined, React drops the
 * attribute, and the element collapses into an unstyled box. Two of those shipped
 * (appearance.tsx `langDot`, components.tsx `skeletonRow`) because nothing compared both
 * sides of the boundary.
 *
 * The SCSS is compiled with sass before parsing. A regex over the source would see
 * mixin parameters (`@include glass(0.42, 26px)`), nested selectors and `#{...}`
 * interpolation as class names; the compiled CSS is flat, so a class can only appear
 * in a selector prelude. Compilation also lets sass resolve nesting for us.
 *
 * Usage: node scripts/check-classes.mjs [--json] [--unused] [--src DIR] [--scss FILE]
 * Exit code 1 when a class is referenced but not defined, unless it is listed in
 * KNOWN_MISSING below (a documented, owner-assigned gap that another task closes).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileString } from "sass";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Gaps that already exist and are being fixed elsewhere. Listing one here keeps the
 * check meaningful for new code without freezing the build on pre-existing debt; the
 * entry is reported on every run so it cannot be forgotten. Remove an entry as soon as
 * the class exists — a stale entry is dead weight, not a safety net.
 *
 * Entries are matched on the class name only: line numbers move whenever the
 * surrounding file is edited, and a check that fails on unrelated edits gets disabled
 * instead of fixed.
 */
const KNOWN_MISSING = new Map([
  // I2 adds the .langDot rule (05-视觉语言方案 §6 appearance language selector).
  ["langDot", "I2"],
  // I2 adds a .skeletonRow alias next to .skeleton-row; the SCSS is that task's scope.
  ["skeletonRow", "I2"],
]);

function parseArgs(argv) {
  const options = { json: false, unused: false, src: join(webRoot, "src"), scss: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") options.json = true;
    else if (flag === "--unused") options.unused = true;
    else if (flag === "--src") options.src = resolve(argv[(index += 1)]);
    else if (flag === "--scss") options.scss = resolve(argv[(index += 1)]);
    else throw new Error("unknown option: " + flag);
  }
  options.scss ??= join(options.src, "ui.module.scss");
  return options;
}

/**
 * Class names declared by a compiled stylesheet. Only selector preludes are read:
 * at-rule preludes (`@media`, `@keyframes`) are skipped, and declaration blocks are
 * never entered because the buffer resets on every brace and semicolon.
 */
function definedClasses(css) {
  const classes = new Set();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let prelude = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      prelude += char;
      if (char === quote && text[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      prelude += char;
      continue;
    }
    if (char === "{") {
      const selector = prelude.trim();
      if (selector && !selector.startsWith("@"))
        for (const match of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(match[1]);
      prelude = "";
      continue;
    }
    if (char === "}" || char === ";") {
      prelude = "";
      continue;
    }
    prelude += char;
  }
  return classes;
}

/** import s from "./ui.module.scss" / import * as s from "../ui.module.scss" */
const MODULE_IMPORT =
  /import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+["'][^"']*ui\.module\.scss["']/g;

function walk(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (path.endsWith(".tsx") || path.endsWith(".ts")) files.push(path);
  }
  return files;
}

/** Offsets of every line start, so a match index maps to a line in O(log n). */
function lineIndex(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1)
    if (source[index] === "\n") starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/**
 * Class references in one file, split three ways:
 *  - static:  `s.badge` and `s["skeleton-row"]` — checked against the SCSS
 *  - dynamic: `s[tone]`, `s[`${name}`]` — the name only exists at runtime, so it is
 *             reported but never a failure
 */
function classReferences(source) {
  const references = { static: [], dynamic: [] };
  const lineOf = lineIndex(source);
  for (const [, binding] of source.matchAll(MODULE_IMPORT)) {
    const name = binding.replace(/\$/g, "\\$");
    const property = new RegExp("\\b" + name + "\\.([A-Za-z_$][\\w$]*)", "g");
    for (const match of source.matchAll(property))
      references.static.push({ name: match[1], line: lineOf(match.index) });
    const literal = new RegExp("\\b" + name + "\\[\\s*([\"'])([^\"'\\n]+)\\1\\s*\\]", "g");
    for (const match of source.matchAll(literal))
      references.static.push({ name: match[2], line: lineOf(match.index) });
    // The bracket body is captured so the report can quote the real expression
    // instead of the two characters that opened it.
    const computed = new RegExp("\\b" + name + "\\[\\s*([^\\]\\n]+?)\\s*\\]", "g");
    for (const match of source.matchAll(computed))
      if (!/^["']/.test(match[1]))
        references.dynamic.push({
          line: lineOf(match.index),
          snippet: name + "[" + match[1] + "]",
        });
  }
  return references;
}

const options = parseArgs(process.argv.slice(2));

/**
 * The checker exists to fail loudly on a bad class reference, so it must not fail
 * ambiguously on its own inputs: a missing stylesheet or a Sass syntax error would
 * otherwise print a stack trace and be read as "the check is broken, skip it".
 */
function loadDefinedClasses(path) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    console.error("[check-classes] 读不到样式表：" + path);
    process.exit(1);
  }
  try {
    return definedClasses(compileString(source).css);
  } catch (error) {
    console.error("[check-classes] 样式表编译失败：" + path);
    console.error("  " + String(error && error.message ? error.message : error).split("\n")[0]);
    process.exit(1);
  }
}

const defined = loadDefinedClasses(options.scss);

const missing = [];
const known = [];
const dynamic = [];
const used = new Set();
const files = walk(options.src);
for (const file of files) {
  const references = classReferences(readFileSync(file, "utf8"));
  const at = relative(webRoot, file);
  for (const reference of references.static) {
    used.add(reference.name);
    if (!defined.has(reference.name)) {
      const owner = KNOWN_MISSING.get(reference.name);
      const entry = { file: at, line: reference.line, className: reference.name };
      if (owner) known.push({ ...entry, owner });
      else missing.push(entry);
    }
  }
  for (const reference of references.dynamic)
    dynamic.push({ file: at, line: reference.line, snippet: reference.snippet });
}
const unused = [...defined]
  .filter((name) => !used.has(name))
  .sort((left, right) => left.localeCompare(right));

// A baseline entry whose class now exists is dead weight: it would silently absorb the
// next regression of the same class instead of failing the build. It is reported on
// every run, but as a warning rather than a failure — the entry lives in this file, so
// failing here would mean the task that finally defines the class also has to edit a
// file outside its scope before its own gate can go green. Deleting the entry is still
// the only way to silence it, which is what we want; it just must not block anyone.
const stale = [...KNOWN_MISSING]
  .filter(([name]) => defined.has(name))
  .map(([name, owner]) => ({ className: name, owner }));

if (options.json) {
  console.log(
    JSON.stringify(
      {
        scss: relative(webRoot, options.scss),
        defined: defined.size,
        referenced: used.size,
        files: files.length,
        missing,
        known,
        stale,
        dynamic,
        unused,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    "[check-classes] " +
      defined.size +
      " 个类（" +
      relative(webRoot, options.scss) +
      "），" +
      files.length +
      " 个文件引用 " +
      used.size +
      " 个",
  );
  if (missing.length) {
    console.error("\n✗ 引用了未定义的类：" + missing.length + " 处");
    for (const item of missing)
      console.error("  " + item.file + ":" + item.line + "  s." + item.className);
  }
  if (known.length) {
    console.log("\n· 已知缺失（已登记，不阻塞构建）：" + known.length + " 处");
    for (const item of known)
      console.log(
        "  " + item.file + ":" + item.line + "  s." + item.className + "  → " + item.owner,
      );
  }
  if (stale.length) {
    console.warn(
      "\n! 基线里过期的条目（类已存在，请从 KNOWN_MISSING 删除）：" + stale.length + " 个",
    );
    for (const item of stale) console.warn("  " + item.className + "  → " + item.owner);
  }
  if (dynamic.length) {
    console.log("\n· 动态类名（运行时才确定，不判错）：" + dynamic.length + " 处");
    for (const item of dynamic)
      console.log("  " + item.file + ":" + item.line + "  " + item.snippet);
  }
  if (options.unused) {
    console.log("\n· 未被引用的类：" + unused.length + " 个");
    console.log("  " + unused.join(", "));
  }
  console.log(
    missing.length ? "\n✗ 类名检查失败：" + missing.length + " 处缺失" : "\n✓ 类名检查通过",
  );
}

// Only an undefined class fails the build. A stale baseline entry warns, because the
// task that defines the class owns a different file and must still be able to pass.
process.exit(missing.length ? 1 : 0);
