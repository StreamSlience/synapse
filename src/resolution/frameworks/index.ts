/**
 * 框架解析器注册表
 *
 * 管理框架专属解析器。
 */

import { FrameworkResolver, ResolutionContext } from '../types';
import type { Language } from '../../types';
import { drupalResolver } from './drupal';
import { laravelResolver } from './laravel';
import { expressResolver } from './express';
import { nestjsResolver } from './nestjs';
import { reactResolver } from './react';
import { svelteResolver } from './svelte';
import { vueResolver } from './vue';
import { astroResolver } from './astro';
import { djangoResolver, flaskResolver, fastapiResolver } from './python';
import { railsResolver } from './ruby';
import { springResolver } from './java';
import { playResolver } from './play';
import { goResolver } from './go';
import { rustResolver } from './rust';
import { aspnetResolver } from './csharp';
import { swiftUIResolver, uikitResolver, vaporResolver } from './swift';
import { swiftObjcBridgeResolver } from './swift-objc';
import { reactNativeBridgeResolver } from './react-native';
import { expoModulesResolver } from './expo-modules';
import { fabricViewResolver } from './fabric';

/**
 * 所有已注册的框架解析器
 */
const FRAMEWORK_RESOLVERS: FrameworkResolver[] = [
  // PHP
  laravelResolver,
  drupalResolver,
  // JavaScript/TypeScript
  expressResolver,
  nestjsResolver,
  reactResolver,
  svelteResolver,
  vueResolver,
  astroResolver,
  // Python
  djangoResolver,
  flaskResolver,
  fastapiResolver,
  // Ruby
  railsResolver,
  // Java
  springResolver,
  playResolver,
  // Go
  goResolver,
  // Rust
  rustResolver,
  // C#
  aspnetResolver,
  // Swift
  swiftUIResolver,
  uikitResolver,
  vaporResolver,
  // Swift ↔ Objective-C 跨语言桥接（混合 iOS 应用）
  swiftObjcBridgeResolver,
  // React Native JS ↔ 原生桥接（Legacy + TurboModules）
  reactNativeBridgeResolver,
  // Expo Modules——Swift/Kotlin 上的 Function/AsyncFunction/Property DSL
  expoModulesResolver,
  // React Native Fabric / Codegen 视图组件——TS 规范 → 组件节点
  fabricViewResolver,
];

/**
 * 获取所有框架解析器
 */
export function getAllFrameworkResolvers(): FrameworkResolver[] {
  return FRAMEWORK_RESOLVERS;
}

/**
 * 按名称获取解析器
 */
export function getFrameworkResolver(name: string): FrameworkResolver | undefined {
  return FRAMEWORK_RESOLVERS.find((r) => r.name === name);
}

/**
 * 检测项目中使用了哪些框架
 */
export function detectFrameworks(context: ResolutionContext): FrameworkResolver[] {
  return FRAMEWORK_RESOLVERS.filter((resolver) => {
    try {
      return resolver.detect(context);
    } catch {
      return false;
    }
  });
}

/**
 * 将已检测到的框架列表过滤为适用于给定语言的框架。
 * 没有显式 `languages` 列表的框架视为通用框架。
 */
export function getApplicableFrameworks(
  detected: FrameworkResolver[],
  language: Language
): FrameworkResolver[] {
  return detected.filter(
    (fw) => !fw.languages || fw.languages.includes(language)
  );
}

/**
 * 注册自定义框架解析器
 */
export function registerFrameworkResolver(resolver: FrameworkResolver): void {
  // 移除同名的已有解析器
  const index = FRAMEWORK_RESOLVERS.findIndex((r) => r.name === resolver.name);
  if (index !== -1) {
    FRAMEWORK_RESOLVERS.splice(index, 1);
  }
  FRAMEWORK_RESOLVERS.push(resolver);
}

// 重新导出框架解析器
export { drupalResolver } from './drupal';
export { laravelResolver, FACADE_MAPPINGS } from './laravel';
export { expressResolver } from './express';
export { nestjsResolver } from './nestjs';
export { reactResolver } from './react';
export { svelteResolver } from './svelte';
export { vueResolver } from './vue';
export { astroResolver } from './astro';
export { djangoResolver, flaskResolver, fastapiResolver } from './python';
export { railsResolver } from './ruby';
export { springResolver } from './java';
export { playResolver } from './play';
export { goResolver } from './go';
export { rustResolver } from './rust';
export { aspnetResolver } from './csharp';
export { swiftUIResolver, uikitResolver, vaporResolver } from './swift';
export { swiftObjcBridgeResolver } from './swift-objc';
export { reactNativeBridgeResolver } from './react-native';
export { expoModulesResolver } from './expo-modules';
export { fabricViewResolver } from './fabric';
