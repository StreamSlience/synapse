---
name: add-lang
description: 端到端地为 synapse 添加 tree-sitter 语言支持——接入语法 + 提取器、编写测试，然后在 3 个热门真实仓库上对提取质量和检索价值进行基准测试。当用户运行 /add-lang <language> 或要求在 synapse 中添加/支持新语言（如 Lua、Elixir、Zig、OCaml）时使用。
---

# 向 Synapse 添加一门语言

将新的 tree-sitter 语言接入 synapse 的提取流水线，证明它能在热门仓库上提取真实符号，并证明它优于不使用 synapse 的方案。**全程自主运行**——自行选择仓库、执行基准测试、更新文档，然后汇报结果。**绝不提交、推送、发布或打标签**（团队规范）；所有变更留给用户审查。

参数是贯穿 `Language` 联合类型的语言 token，例如 `lua`、`elixir`、`zig`。如果未提供，请询问使用哪种语言。全程使用小写单 token 形式（`csharp`，而非 `c#`）。

## 前置条件
- 在 synapse 仓库根目录下运行。需要 `node`、`git`、`gh` 以及已登录的 `claude` CLI（基准测试会派生真实的 `claude -p` 运行）。
- 基准测试使用本地开发构建——第 8 步会构建并将其链接到 PATH。

## 工作流程

复制此检查清单并按顺序完成：
```
- [ ] 1. 确认语言；若已支持则直接跳到基准测试
- [ ] 2. 寻找语法并进行健康检查（ABI / 堆损坏）
- [ ] 3. 探索语法的 AST 节点类型（dump-ast.mjs）
- [ ] 4. 接入语言（4 个文件；有时需要额外修改核心文件）
- [ ] 5. 构建 + 验证提取循环，直到 PASS
- [ ] 6. 添加提取测试；使其通过
- [ ] 7. 自动选取 3 个热门仓库（按规模分级）；添加到 corpus.json
- [ ] 8. 对 3 个仓库进行基准测试：提取 + 有无 synapse 的 A/B 对比
- [ ] 9. 更新 README + CHANGELOG
- [ ] 10. 汇报结果；不要提交
```

### 第 1 步 — 确认语言并短路

检查该语言是否已接入：在 `LANGUAGES` 常量（`src/types.ts`）和 `EXTRACTORS` 映射（`src/extraction/languages/index.ts`）中查找该 token。如果已支持（如 `typescript`、`rust`），**跳过第 2–6 步**，直接进行基准测试（第 7–8 步）以验证/测量——在报告中注明代码未作修改。

### 第 2 步 — 寻找语法并进行健康检查

```bash
ls node_modules/tree-sitter-wasms/out/ | grep -i <lang>   # csharp -> c_sharp
```
- **存在** → 很可能是开箱即用的；`grammars.ts` 会自动从 `tree-sitter-wasms` 中解析它（许多语言都如此：elixir、zig、ocaml、solidity、toml、yaml……）。
- **不存在** → 将 `.wasm` 文件放入 `src/extraction/wasm/`（如 `pascal`/`scala`/`lua`），并在第 4 步中将该 token 加入 vendored 分支。

**在编写提取器之前务必进行健康检查——存在的语法仍可能不可用：**
```bash
node scripts/add-lang/check-grammar.mjs <lang> path/to/valid-sample.<ext>
```
该脚本会打印语法的 ABI 版本，并在多语法运行时中多次解析一个有效的样本文件。如果**失败**（对有效代码产生 ERROR 树——旧版 ABI 损坏了共享的 WASM 堆，会在第一个文件之后悄悄丢弃嵌套的调用/导入；例如 tree-sitter-wasms 的 **Lua** 语法是 ABI 13 并会失败），则不要使用该 wasm。**改为 vendor 一个更新的（ABI 14/15）构建：**
```bash
npm pack @tree-sitter-grammars/tree-sitter-<lang>   # 通常附带预构建的 *.wasm
# 或自行构建：npx tree-sitter build --wasm   （需要 Docker/emscripten）
cp <the>.wasm src/extraction/wasm/tree-sitter-<lang>.wasm
```
然后在第 4 步中将该 token 加入 vendored 分支，并对 vendored 路径重新运行 check-grammar，直到通过。**如果无法获得健康的 wasm，停止并告知用户。**

### 第 3 步 — 探索 AST 节点类型

