/**
 * C# 框架解析器
 *
 * 处理 ASP.NET Core、ASP.NET MVC 及常见 C# 模式。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const aspnetResolver: FrameworkResolver = {
  name: 'aspnet',
  languages: ['csharp'],

  detect(context: ResolutionContext): boolean {
    // 检查包含 ASP.NET 引用的 .csproj 文件
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.csproj')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('Microsoft.AspNetCore') ||
          content.includes('Microsoft.NET.Sdk.Web') ||
          content.includes('System.Web.Mvc')
        )) {
          return true;
        }
      }
    }

    // 检查包含 WebApplication 的 Program.cs
    const programCs = context.readFile('Program.cs');
    if (programCs && (
      programCs.includes('WebApplication') ||
      programCs.includes('CreateHostBuilder') ||
      programCs.includes('UseStartup')
    )) {
      return true;
    }

    // 检查 Startup.cs（ASP.NET Core 特征文件）
    if (context.fileExists('Startup.cs')) {
      return true;
    }

    // 扫描控制器/入口点源码中的 ASP.NET 特征——覆盖无 `/Controllers/` 目录的
    // feature-folder 应用，以及上方仅检查根目录时遗漏的子目录 Program.cs
    // （例如 realworld：Features/*/FooController.cs）。
    // `.csproj` 通常不在已索引的源文件集合中，因此源码扫描是更可靠的信号。
    for (const file of allFiles) {
      if (!/(?:Controller|Program|Startup)\.cs$/.test(file)) continue;
      const c = context.readFile(file);
      if (c && (
        /\[(?:ApiController|Route|Http(?:Get|Post|Put|Patch|Delete))\b/.test(c) ||
        c.includes('ControllerBase') || c.includes(': Controller') ||
        c.includes('MapControllers') || c.includes('WebApplication') ||
        c.includes('Microsoft.AspNetCore')
      )) return true;
    }
    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 模式 1：Controller 引用
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, CONTROLLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 2：Service 引用（依赖注入）
    if (ref.referenceName.endsWith('Service') || ref.referenceName.startsWith('I') && ref.referenceName.length > 1) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, SERVICE_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 3：Repository 引用
    if (ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, REPO_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 4：Model/Entity 引用
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 5：ViewModel 引用
    if (ref.referenceName.endsWith('ViewModel') || ref.referenceName.endsWith('Dto')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, VIEWMODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.cs')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'csharp');

    // 类级别 [Route("api/[controller]")] 前缀——拼接到每个 action 路径上。
    let classPrefix = '';
    const cls = /\[Route\s*\(\s*"([^"]+)"[^)]*\)\]\s*(?:\[[^\]]*\]\s*)*(?:public\s+|sealed\s+|abstract\s+|partial\s+)*class\b/.exec(safe);
    if (cls) classPrefix = cls[1]!;

    // [HttpGet]、[HttpGet("path")]、[HttpPost("path", Name="x")] —— 裸特性或带路径。
    // （旧正则要求必须有字符串，因此裸特性——路由在类级 [Route] 上——会被遗漏；
    // eShopOnWeb 中有 24 个裸特性 / 2 个带字符串。）
    const attrRegex = /\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)(?:\s*\(\s*"([^"]+)"[^)]*\))?\s*\]/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(safe)) !== null) {
      const verb = match[1]!;
      const method = verb.replace(/^Http/, '').toUpperCase();
      const routePath = joinCsPath(classPrefix, match[2] || '');
      const line = safe.slice(0, match.index).split('\n').length;

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'csharp',
        updatedAt: now,
      };
      nodes.push(routeNode);

      // 紧跟的方法声明（跳过堆叠特性；C# 将返回类型放在名称之前）。
      // 设置上限，避免匹配到很远的声明。
      const tail = safe.slice(match.index + match[0].length, match.index + match[0].length + 600);
      const methodMatch = tail.match(/(?:public|private|protected|internal)\s+[\w<>,\s\[\]?.]+?\s+(\w+)\s*\(/);
      if (methodMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: methodMatch[1]!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'csharp',
        });
      }
    }

    // Minimal APIs：app.MapGet("/path", handler)
    const minimalRegex = /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"\s*,\s*([^,)]+)/g;
    while ((match = minimalRegex.exec(safe)) !== null) {
      const [, verb, routePath, handlerExpr] = match;
      const method = verb!.toUpperCase();
      const line = safe.slice(0, match.index).split('\n').length;

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'csharp',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handlerName = extractCSharpTailIdent(handlerExpr!);
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'csharp',
        });
      }
    }

    return { nodes, references };
  },
};

/** 将类级别 [Route] 前缀与 action 路径拼接为规范化的 `/path`。 */
function joinCsPath(prefix: string, sub: string): string {
  const parts = [prefix, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

/** 从 `MyService.Handler` 或 `Handler` 之类的表达式中提取最后一个标识符。 */
function extractCSharpTailIdent(expr: string): string | null {
  const cleaned = expr.trim().replace(/\s+/g, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1]! : null;
}

// 目录模式
const CONTROLLER_DIRS = ['/Controllers/'];
const SERVICE_DIRS = ['/Services/', '/Service/', '/Application/'];
const REPO_DIRS = ['/Repositories/', '/Repository/', '/Data/', '/Infrastructure/'];
const MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Entity/', '/Domain/'];
const VIEWMODEL_DIRS = ['/ViewModels/', '/ViewModel/', '/DTOs/', '/Dto/'];

const CLASS_KINDS = new Set(['class']);
const SERVICE_KINDS = new Set(['class', 'interface']);

/**
 * 通过名称使用索引查询解析符号，而非扫描所有文件。
 */
function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // 优先选择位于框架惯例目录中的候选项
  const preferred = kindFiltered.filter((n) =>
    preferredDirPatterns.some((d) => n.filePath.includes(d))
  );

  if (preferred.length > 0) return preferred[0]!.id;

  // 回退到任意匹配项
  return kindFiltered[0]!.id;
}
