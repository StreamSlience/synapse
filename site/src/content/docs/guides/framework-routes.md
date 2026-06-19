---
title: 框架路由
description: Synapse 将 URL 模式与对应的处理函数关联起来。
---

Synapse 能检测 Web 框架的路由文件，并生成 `route` 节点，通过 `references` 边与对应的处理类或函数关联。查询某个视图或控制器的调用者时，就能直接看到绑定它的 URL 模式。

| 框架 | 可识别的形式 |
|---|---|
| **Django** | `urls.py` 中的 `path()`、`re_path()`、`url()`、`include()`（CBV 的 `.as_view()`、点分路径） |
| **Flask** | `@app.route('/path', methods=[…])`、Blueprint 路由 |
| **FastAPI** | `@app.get(…)`、`@router.post(…)` 等所有标准方法 |
| **Express** | `app.get(…)`、`router.post(…)` 及中间件链 |
| **NestJS** | `@Controller` + `@Get/@Post/…`、GraphQL 解析器、消息/事件模式、WebSocket 订阅 |
| **Laravel** | `Route::get()`、`Route::resource()`、`Controller@action`、元组语法 |
| **Drupal** | `*.routing.yml` 路由；`.module`/`.theme`/`.install`/`.inc` 中的 `hook_*` 实现 |
| **Rails** | `get '/x', to: 'users#index'`、hash-rocket 语法 |
| **Spring** | 方法上的 `@GetMapping`、`@PostMapping`、`@RequestMapping` |
| **Gin / chi / gorilla / mux** | `r.GET(…)`、`router.HandleFunc(…)` |
| **Axum / actix / Rocket** | `.route("/x", get(handler))` |
| **ASP.NET** | action 方法上的 `[HttpGet("/x")]` 特性 |
| **Vapor** | `app.get("x", use: handler)` |
| **React Router** / **SvelteKit** | 路由组件节点 |

路由解析是自动完成的，无需任何配置。只要框架文件被识别，其路由就会在下次索引或同步后出现在图谱中。
