#!/usr/bin/env node
/**
 * Fail the build when a component asks a CSS module for a class it never defines.
 *
 * A missing class fails silently: `s.skeletonRow` is undefined, React drops the
 * attribute, and the element collapses into an unstyled box. Two of those shipped
 * because nothing compared both sides of the boundary. Since the rewrite every page
 * owns a `.module.scss`, so the check follows each import: one module per file, one
 * resolution per alias, no assumptions about a single global stylesheet.
 *
 * The SCSS is compiled with sass before parsing. A regex over the source would see
 * mixin parameters, nested selectors and `#{...}` interpolation as class names; the
 * compiled CSS is flat, so a class can only appear in a selector prelude.
 *
 * Usage: node scripts/check-classes.mjs [--json] [--unused] [--src DIR]
 *   --json     machine-readable report
 *   --unused   also list classes no file references (report only, never a failure)
 * Exit code 1 when a class is referenced but not defined.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { compileString } from "sass";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** `import s from "./x.module.scss"` — also `import * as s` and `../` forms. */
const MODULE_IMPORT =
  /import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+\.module\.scss)["']/g;

function parseArgs(argv) {
  const options = { json: false, unused: false, src: join(webRoot, "src") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") options.json = true;
    else if (flag === "--unused") options.unused = true;
    else if (flag === "--src") options.src = resolve(argv[(index += 1)]);
    else throw new Error("unknown option: " + flag);
  }
  return options;
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (/\.(tsx?|module\.scss)$/.test(path)) files.push(path);
  }
  return files;
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
 * Class references in one file, split two ways:
 *  - static:  `s.badge` and `s["skeleton-row"]` — checked against that module
 *  - dynamic: `s[tone]`, `s[`${name}`]` — the name only exists at runtime, so it is
 *             reported but never a failure
 */
function classReferences(source) {
  const references = { static: [], dynamic: [], modules: [] };
  const lineOf = lineIndex(source);
  for (const match of source.matchAll(MODULE_IMPORT)) {
    const [statement, binding, specifier] = match;
    const name = binding.replace(/\$/g, "\\$");
    references.modules.push({ alias: binding, specifier, offset: match.index });
    const property = new RegExp("\\b" + name + "\\.([A-Za-z_$][\\w$]*)", "g");
    for (const hit of source.matchAll(property))
      references.static.push({ name: hit[1], line: lineOf(hit.index) });
    const literal = new RegExp("\\b" + name + "\\[\\s*([\"'])([^\"'\\n]+)\\1\\s*\\]", "g");
    for (const hit of source.matchAll(literal))
      references.static.push({ name: hit[2], line: lineOf(hit.index) });
    const computed = new RegExp("\\b" + name + "\\[\\s*([^\\]\\n]+?)\\s*\\]", "g");
    for (const hit of source.matchAll(computed))
      if (!/^["']/.test(hit[1]))
        references.dynamic.push({ line: lineOf(hit.index), snippet: binding + "[" + hit[1] + "]" });
    void statement;
  }
  return references;
}

const options = parseArgs(process.argv.slice(2));
const files = walk(options.src);

/** One compile per module, and a hard stop if it cannot be read or parsed. */
const definitions = new Map();
const stylesheets = files.filter((file) => file.endsWith(".module.scss"));
for (const file of stylesheets) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    console.error("[check-classes] 读不到样式表：" + file);
    process.exit(1);
  }
  try {
    const css = compileString(source, {
      url: pathToFileURL(file),
      loadPaths: [dirname(file), join(webRoot, "src")],
    }).css;
    definitions.set(file, definedClasses(css));
  } catch (error) {
    console.error("[check-classes] 样式表编译失败：" + file);
    console.error("  " + String(error && error.message ? error.message : error).split("\n")[0]);
    process.exit(1);
  }
}

const used = new Set();
const missing = [];
const dynamic = [];
for (const file of files.filter((candidate) => /\.[jt]sx?$/.test(candidate))) {
  const source = readFileSync(file, "utf8");
  if (!source.includes(".module.scss")) continue;
  const references = classReferences(source);
  const imported = references.modules.map((entry) => ({
    target: resolve(dirname(file), entry.specifier),
    line: lineIndex(source)(entry.offset),
    specifier: entry.specifier,
  }));
  // A file may import several modules; a name is resolved when *some* imported module
  // defines it, and reported only when none does.
  for (const entry of imported)
    if (!definitions.has(entry.target))
      missing.push({
        file: relative(webRoot, file),
        line: entry.line,
        name: entry.specifier,
        reason: "样式表不存在",
      });
  for (const reference of references.static) {
    const owner = imported.find((entry) => definitions.get(entry.target)?.has(reference.name));
    if (!owner) {
      missing.push({ file: relative(webRoot, file), line: reference.line, name: reference.name });
      continue;
    }
    used.add(owner.target + "#" + reference.name);
  }
  for (const entry of references.dynamic)
    dynamic.push({ file: relative(webRoot, file), line: entry.line, snippet: entry.snippet });
}

if (options.json) {
  console.log(JSON.stringify({ stylesheets: stylesheets.length, missing, dynamic }, null, 2));
  process.exit(missing.length ? 1 : 0);
}

for (const entry of dynamic)
  console.log(
    "· 动态类名（运行时才确定，不判错）：" + entry.file + ":" + entry.line + "  " + entry.snippet,
  );
if (options.unused) {
  const unused = [];
  for (const [file, defined] of definitions)
    for (const name of defined)
      if (!used.has(file + "#" + name)) unused.push(relative(webRoot, file) + "  ." + name);
  unused.sort();
  console.log("· 无引用的类（" + unused.length + " 个）：");
  for (const line of unused) console.log("  " + line);
}
if (missing.length) {
  console.error("✗ 类名检查失败：" + missing.length + " 处缺失");
  for (const entry of missing)
    console.error(
      "  " +
        entry.file +
        ":" +
        entry.line +
        "  ." +
        entry.name +
        (entry.reason ? "（" + entry.reason + "）" : ""),
    );
  process.exit(1);
}
console.log("✓ 类名检查通过（" + stylesheets.length + " 个模块）");
