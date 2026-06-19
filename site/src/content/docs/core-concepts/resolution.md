---
title: 解析与框架
description: Synapse 如何连接引用并将路由与处理函数关联。
---

提取阶段生成节点和原始边；**解析**阶段将名称转化为真实的连接。

## 引用解析

解析完成后，Synapse 会处理：

- **导入** → 指向的源文件（包括 tsconfig 路径别名和 cargo 工作区成员）。
- **调用** → 其定义（通过导入解析和名称匹配）。
- **继承** → 类型之间的 `extends` / `implements` 关系。

## 框架感知

Synapse 能识别 Web 框架的路由文件，并生成 `route` 节点，通过 `references` 边与对应的处理类或函数关联——查询某个视图或控制器的调用者时，就能直接看到绑定它的 URL 模式。支持的框架完整列表请参见[框架路由](/synapse/guides/framework-routes/)。

## 动态分发覆盖

静态解析无法捕获计算型和间接调用，导致调用链在动态分发处断裂。Synapse 通过合成器桥接了以下几类边界，使调用链端到端连通：

- 回调 / 观察者注册
- `EventEmitter` 通道
- React 重渲染（`setState` → `render`）
- JSX 子组件（`render` → 子组件）
- Django ORM 描述符

每条合成边都标有 `provenance: 'heuristic'` 和接线点信息，并在调用路径经过时内联展示。
