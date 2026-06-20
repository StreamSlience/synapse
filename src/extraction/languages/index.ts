/**
 * 各编程语言的提取配置。
 *
 * 每个文件导出一个 LanguageExtractor 配置对象。
 * 本桶文件构建供 TreeSitterExtractor 使用的 EXTRACTORS 映射表。
 */

import { Language } from '../../types';
import type { LanguageExtractor } from '../tree-sitter-types';

import { typescriptExtractor } from './typescript';
import { javascriptExtractor } from './javascript';
import { pythonExtractor } from './python';
import { goExtractor } from './go';
import { rustExtractor } from './rust';
import { javaExtractor } from './java';
import { cExtractor, cppExtractor } from './c-cpp';
import { csharpExtractor } from './csharp';
import { phpExtractor } from './php';
import { rubyExtractor } from './ruby';
import { swiftExtractor } from './swift';
import { kotlinExtractor } from './kotlin';
import { dartExtractor } from './dart';
import { pascalExtractor } from './pascal';
import { scalaExtractor } from './scala';
import { luaExtractor } from './lua';
import { rExtractor } from './r';
import { luauExtractor } from './luau';
import { objcExtractor } from './objc';

export const EXTRACTORS: Partial<Record<Language, LanguageExtractor>> = {
  typescript: typescriptExtractor,
  tsx: typescriptExtractor,
  javascript: javascriptExtractor,
  jsx: javascriptExtractor,
  python: pythonExtractor,
  go: goExtractor,
  rust: rustExtractor,
  java: javaExtractor,
  c: cExtractor,
  cpp: cppExtractor,
  csharp: csharpExtractor,
  php: phpExtractor,
  ruby: rubyExtractor,
  swift: swiftExtractor,
  kotlin: kotlinExtractor,
  dart: dartExtractor,
  pascal: pascalExtractor,
  scala: scalaExtractor,
  lua: luaExtractor,
  r: rExtractor,
  luau: luauExtractor,
  objc: objcExtractor,
};
