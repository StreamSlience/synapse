# Starlight 入门套件：基础版

[![Built with Starlight](https://astro.badg.es/v2/built-with-starlight/tiny.svg)](https://starlight.astro.build)

```
npm create astro@latest -- --template starlight
```

> 🧑‍🚀 **老手？** 删掉这个文件，尽情玩吧！

## 🚀 项目结构

在 Astro + Starlight 项目中，你会看到如下目录和文件：

```
.
├── public/
├── src/
│   ├── assets/
│   ├── content/
│   │   └── docs/
│   └── content.config.ts
├── astro.config.mjs
├── package.json
└── tsconfig.json
```

Starlight 会在 `src/content/docs/` 目录中查找 `.md` 或 `.mdx` 文件，每个文件根据文件名暴露为一个路由。

图片可以放在 `src/assets/` 中，并在 Markdown 里使用相对链接引用。

静态资源（如 favicon）可以放在 `public/` 目录中。

## 🧞 命令

所有命令均在项目根目录的终端中运行：

| 命令                        | 说明                                              |
| :-------------------------- | :------------------------------------------------ |
| `npm install`               | 安装依赖                                          |
| `npm run dev`               | 在 `localhost:4321` 启动本地开发服务器            |
| `npm run build`             | 将生产站点构建到 `./dist/`                        |
| `npm run preview`           | 在部署前本地预览构建结果                          |
| `npm run astro ...`         | 运行 CLI 命令，如 `astro add`、`astro check`      |
| `npm run astro -- --help`   | 获取 Astro CLI 的帮助信息                         |

## 👀 想了解更多？

查阅 [Starlight 文档](https://starlight.astro.build/)，阅读 [Astro 文档](https://docs.astro.build)，或加入 [Astro Discord 社区](https://astro.build/chat)。