获取一个具有代表性的源文件（编写一个涵盖函数、类/结构体、导入、枚举的小样本；或从已知仓库 `curl` 一个原始文件），然后：
```bash
node scripts/add-lang/dump-ast.mjs <lang> path/to/sample.<ext>
# vendored 语法：传入 wasm 路径而非 token
node scripts/add-lang/dump-ast.mjs src/extraction/wasm/tree-sitter-<lang>.wasm sample.<ext>
```
频率表 + 字段名（`name:`、`parameters:`、`body:`、`return_type:`）会告诉你需要映射哪些内容。参考与该语言范式最接近的现有提取器作为模板：`rust.ts`/`scala.ts`（函数式、trait）、`java.ts`/`csharp.ts`（OO）、`python.ts`/`ruby.ts`（脚本）、`go.ts`（顶层方法 + receiver）。

### 第 4 步 — 接入语言（4 个文件）

这些是精确且易碎的接入操作——严格匹配现有风格：

1. **`src/types.ts`** — 两处修改：
   - 在 `LANGUAGES` 常量中添加 `'<lang>',`（放在 `'unknown'` 之前）；
   - 在 `DEFAULT_CONFIG.include` 中添加 `'**/*.<ext>',`。**不要跳过**——这是文件扫描白名单；没有该 glob，即使检测/提取已接入，`synapse init` 也会找到 **0 个文件**。
2. **`src/extraction/grammars.ts`** — 三个映射：
   - `WASM_GRAMMAR_FILES`：`<lang>: 'tree-sitter-<lang>.wasm',`
   - `EXTENSION_MAP`：每个文件扩展名 → `'<lang>'`（例如 `'.lua': 'lua',`）
   - `getLanguageDisplayName`：`<lang>: '<Display Name>',`
   - **仅 vendored**：将 `<lang>` 添加到 `(lang === 'pascal' || lang === 'scala' || …)` 的 wasm 路径分支中。
3. **`src/extraction/languages/<lang>.ts`** — 新文件，导出 `export const <lang>Extractor: LanguageExtractor = { … }`。映射第 3 步中发现的节点类型。必填字段：`functionTypes`、`classTypes`、`methodTypes`、`interfaceTypes`、`structTypes`、`enumTypes`、`typeAliasTypes`、`importTypes`、`callTypes`、`variableTypes`、`nameField`、`bodyField`、`paramsField`。根据语法需要添加钩子（`getSignature`、`getVisibility`、`isExported`、`extractImport`、`visitNode`、`getReceiverType`、`interfaceKind`、`enumMemberTypes` 等——见 `src/extraction/tree-sitter-types.ts`）。
4. **`src/extraction/languages/index.ts`** — `import { <lang>Extractor } from './<lang>';` 并在 `EXTRACTORS` 中添加 `<lang>: <lang>Extractor,`。

**有时需要对 `src/extraction/tree-sitter.ts` 进行第 5 处核心修改**——变量提取在 `extractVariable` 中有按语言分支的逻辑（通用回退只能找到直接的 `identifier`/`variable_declarator` 子节点）。如果语法中声明的名称有嵌套结构（例如 Lua 的 `variable_declaration → variable_list`），在那里添加一个 `} else if (this.language === '<lang>')` 分支，参照现有的 ts/python/go 分支。不是独立节点的导入形式（Lua/Ruby 的 `require` 是一个*调用*）则在提取器的 `visitNode` 钩子中处理。

### 第 5 步 — 构建 + 验证循环

```bash
npm run build            # tsc + copy-assets（将所有 vendored *.wasm 复制到 dist/）
```
对一个小型样本仓库建立索引并检查提取结果：
```bash
( cd <sample-repo> && synapse init -i )
node scripts/add-lang/verify-extraction.mjs <sample-repo> <lang>
```
如果语言未被检测到，或只生成了 `file`/`import` 节点——这是节点类型名称错误的典型症状——`verify-extraction.mjs` 会失败（退出码 1）。遇到 FAIL 或 WARN 较多时：对更丰富的文件重新运行 `dump-ast.mjs`，修正 `<lang>.ts` 中的映射，`npm run build`，重新建索引，重新验证。**循环直到 PASS。**

### 第 6 步 — 测试

