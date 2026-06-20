/**
 * Swift 框架解析器
 *
 * 处理 SwiftUI、UIKit 及 Vapor（服务端 Swift）模式。
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const swiftUIResolver: FrameworkResolver = {
  name: 'swiftui',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    // 检查 Swift 文件中是否有 SwiftUI 导入
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import SwiftUI')) {
          return true;
        }
      }
    }

    // 检查是否有包含 SwiftUI 的 Xcode 项目
    for (const file of allFiles) {
      if (file.endsWith('.xcodeproj') || file.endsWith('.xcworkspace')) {
        return true;
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 模式 1：View 引用（SwiftUI View 为 PascalCase 且以 View 结尾）
    if (ref.referenceName.endsWith('View') && /^[A-Z]/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, VIEW_KINDS, VIEW_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 2：ViewModel/ObservableObject 引用
    if (ref.referenceName.endsWith('ViewModel') || ref.referenceName.endsWith('Store') || ref.referenceName.endsWith('Manager')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, VIEWMODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 3：Model 引用
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, MODEL_KINDS, MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.swift')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'swift');

    // 提取 SwiftUI View struct
    // struct ContentView: View { ... }
    const viewPattern = /struct\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*View/g;

    let match: RegExpExecArray | null;
    while ((match = viewPattern.exec(safe)) !== null) {
      const [, viewName] = match;
      const line = safe.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `view:${filePath}:${viewName}:${line}`,
        kind: 'component',
        name: viewName!,
        qualifiedName: `${filePath}::${viewName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    // 提取 @main App 入口点
    const appPattern = /@main\s+struct\s+(\w+)\s*:\s*App/g;

    while ((match = appPattern.exec(safe)) !== null) {
      const [, appName] = match;
      const line = safe.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `app:${filePath}:${appName}:${line}`,
        kind: 'class',
        name: appName!,
        qualifiedName: `${filePath}::${appName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    return { nodes, references: [] };
  },
};

export const uikitResolver: FrameworkResolver = {
  name: 'uikit',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('import UIKit') ||
          content.includes('UIViewController') ||
          content.includes('UIView')
        )) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 模式 1：ViewController 引用
    if (ref.referenceName.endsWith('ViewController')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, VC_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 2：UIView 子类引用
    if (ref.referenceName.endsWith('View') && !ref.referenceName.endsWith('ViewController')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, UIVIEW_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 3：Cell 引用
    if (ref.referenceName.endsWith('Cell')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, CELL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 4：Delegate/DataSource 引用
    if (ref.referenceName.endsWith('Delegate') || ref.referenceName.endsWith('DataSource')) {
      const result = resolveByNameAndKind(ref.referenceName, PROTOCOL_KINDS, [], context);
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
    if (!filePath.endsWith('.swift')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'swift');

    // 提取 UIViewController 子类
    const vcPattern = /class\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*UIViewController/g;

    let match: RegExpExecArray | null;
    while ((match = vcPattern.exec(safe)) !== null) {
      const [, vcName] = match;
      const line = safe.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `viewcontroller:${filePath}:${vcName}:${line}`,
        kind: 'class',
        name: vcName!,
        qualifiedName: `${filePath}::${vcName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    // 提取 UIView 子类
    const viewPattern = /class\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*UIView[^C]/g;

    while ((match = viewPattern.exec(safe)) !== null) {
      const [, viewName] = match;
      const line = safe.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `uiview:${filePath}:${viewName}:${line}`,
        kind: 'class',
        name: viewName!,
        qualifiedName: `${filePath}::${viewName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    return { nodes, references: [] };
  },
};

export const vaporResolver: FrameworkResolver = {
  name: 'vapor',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    // 检查 Package.swift 中是否有 Vapor 依赖
    const packageSwift = context.readFile('Package.swift');
    if (packageSwift && packageSwift.includes('vapor')) {
      return true;
    }

    // 检查是否有 Vapor 导入
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import Vapor')) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // 模式 1：Controller 引用
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref.referenceName, VAPOR_CONTROLLER_KINDS, VAPOR_CONTROLLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 2：Model 引用（Fluent）
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, FLUENT_MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    // 模式 3：Middleware 引用
    if (ref.referenceName.endsWith('Middleware')) {
      const result = resolveByNameAndKind(ref.referenceName, VAPOR_CONTROLLER_KINDS, VAPOR_MIDDLEWARE_DIRS, context);
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
    if (!filePath.endsWith('.swift')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'swift');

    // 先构建 group 变量 → 路径前缀映射。现代 Vapor 路由位于分组构建器上
    // （`let todos = routes.grouped("todos"); todos.get(use: index)`
    // 或 `routes.group("todos") { todos in todos.get(use: index) }`），
    // 因此路径来自 group，而非调用本身。根节点（app/routes/router）无前缀。
    const groupPrefix = new Map<string, string>();
    const segJoin = (existing: string, segsStr: string): string => {
      const segs = (segsStr.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1));
      return existing + segs.map((s) => '/' + s).join('');
    };
    let gm: RegExpExecArray | null;
    // let X = Y.grouped("a", "b")
    const groupedRegex = /\blet\s+(\w+)\s*=\s*(\w+)\.grouped\s*\(([^)]*)\)/g;
    while ((gm = groupedRegex.exec(safe)) !== null) {
      groupPrefix.set(gm[1]!, segJoin(groupPrefix.get(gm[2]!) ?? '', gm[3]!));
    }
    // Y.group("a") { X in ... }
    const groupClosureRegex = /\b(\w+)\.group\s*\(([^)]*)\)\s*\{\s*(\w+)\s+in/g;
    while ((gm = groupClosureRegex.exec(safe)) !== null) {
      groupPrefix.set(gm[3]!, segJoin(groupPrefix.get(gm[1]!) ?? '', gm[2]!));
    }

    // Vapor：<builder>.METHOD([路径段,] use: handler)。任意接收者（app、
    // routes 或分组变量）；路径段可选且可能为非字符串
    // （`BlogUser.parameter`、`:id`、路径常量），因此接受 `use:` 之前的
    // 任意逗号分隔参数——标签只保留字符串部分。`use:` 将真实路由与
    // Environment.get("X")/req.parameters.get("X") 区分开来。
    const routeRegex = /\b(\w+)\.(get|post|put|patch|delete|head|options)\s*\(\s*((?:[^,()]+,\s*)*)use:\s*([A-Za-z_][\w.]*)/g;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, receiver, method, segsStr, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const upper = method!.toUpperCase();
      const routePath = (groupPrefix.get(receiver!) ?? '') + segJoin('', segsStr!) || '/';

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${upper}:${routePath}`,
        kind: 'route',
        name: `${upper} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      };
      nodes.push(routeNode);

      // 点分 handler 的最后一段（self.list / UserController.list -> list）
      const handlerName = handlerExpr!.split('.').pop();
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'swift',
        });
      }
    }

    return { nodes, references };
  },
};

// 目录模式
const VIEW_DIRS = ['/Views/', '/View/', '/Screens/', '/Components/', '/UI/'];
const VIEWMODEL_DIRS = ['/ViewModels/', '/ViewModel/', '/Stores/', '/Managers/', '/Services/'];
const MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Domain/'];
const VC_DIRS = ['/ViewControllers/', '/ViewController/', '/Controllers/', '/Screens/'];
const UIVIEW_DIRS = ['/Views/', '/View/', '/UI/', '/Components/'];
const CELL_DIRS = ['/Cells/', '/Cell/', '/Views/', '/TableViewCells/', '/CollectionViewCells/'];
const VAPOR_CONTROLLER_DIRS = ['/Controllers/', '/Controller/', '/Routes/'];
const FLUENT_MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Database/'];
const VAPOR_MIDDLEWARE_DIRS = ['/Middleware/', '/Middlewares/'];

const VIEW_KINDS = new Set(['struct', 'component']);
const CLASS_KINDS = new Set(['class']);
const MODEL_KINDS = new Set(['struct', 'class']);
const PROTOCOL_KINDS = new Set(['protocol']);
const VAPOR_CONTROLLER_KINDS = new Set(['class', 'struct']);

/**
 * 通过索引查询按名称解析符号，而非扫描所有文件。
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

  // 优先选取框架惯用目录中的候选项
  if (preferredDirPatterns.length > 0) {
    const preferred = kindFiltered.filter((n) =>
      preferredDirPatterns.some((d) => n.filePath.includes(d))
    );
    if (preferred.length > 0) return preferred[0]!.id;
  }

  // 回退到任意匹配项
  return kindFiltered[0]!.id;
}
