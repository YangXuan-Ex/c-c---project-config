# C/C++ Project Config

图形化配置C/C++项目的编译、调试功能。
不依赖makefile、cmake构建工具，而是直接使用vscode原生构建文件：
`c_cpp_properties.json`、`tasks.json` 和 `launch.json` 文件。
开发人员需要自行下载编译器如：GCC，并在界面中配置指定GCC路径。

## 功能特点

- 🚀 安装插件后在资源管理器空白处右键菜单会增加两个按钮：
	1、配置C/C++工程
	2、配置编译调试文件
- ⚙️ 自动从 `c_cpp_properties.json` 提取配置
- 📦 支持自定义源文件、库文件
- 🔧 一键图形配置生成 tasks.json 和 launch.json，并且会与c_cpp_properties.json文件动态同步更新

## 使用说明

### 1. 配置C/C++工程
在资源管理器空白处右键点击任意文件 → **配置C/C++工程**，自动生成 `c_cpp_properties.json`

### 2. 配置编译调试文件
生成 `c_cpp_properties.json` 后，右键菜单会启用 **配置编译调试文件**

在弹出的界面中：
- 添加源文件（.c/.cpp）
- 添加链接库（.a/.so）
- 设置可执行文件名称和输出路径以及调试器配置

点击确定后，自动在 `.vscode` 文件夹下生成：
- `tasks.json` - 编译配置
- `launch.json` - 调试配置

## 演示动图

![完整演示](https://raw.githubusercontent.com/EXyang-Repo/c-c---project-config/main/explain.gif)

## 系统要求

- VSCode 1.70.0 或更高版本
- Windows 7/8/10/11、macOS、Linux

## 许可证

MIT