在 `__tests__/extraction.test.ts` 中添加测试，参照 `Rust Extraction` 代码块：
- 在 `describe('Language Detection')` 中添加一个 `detectLanguage` 断言
- 添加一个 `describe('<Lang> Extraction')` 代码块，断言能从内联源码字符串中提取函数/类/导入
```bash
npx vitest run __tests__/extraction.test.ts
```
全部通过后再继续。

### 第 7 步 — 自动选取 3 个仓库并更新 corpus

**无需询问**，直接选取。寻找候选仓库，然后筛选出 3 个真正以 `<lang>` 为主的仓库，每个规模一个：
```bash
gh search repos --language=<lang> --sort=stars --limit 40 \
  --json fullName,stargazerCount,description
```
规模分级（与 `corpus.json` 对应）：**Small** 文件数 <~150 · **Medium** ~150–1500 · **Large** >~1500。跳过标记为 `<lang>` 但实际主要使用另一种语言的仓库。为每个仓库编写一个跨文件架构**问题**（需要跨文件追踪的类型）。在 `.claude/skills/agent-eval/corpus.json` 中添加一个 `"<Language>"` 块（字段：`name`、`repo`、`size`、`files`、`question`），以便 `/agent-eval` 复用。

### 第 8 步 — 对全部 3 个仓库进行基准测试（提取 + A/B）

**一次性**将开发构建设置为 PATH 上的 synapse，然后循环执行：
```bash
npm run build && ./scripts/local-install.sh
scripts/add-lang/bench.sh <lang> <name> <url> "<question>" headless   # ×3
```
`bench.sh` 会克隆仓库（共享 `/tmp/synapse-corpus`）、清空并重新建索引、运行 `verify-extraction.mjs`，然后通过 `scripts/agent-eval/run-all.sh` 运行有/无检索的 A/B 对比（如果提取失败则跳过付费 A/B）。读取 `run-all.sh` 打印的每个 `parse-run.mjs` 摘要：工具调用次数、文件 `Read` 次数、Grep/Bash 次数、synapse 工具调用次数、耗时和**成本**——`with` 和 `without` 两个 arm 均需记录。循环结束后，如有需要请恢复开发链接：`./scripts/local-install.sh`。

### 第 9 步 — 文档 + CHANGELOG

- **README.md**：在"19+ Languages"功能要点中添加 `<Lang>`，并在**支持的语言**表格中添加一行：
  `| <Lang> | \`.ext\` | 完整支持（类、方法……） |`。
- **CHANGELOG.md**：在顶部（最新版本之上）添加 `## [Unreleased]` 节，写入 `### Added` → 一条面向用户的条目，例如：
  *"Synapse 现已支持索引 **<Lang>**（`.ext`）——函数、类、导入和调用边。"* 如果 `## [Unreleased]` 已存在，则在其下追加。（发布时会自动折叠到下一个版本块中。）

### 第 10 步 — 汇报（不要提交）

整理供审查的摘要：
- **修改的文件**：4 处接入修改 + 新提取器 + 测试 + README + CHANGELOG + corpus.json（+ 任何 vendored `.wasm`）。
- **每个仓库的提取结果**：文件数 / 节点数 / 边数 / `verify-extraction` 结果。
- **每个仓库的 A/B 对比**：`with` 与 `without`（工具调用次数、文件 Read 次数、成本）以及一句话结论——synapse 是否降低了工作量，两个 arm 是否都得到了正确答案？
- **不足与后续工作**（尚未映射的节点类型、缺失的解析边、框架路由等）。

将变更交给用户。**不要**运行 `git commit`/`push` 或发布——发布通过 GitHub Actions Release workflow 进行。

## 注意事项
- A/B 测试会派生真实的**付费** `claude -p` 运行（opus，`--max-budget-usd`），2 个 arm × 3 个仓库。语料库目录 `/tmp/synapse-corpus` 与 `/agent-eval` 共享，克隆的仓库可跨运行复用。
- 任何新的 `*.wasm` 都必须放在 `src/extraction/wasm/` 中——`copy-assets`（由 `npm run build` 调用）会将其打包；否则不会出现在 `dist/` 中。
- 索引必须由**构建它的同一个**二进制文件提供服务。第 8 步会先构建并链接开发构建，以确保这一点成立。
- 如果无法获取语法，或提取无法达到 PASS，**停止并汇报**——不要发布半接入的语言。
