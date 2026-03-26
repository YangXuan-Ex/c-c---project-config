import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// 全局变量存储文件监听器和当前配置
let cppPropertiesWatcher: vscode.FileSystemWatcher | undefined;
let currentCppConfig: any = {};
let currentWorkspacePath: string = '';
// 存储上次选择的目录（用于原生对话框，保留备用）
let lastSourceDir: string | undefined;
let lastLibDir: string | undefined;

// 检测是否在 WSL 环境中
function isWSL(): boolean {
    const release = process.platform === 'linux' ? require('os').release().toLowerCase() : '';
    return release.includes('microsoft') || release.includes('wsl');
}

// 检测平台类型
function getPlatform(): 'win32' | 'linux' | 'darwin' {
    return process.platform as 'win32' | 'linux' | 'darwin';
}

// 激活插件时调用
export function activate(context: vscode.ExtensionContext) {
    console.log('C/C++工程配置助手已激活');
    console.log(`运行平台: ${getPlatform()}, WSL: ${isWSL()}`);

    // 初始化文件监听
    setupFileWatcher(context);

    // 监听工作区变化（切换文件夹时重新设置监听）
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            setupFileWatcher(context);
        })
    );

    // 命令1：配置C/C++工程（打开UI配置c_cpp_properties.json）
    let editConfigsCmd = vscode.commands.registerCommand('cpp-configurator.editConfigs', async () => {
        try {
            await vscode.commands.executeCommand('C_Cpp.ConfigurationEditUI');
            vscode.window.showInformationMessage('已打开C/C++配置界面，请配置完成后保存');
        } catch (error) {
            const install = await vscode.window.showErrorMessage(
                '未检测到Microsoft C/C++扩展，是否前往安装？',
                '安装', '取消'
            );
            if (install === '安装') {
                vscode.commands.executeCommand('workbench.extensions.search', 'ms-vscode.cpptools');
            }
        }
    });

    // 命令2：配置编译调试文件（生成tasks.json和launch.json）
    let setupBuildDebugCmd = vscode.commands.registerCommand('cpp-configurator.setupBuildDebug', async (uri: vscode.Uri) => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('请先打开一个工作区文件夹');
            return;
        }

        const vscodePath = path.join(workspaceFolder.uri.fsPath, '.vscode');
        const cppPropertiesPath = path.join(vscodePath, 'c_cpp_properties.json');
        const tasksPath = path.join(vscodePath, 'tasks.json');
        const launchPath = path.join(vscodePath, 'launch.json');

        // 检查c_cpp_properties.json是否存在
        if (!fs.existsSync(cppPropertiesPath)) {
            vscode.window.showErrorMessage('未找到c_cpp_properties.json，请先使用"配置C/C++工程"生成该文件');
            return;
        }

        // 读取c_cpp_properties.json获取配置信息（后台使用，不显示）
        let cppConfig: any = {};
        try {
            const content = fs.readFileSync(cppPropertiesPath, 'utf8');
            cppConfig = JSON.parse(content);
            // 保存当前配置
            currentCppConfig = cppConfig;
            currentWorkspacePath = workspaceFolder.uri.fsPath;
        } catch (error) {
            vscode.window.showErrorMessage('读取c_cpp_properties.json失败，请检查文件格式');
            return;
        }

        // 读取现有的tasks.json（如果存在）
        let existingSources: string[] = [];
        let existingLibs: string[] = [];
        let existingOutputName: string = 'main';
        let existingOutputPath: string = './build';

        if (fs.existsSync(tasksPath)) {
            try {
                const existingTasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
                if (existingTasks.tasks && existingTasks.tasks.length > 0) {
                    // 查找默认构建任务（group.isDefault === true）或第一个有args的任务
                    let buildTask = existingTasks.tasks.find((t: any) => 
                        t.group && t.group.isDefault === true && t.group.kind === 'build'
                    );
                    if (!buildTask) {
                        buildTask = existingTasks.tasks.find((t: any) => 
                            t.args && Array.isArray(t.args) && t.args.length > 0
                        );
                    }
                    const task = buildTask || existingTasks.tasks[0];
                    
                    // 提取源文件（保持${workspaceFolder}格式，并统一为正斜杠）
                    if (task.args) {
                        existingSources = task.args.filter((arg: string) => 
                            arg.includes('.c') || arg.includes('.cpp') || arg.includes('.cc') || arg.includes('.cxx')
                        ).filter((arg: string) => !arg.startsWith('-')).map(normalizePath);
                        
                        // 提取库文件
                        existingLibs = task.args.filter((arg: string) => 
                            arg.includes('.a') || arg.includes('.o') || arg.includes('.so') || 
                            arg.includes('.lib') || arg.includes('.dll')
                        ).filter((arg: string) => !arg.startsWith('-')).map(normalizePath);
                        
                        // 提取输出文件名
                        const outputIndex = task.args.indexOf('-o');
                        if (outputIndex !== -1 && outputIndex + 1 < task.args.length) {
                            const fullPath = task.args[outputIndex + 1];
                            existingOutputName = path.basename(fullPath).replace('${workspaceFolder}/', '').replace('${workspaceFolder}\\', '');
                            existingOutputPath = path.dirname(fullPath).replace('${workspaceFolder}/', '').replace('${workspaceFolder}\\', '').replace('${workspaceFolder}', '');
                            if (existingOutputPath === '.' || existingOutputPath === './') {
                                existingOutputPath = './build';
                            }
                        }
                    }
                }
            } catch (e) {
                console.log('读取现有tasks.json失败');
            }
        }

        // 读取现有的launch.json（如果存在）
        let existingLaunchConfig: any = {};
        if (fs.existsSync(launchPath)) {
            try {
                const existingLaunch = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
                if (existingLaunch.configurations && existingLaunch.configurations.length > 0) {
                    existingLaunchConfig = existingLaunch.configurations[0];
                }
            } catch (e) {
                console.log('读取现有launch.json失败');
            }
        }

        // 打开Webview面板进行配置
        const panel = vscode.window.createWebviewPanel(
            'cppBuildConfig',
            '配置编译调试文件',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // 生成Webview HTML内容
        panel.webview.html = getWebviewContent(
            existingSources, 
            existingLibs, 
            existingOutputName, 
            existingOutputPath, 
            existingLaunchConfig,
            workspaceFolder.uri.fsPath,
            panel.webview
        );

        // 处理Webview消息
        panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'generate':
                        await generateConfigFiles(message.data, workspaceFolder.uri.fsPath, cppConfig);
                        // 更新当前配置
                        currentCppConfig = cppConfig;
                        currentWorkspacePath = workspaceFolder.uri.fsPath;
                        panel.dispose();
                        break;
                    case 'cancel':
                        panel.dispose();
                        break;
                    case 'browseFile':
                        // 使用自定义文件选择器（支持多选、目录浏览、不限工作区）
                        const selectedPaths = await showCustomFilePicker(
                            workspaceFolder.uri.fsPath,
                            message.filter || {},
                            message.fieldId === 'sourceFiles'
                        );
                        if (selectedPaths && selectedPaths.length > 0) {
                            // 将路径转换为相对于工作区的形式（工作区内用${workspaceFolder}/，工作区外用${workspaceFolder}/../）
                            const processedPaths = selectedPaths.map(p => toWorkspaceRelativePathWithDotDot(p, workspaceFolder.uri.fsPath));
                            panel.webview.postMessage({
                                command: 'fileSelected',
                                fieldId: message.fieldId,
                                paths: processedPaths
                            });
                        }
                        break;
                }
            },
            undefined,
            context.subscriptions
        );
    });

    // 添加手动同步命令
    let syncCmd = vscode.commands.registerCommand('cpp-configurator.syncConfigs', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('请先打开一个工作区文件夹');
            return;
        }
        
        const success = await autoSyncConfigs(workspaceFolder.uri.fsPath);
        if (success) {
            vscode.window.showInformationMessage('✅ 已同步更新 tasks.json 和 launch.json');
        } else {
            vscode.window.showWarningMessage('⚠️ 同步失败，请检查 c_cpp_properties.json 是否存在');
        }
    });

    context.subscriptions.push(editConfigsCmd, setupBuildDebugCmd, syncCmd);
    updateContext();
}

/**
 * 自定义文件选择器（支持多选、目录浏览、不限工作区）
 * @param workspaceRoot 工作区根目录（用于相对路径转换）
 * @param filters 文件扩展名过滤器，例如 { 'C/C++源文件': ['c', 'cpp'] }
 * @param isSourceFile 是否是源文件（仅用于记录，未使用）
 * @returns 选中的绝对路径数组
 */
async function showCustomFilePicker(workspaceRoot: string, filters: any, isSourceFile: boolean): Promise<string[]> {
    return new Promise(async (resolve) => {
        // 创建Webview面板
        const panel = vscode.window.createWebviewPanel(
            'customFilePicker',
            '选择文件（支持多选）',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: false
            }
        );

        // 当前浏览的目录（初始为工作区根目录，但允许跳转到任意目录）
        let currentDir = workspaceRoot;
        // 收集选中的文件路径（绝对路径）
        let selectedFiles: Set<string> = new Set();

        // 获取允许的扩展名列表（用于过滤显示）
        let allowedExtensions: string[] = [];
        for (const extList of Object.values(filters)) {
            if (Array.isArray(extList)) {
                allowedExtensions.push(...extList.map(e => e.toLowerCase()));
            }
        }

        // 刷新文件列表
        async function refreshFileList() {
            try {
                const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
                // 分离目录和文件
                const dirs: { name: string; path: string }[] = [];
                const files: { name: string; path: string; ext: string }[] = [];
                for (const entry of entries) {
                    const fullPath = path.join(currentDir, entry.name);
                    if (entry.isDirectory()) {
                        // 跳过隐藏目录（可选）
                        if (!entry.name.startsWith('.')) {
                            dirs.push({ name: entry.name, path: fullPath });
                        }
                    } else if (entry.isFile()) {
                        const ext = path.extname(entry.name).slice(1).toLowerCase();
                        // 如果有过滤器，则只显示匹配扩展名的文件
                        if (allowedExtensions.length === 0 || allowedExtensions.includes(ext)) {
                            files.push({ name: entry.name, path: fullPath, ext });
                        }
                    }
                }
                // 排序：目录在前，文件在后，各自按名称排序
                dirs.sort((a, b) => a.name.localeCompare(b.name));
                files.sort((a, b) => a.name.localeCompare(b.name));

                // 计算是否所有文件都被选中（用于全选复选框）
                const allSelected = files.length > 0 && files.every(f => selectedFiles.has(f.path));

                // 生成HTML列表（增加全选区域）
                const fileListHtml = `
                    <div class="select-all">
                        <input type="checkbox" id="selectAllCheckbox" ${allSelected ? 'checked' : ''}>
                        <label for="selectAllCheckbox">全选所有文件</label>
                    </div>
                    <div class="dir-section">
                        ${dirs.map(dir => `
                            <div class="file-item dir-item" data-path="${escapeHtml(dir.path)}" data-is-dir="true">
                                <span class="file-icon">📁</span>
                                <span class="file-name">${escapeHtml(dir.name)}</span>
                            </div>
                        `).join('')}
                    </div>
                    <div class="file-section">
                        ${files.map(file => {
                            const isChecked = selectedFiles.has(file.path);
                            return `
                                <div class="file-item" data-path="${escapeHtml(file.path)}" data-is-dir="false">
                                    <input type="checkbox" class="file-checkbox" data-path="${escapeHtml(file.path)}" ${isChecked ? 'checked' : ''}>
                                    <span class="file-icon">📄</span>
                                    <span class="file-name">${escapeHtml(file.name)}</span>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;

                // 更新Webview内容
                panel.webview.html = getFilePickerHtml(
                    currentDir,
                    workspaceRoot,
                    fileListHtml,
                    Array.from(selectedFiles).map(f => toWorkspaceRelativePathWithDotDot(f, workspaceRoot))
                );
            } catch (err) {
                vscode.window.showErrorMessage(`无法读取目录: ${currentDir}`);
                panel.dispose();
                resolve([]);
            }
        }

        // 监听Webview消息
        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'navigate':
                    // 进入子目录
                    if (msg.path) {
                        const newPath = msg.path;
                        try {
                            const stat = await fs.promises.stat(newPath);
                            if (stat.isDirectory()) {
                                currentDir = newPath;
                                await refreshFileList();
                            }
                        } catch (e) {
                            vscode.window.showErrorMessage('无法进入该目录');
                        }
                    }
                    break;
                case 'goUp':
                    // 返回上级目录（不限制，直到根目录）
                    const parent = path.dirname(currentDir);
                    if (parent !== currentDir) {
                        currentDir = parent;
                        await refreshFileList();
                    } else {
                        vscode.window.showWarningMessage('已是根目录');
                    }
                    break;
                case 'setPath':
                    // 手动输入路径（绝对路径或相对路径，相对路径基于工作区）
                    let targetPath = msg.path;
                    // 支持 ${workspaceFolder} 占位符
                    if (targetPath.startsWith('${workspaceFolder}')) {
                        targetPath = targetPath.replace('${workspaceFolder}', workspaceRoot);
                    }
                    // 如果是相对路径，转换为绝对路径
                    if (!path.isAbsolute(targetPath)) {
                        targetPath = path.resolve(currentDir, targetPath);
                    }
                    const normalized = path.normalize(targetPath);
                    try {
                        const stat = await fs.promises.stat(normalized);
                        if (stat.isDirectory()) {
                            currentDir = normalized;
                            await refreshFileList();
                        } else {
                            vscode.window.showErrorMessage('路径不是目录');
                        }
                    } catch (e) {
                        vscode.window.showErrorMessage('路径无效或不存在');
                    }
                    break;
                case 'toggleFile':
                    // 切换文件选中状态
                    const filePath = msg.path;
                    if (selectedFiles.has(filePath)) {
                        selectedFiles.delete(filePath);
                    } else {
                        selectedFiles.add(filePath);
                    }
                    // 刷新列表以更新复选框状态和全选复选框
                    await refreshFileList();
                    break;
                case 'selectAll':
                    // 全选/取消全选
                    const selectAll = msg.selectAll;
                    // 获取当前目录下所有文件路径
                    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
                    const filePaths: string[] = [];
                    for (const entry of entries) {
                        if (entry.isFile()) {
                            const fullPath = path.join(currentDir, entry.name);
                            const ext = path.extname(entry.name).slice(1).toLowerCase();
                            if (allowedExtensions.length === 0 || allowedExtensions.includes(ext)) {
                                filePaths.push(fullPath);
                            }
                        }
                    }
                    if (selectAll) {
                        filePaths.forEach(fp => selectedFiles.add(fp));
                    } else {
                        filePaths.forEach(fp => selectedFiles.delete(fp));
                    }
                    await refreshFileList();
                    break;
                case 'confirm':
                    // 确认选择，返回选中文件的绝对路径数组
                    const selected = Array.from(selectedFiles);
                    panel.dispose();
                    resolve(selected);
                    break;
                case 'cancel':
                    panel.dispose();
                    resolve([]);
                    break;
            }
        });

        // 初始刷新
        await refreshFileList();
    });
}

// 生成文件选择器的HTML（包含全选功能）
function getFilePickerHtml(currentDir: string, workspaceRoot: string, fileListHtml: string, selectedRelativePaths: string[]): string {
    // 显示当前路径（绝对路径，不强制转换为相对）
    const displayPath = normalizePath(currentDir);
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .header {
            margin-bottom: 20px;
        }
        .current-path {
            background: var(--vscode-input-background);
            padding: 8px;
            border-radius: 4px;
            font-family: monospace;
            margin-bottom: 10px;
            word-break: break-all;
        }
        .path-input {
            display: flex;
            gap: 8px;
            margin-bottom: 10px;
        }
        .path-input input {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 6px;
            border-radius: 4px;
        }
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .nav-buttons {
            display: flex;
            gap: 8px;
            margin-bottom: 15px;
        }
        .file-list {
            max-height: 400px;
            overflow-y: auto;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px;
            background: var(--vscode-list-background);
        }
        .select-all {
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .file-item {
            display: flex;
            align-items: center;
            padding: 4px 8px;
            cursor: pointer;
            border-radius: 4px;
        }
        .file-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .dir-item {
            font-weight: bold;
        }
        .file-checkbox {
            margin-right: 8px;
            cursor: pointer;
        }
        .file-icon {
            margin-right: 8px;
            font-size: 1.1em;
        }
        .file-name {
            flex: 1;
        }
        .selected-info {
            margin-top: 15px;
            padding: 8px;
            background: var(--vscode-input-background);
            border-radius: 4px;
            max-height: 100px;
            overflow-y: auto;
        }
        .actions {
            margin-top: 20px;
            display: flex;
            justify-content: flex-end;
            gap: 10px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="current-path">📂 当前目录: ${escapeHtml(displayPath)}</div>
        <div class="path-input">
            <input type="text" id="pathInput" placeholder="输入路径（绝对或相对）" value="${escapeHtml(displayPath)}">
            <button id="goToPathBtn">跳转</button>
        </div>
        <div class="nav-buttons">
            <button id="upBtn">⬆ 上级目录</button>
        </div>
    </div>
    <div class="file-list" id="fileList">
        ${fileListHtml}
    </div>
    <div class="selected-info" id="selectedInfo">
        已选中 ${selectedRelativePaths.length} 个文件:<br>
        ${selectedRelativePaths.map(p => `• ${escapeHtml(p)}`).join('<br>')}
    </div>
    <div class="actions">
        <button id="cancelBtn">取消</button>
        <button id="confirmBtn" style="background: var(--vscode-button-background);">确认选择</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        
        // 目录项点击（进入子目录）
        document.querySelectorAll('.dir-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT') return;
                const path = el.getAttribute('data-path');
                vscode.postMessage({ command: 'navigate', path: path });
            });
        });
        
        // 文件复选框点击
        document.querySelectorAll('.file-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                const path = cb.getAttribute('data-path');
                vscode.postMessage({ command: 'toggleFile', path: path });
            });
        });
        
        // 全选复选框
        const selectAllCheckbox = document.getElementById('selectAllCheckbox');
        if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener('change', (e) => {
                const isChecked = e.target.checked;
                vscode.postMessage({ command: 'selectAll', selectAll: isChecked });
            });
        }
        
        // 上级目录按钮
        document.getElementById('upBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'goUp' });
        });
        
        // 跳转按钮
        document.getElementById('goToPathBtn').addEventListener('click', () => {
            const input = document.getElementById('pathInput').value;
            vscode.postMessage({ command: 'setPath', path: input });
        });
        
        // 取消
        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });
        
        // 确认
        document.getElementById('confirmBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'confirm' });
        });
    </script>
</body>
</html>`;
}

// 简单的HTML转义
function escapeHtml(str: string): string {
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    }).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(c) {
        return c;
    });
}

// 设置文件监听器
function setupFileWatcher(context: vscode.ExtensionContext) {
    // 清理旧的监听器
    if (cppPropertiesWatcher) {
        cppPropertiesWatcher.dispose();
        cppPropertiesWatcher = undefined;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }

    const cppPropertiesPattern = new vscode.RelativePattern(
        workspaceFolder,
        '.vscode/c_cpp_properties.json'
    );

    // 创建文件监听器
    cppPropertiesWatcher = vscode.workspace.createFileSystemWatcher(cppPropertiesPattern);

    // 监听文件创建
    cppPropertiesWatcher.onDidCreate((uri) => {
        console.log('c_cpp_properties.json 已创建');
        handleCppPropertiesChange(uri.fsPath);
    });

    // 监听文件变化（保存时触发）
    cppPropertiesWatcher.onDidChange((uri) => {
        console.log('c_cpp_properties.json 已更改');
        handleCppPropertiesChange(uri.fsPath);
    });

    // 监听文件删除
    cppPropertiesWatcher.onDidDelete(() => {
        console.log('c_cpp_properties.json 已删除');
        currentCppConfig = {};
        currentWorkspacePath = '';
    });

    context.subscriptions.push(cppPropertiesWatcher);

    // 立即读取当前配置
    const cppPropertiesPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'c_cpp_properties.json');
    if (fs.existsSync(cppPropertiesPath)) {
        try {
            const content = fs.readFileSync(cppPropertiesPath, 'utf8');
            currentCppConfig = JSON.parse(content);
            currentWorkspacePath = workspaceFolder.uri.fsPath;
        } catch (e) {
            console.log('初始读取 c_cpp_properties.json 失败');
        }
    }
}

// 处理 c_cpp_properties.json 变化
async function handleCppPropertiesChange(filePath: string) {
    // 防抖处理，避免频繁保存导致多次触发
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const newConfig = JSON.parse(content);

        // 检查配置是否真的发生了变化
        if (JSON.stringify(newConfig) === JSON.stringify(currentCppConfig)) {
            return; // 配置未变化，跳过
        }

        currentCppConfig = newConfig;
        const workspacePath = path.dirname(path.dirname(filePath));
        currentWorkspacePath = workspacePath;

        // 检查是否存在 tasks.json，如果存在则自动同步
        const tasksPath = path.join(workspacePath, '.vscode', 'tasks.json');
        if (!fs.existsSync(tasksPath)) {
            console.log('tasks.json 不存在，跳过自动同步');
            return;
        }

        // 读取现有的 tasks.json 和 launch.json 配置
        const existingTasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
        const launchPath = path.join(workspacePath, '.vscode', 'launch.json');
        const existingLaunch = fs.existsSync(launchPath) 
            ? JSON.parse(fs.readFileSync(launchPath, 'utf8')) 
            : { configurations: [{}] };

        // 从现有配置中提取数据（传入tasks数组）
        const data = extractDataFromExistingConfigs(existingTasks.tasks || [], existingLaunch.configurations?.[0] || {});

        // 重新生成配置
        await generateConfigFiles(data, workspacePath, newConfig);

        // 显示通知
        vscode.window.showInformationMessage('🔄 c_cpp_properties.json 已更新，已自动同步 tasks.json 和 launch.json');

    } catch (error) {
        console.error('处理 c_cpp_properties.json 变化失败:', error);
        vscode.window.showErrorMessage(`同步配置失败: ${error}`);
    }
}

// 从现有配置中提取数据（改进版，支持查找默认构建任务）
function extractDataFromExistingConfigs(tasks: any[], launchConfig: any): any {
    // 找到默认构建任务
    let buildTask = null;
    for (const task of tasks) {
        if (task.group && task.group.isDefault === true && task.group.kind === 'build') {
            buildTask = task;
            break;
        }
    }
    if (!buildTask) {
        // 如果没有找到默认构建任务，尝试找第一个有args的任务
        buildTask = tasks.find(t => t.args && Array.isArray(t.args) && t.args.length > 0);
    }
    const task = buildTask || { args: [] };
    
    const data: any = {
        sourceFiles: [],
        libraryFiles: [],
        outputName: 'main',
        outputPath: './build',
        args: [],
        miDebuggerPath: launchConfig.miDebuggerPath || '',
        miMode: launchConfig.MIMode || 'gdb',
        cwd: launchConfig.cwd || '${workspaceFolder}',
        environment: launchConfig.environment || [],
        externalConsole: launchConfig.externalConsole || false,
        stopAtEntry: launchConfig.stopAtEntry || false,
        generateCleanTask: false
    };

    // 从 task.args 提取源文件、库文件和输出路径
    if (task.args && Array.isArray(task.args)) {
        // 提取源文件
        data.sourceFiles = task.args.filter((arg: string) => 
            !arg.startsWith('-') && 
            (arg.includes('.c') || arg.includes('.cpp') || arg.includes('.cc') || arg.includes('.cxx'))
        ).map(normalizePath);

        // 提取库文件
        data.libraryFiles = task.args.filter((arg: string) => 
            !arg.startsWith('-') && 
            (arg.includes('.a') || arg.includes('.o') || arg.includes('.so') || 
             arg.includes('.lib') || arg.includes('.dll'))
        ).map(normalizePath);

        // 提取输出路径
        const outputIndex = task.args.indexOf('-o');
        if (outputIndex !== -1 && outputIndex + 1 < task.args.length) {
            const outputPath = task.args[outputIndex + 1];
            const cleanPath = outputPath.replace('${workspaceFolder}/', '').replace('${workspaceFolder}\\', '');
            data.outputName = path.basename(cleanPath);
            data.outputPath = path.dirname(cleanPath) || './build';
        }
    }

    // 从 launchConfig 提取参数
    if (launchConfig.args && Array.isArray(launchConfig.args)) {
        data.args = launchConfig.args;
    }

    return data;
}

// 手动同步配置
async function autoSyncConfigs(workspacePath: string): Promise<boolean> {
    const cppPropertiesPath = path.join(workspacePath, '.vscode', 'c_cpp_properties.json');
    const tasksPath = path.join(workspacePath, '.vscode', 'tasks.json');

    if (!fs.existsSync(cppPropertiesPath) || !fs.existsSync(tasksPath)) {
        return false;
    }

    try {
        const cppContent = fs.readFileSync(cppPropertiesPath, 'utf8');
        const newConfig = JSON.parse(cppContent);
        currentCppConfig = newConfig;

        const existingTasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
        const launchPath = path.join(workspacePath, '.vscode', 'launch.json');
        const existingLaunch = fs.existsSync(launchPath) 
            ? JSON.parse(fs.readFileSync(launchPath, 'utf8')) 
            : { configurations: [{}] };

        const data = extractDataFromExistingConfigs(
            existingTasks.tasks || [], 
            existingLaunch.configurations?.[0] || {}
        );

        await generateConfigFiles(data, workspacePath, newConfig);
        return true;
    } catch (e) {
        console.error('手动同步失败:', e);
        return false;
    }
}

function updateContext() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        const cppPropertiesPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'c_cpp_properties.json');
        const exists = fs.existsSync(cppPropertiesPath);
        vscode.commands.executeCommand('setContext', 'cppConfig.hasCppProperties', exists);
    }
}

function getWebviewContent(
    existingSources: string[], 
    existingLibs: string[], 
    existingOutputName: string,
    existingOutputPath: string,
    existingLaunchConfig: any,
    workspacePath: string,
    webview: vscode.Webview
): string {
    
    const sourceFilesHtml = existingSources.map((f: string) => `
        <div class="file-item" data-path="${f}">
            <span class="file-path">${f}</span>
            <button onclick="removeFile(this)" title="删除">×</button>
        </div>
    `).join('');

    const libFilesHtml = existingLibs.map((f: string) => `
        <div class="file-item" data-path="${f}">
            <span class="file-path">${f}</span>
            <button onclick="removeFile(this)" title="删除">×</button>
        </div>
    `).join('');

    // 从launch.json提取调试配置
    const existingArgs = (existingLaunchConfig.args || []).join(' ');
    const existingMiDebuggerPath = existingLaunchConfig.miDebuggerPath || '';
    const existingMiMode = existingLaunchConfig.MIMode || 'gdb';
    const existingCwd = existingLaunchConfig.cwd || '${workspaceFolder}';
    const existingStopAtEntry = existingLaunchConfig.stopAtEntry || false;
    const existingExternalConsole = existingLaunchConfig.externalConsole || false;
    
    // 处理environment为文本格式
    let existingEnvironment = '';
    if (existingLaunchConfig.environment && Array.isArray(existingLaunchConfig.environment)) {
        existingEnvironment = existingLaunchConfig.environment
            .map((env: any) => `${env.name}=${env.value}`)
            .join('\n');
    }

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>配置编译调试文件</title>
    <style>
        * {
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            padding: 20px;
            max-width: 700px;
            margin: 0 auto;
            line-height: 1.5;
        }
        h2 {
            color: var(--vscode-titleBar-activeForeground);
            border-bottom: 2px solid var(--vscode-panel-border);
            padding-bottom: 10px;
            margin-bottom: 20px;
        }
        .section {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 15px;
            margin-bottom: 15px;
        }
        .section-title {
            font-weight: bold;
            margin-bottom: 12px;
            color: var(--vscode-textLink-foreground);
            font-size: 1.1em;
        }
        .form-group {
            margin-bottom: 15px;
        }
        .form-group:last-child {
            margin-bottom: 0;
        }
        label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
        }
        input[type="text"], select, textarea {
            width: 100%;
            padding: 8px 10px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-font-size);
        }
        input[type="text"]:focus, select:focus, textarea:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        textarea {
            min-height: 60px;
            resize: vertical;
        }
        .hint {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        .file-list {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px;
            min-height: 50px;
            background: var(--vscode-input-background);
            max-height: 150px;
            overflow-y: auto;
        }
        .file-list:empty::before {
            content: '暂无文件，请点击下方按钮添加';
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            display: block;
            text-align: center;
            padding: 15px;
        }
        .file-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 8px;
            margin: 3px 0;
            background: var(--vscode-list-hoverBackground);
            border-radius: 4px;
            min-height: 28px;
        }
        .file-path {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.95em;
            margin-right: 8px;
            line-height: 1.4;
        }
        .file-item button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            width: 22px;
            height: 22px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 14px;
            line-height: 1;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
        }
        .file-item button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .btn-add {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 14px;
            border-radius: 4px;
            cursor: pointer;
            margin-top: 8px;
            font-size: var(--vscode-font-size);
        }
        .btn-add:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .grid-2 {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
        }
        .actions {
            position: sticky;
            bottom: 0;
            background: var(--vscode-editor-background);
            padding: 15px 0;
            border-top: 2px solid var(--vscode-panel-border);
            margin-top: 20px;
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 24px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            font-size: var(--vscode-font-size);
        }
        .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 10px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-size: var(--vscode-font-size);
        }
        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        input[type="checkbox"] {
            width: 16px;
            height: 16px;
            cursor: pointer;
        }
    </style>
</head>
<body>
    <h2>🛠️ 配置编译调试文件</h2>
    
    <!-- 源文件配置 -->
    <div class="section">
        <div class="section-title">📄 源文件</div>
        <div class="hint" style="margin-bottom: 8px;">选择需要编译的C/C++源文件</div>
        <div id="sourceFiles" class="file-list">
            ${sourceFilesHtml}
        </div>
        <button class="btn-add" onclick="addSourceFiles()">+ 添加源文件 (.c .cpp .cc)</button>
    </div>

    <!-- 链接库配置 -->
    <div class="section">
        <div class="section-title">🔗 链接库文件</div>
        <div class="hint" style="margin-bottom: 8px;">选择需要链接的库文件（静态库.a、动态库.so、目标文件.o等）</div>
        <div id="libraryFiles" class="file-list">
            ${libFilesHtml}
        </div>
        <button class="btn-add" onclick="addLibraryFiles()">+ 添加库文件 (.a .o .so .lib)</button>
    </div>

    <!-- 输出配置 -->
    <div class="section">
        <div class="section-title">📤 输出设置</div>
        <div class="grid-2">
            <div class="form-group">
                <label>可执行文件名称</label>
                <input type="text" id="outputName" value="${existingOutputName}" placeholder="main">
            </div>
            <div class="form-group">
                <label>输出目录</label>
                <input type="text" id="outputPath" value="${existingOutputPath}" placeholder="./build">
            </div>
        </div>
    </div>

    <!-- 调试配置 -->
    <div class="section">
        <div class="section-title">🐛 调试设置</div>
        
        <div class="form-group">
            <label>程序启动参数</label>
            <input type="text" id="args" value="${existingArgs}" placeholder="arg1 arg2 arg3">
            <div class="hint">传递给main函数的命令行参数，空格分隔</div>
        </div>
        
        <div class="form-group">
            <label>调试器路径 (miDebuggerPath)</label>
            <input type="text" id="miDebuggerPath" value="${existingMiDebuggerPath}" placeholder="/usr/bin/gdb">
            <div class="hint">GDB或LLDB调试器的完整路径，如 /usr/bin/gdb 或 gdb</div>
        </div>
        
        <div class="grid-2">
            <div class="form-group">
                <label>调试模式 (MIMode)</label>
                <select id="miMode">
                    <option value="gdb" ${existingMiMode === 'gdb' ? 'selected' : ''}>GDB</option>
                    <option value="lldb" ${existingMiMode === 'lldb' ? 'selected' : ''}>LLDB</option>
                </select>
            </div>
            <div class="form-group">
                <label>工作目录 (cwd)</label>
                <input type="text" id="cwd" value="${existingCwd}" placeholder="\${workspaceFolder}">
            </div>
        </div>
        
        <div class="form-group">
            <label>环境变量 (environment)</label>
            <textarea id="environment" placeholder="NAME=VALUE&#10;PATH=/custom/path&#10;DEBUG=1">${existingEnvironment}</textarea>
            <div class="hint">每行一个，格式：NAME=VALUE</div>
        </div>
        
        <div class="checkbox-group" style="margin-top: 10px;">
            <input type="checkbox" id="externalConsole" ${existingExternalConsole ? 'checked' : ''}>
            <label for="externalConsole" style="margin: 0; cursor: pointer;">使用外部控制台 (externalConsole)</label>
        </div>
        
        <div class="checkbox-group" style="margin-top: 10px;">
            <input type="checkbox" id="stopAtEntry" ${existingStopAtEntry ? 'checked' : ''}>
            <label for="stopAtEntry" style="margin: 0; cursor: pointer;">启动时停止在main函数入口 (stopAtEntry)</label>
        </div>
    </div>

    <div class="actions">
        <button class="btn-secondary" onclick="cancel()">取消</button>
        <button class="btn-primary" onclick="generate()">✅ 生成配置</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function addSourceFiles() {
            vscode.postMessage({
                command: 'browseFile',
                fieldId: 'sourceFiles',
                filter: {
                    'C/C++源文件': ['c', 'cpp', 'cc', 'cxx']
                }
            });
        }
        
        function addLibraryFiles() {
            vscode.postMessage({
                command: 'browseFile',
                fieldId: 'libraryFiles',
                filter: {
                    '库文件': ['a', 'o', 'so', 'lib', 'dll', 'dylib']
                }
            });
        }
        
        function removeFile(btn) {
            btn.parentElement.remove();
        }
        
        function addFilesToList(fieldId, paths) {
            const container = document.getElementById(fieldId);
            paths.forEach(p => {
                const div = document.createElement('div');
                div.className = 'file-item';
                div.setAttribute('data-path', p);
                div.innerHTML = '<span class="file-path">' + p + '</span><button onclick="removeFile(this)" title="删除">×</button>';
                container.appendChild(div);
            });
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'fileSelected') {
                addFilesToList(message.fieldId, message.paths);
            }
        });
        
        function getFileList(fieldId) {
            const items = document.querySelectorAll('#' + fieldId + ' .file-item');
            return Array.from(items).map(item => item.getAttribute('data-path'));
        }
        
        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }
        
        function generate() {
            const data = {
                sourceFiles: getFileList('sourceFiles'),
                libraryFiles: getFileList('libraryFiles'),
                outputName: document.getElementById('outputName').value || 'main',
                outputPath: document.getElementById('outputPath').value || './build',
                args: document.getElementById('args').value.split(' ').filter(s => s.trim()),
                miDebuggerPath: document.getElementById('miDebuggerPath').value,
                miMode: document.getElementById('miMode').value,
                cwd: document.getElementById('cwd').value || '\${workspaceFolder}',
                environment: document.getElementById('environment').value.split('\\n').filter(s => s.trim()).map(line => {
                    const eq = line.indexOf('=');
                    if (eq > 0) {
                        return { name: line.substring(0, eq), value: line.substring(eq + 1) };
                    }
                    return { name: line, value: '' };
                }),
                externalConsole: document.getElementById('externalConsole').checked,
                stopAtEntry: document.getElementById('stopAtEntry').checked
            };
            
            // 去掉源文件必须至少一个的限制
            // if (data.sourceFiles.length === 0) {
            //     alert('请至少添加一个源文件！');
            //     return;
            // }
            
            vscode.postMessage({
                command: 'generate',
                data: data
            });
        }
    </script>
</body>
</html>`;
}

// 将路径转换为使用正斜杠
function normalizePath(inputPath: string): string {
    return inputPath.replace(/\\/g, '/');
}

// 将绝对路径转换为相对于工作区的路径（工作区内用 ${workspaceFolder}/，工作区外用 ${workspaceFolder}/../）
function toWorkspaceRelativePathWithDotDot(fullPath: string, workspacePath: string): string {
    const normalizedFull = normalizePath(fullPath);
    const normalizedWorkspace = normalizePath(workspacePath);
    
    // 计算相对路径（使用 path.relative 处理跨平台）
    let relative = path.relative(normalizedWorkspace, normalizedFull);
    relative = normalizePath(relative);
    
    // 如果相对路径为空或只有 '.'，表示文件就在工作区根目录
    if (!relative || relative === '.') {
        return '${workspaceFolder}/';
    }
    
    // 如果相对路径不以 '..' 开头，说明在工作区内
    if (!relative.startsWith('..')) {
        return '${workspaceFolder}/' + relative;
    } else {
        // 工作区外，使用 ${workspaceFolder}/../ + 相对路径
        return '${workspaceFolder}/' + relative;
    }
}

// 递归获取目录下的所有子目录（相对于给定路径）
function getAllSubdirectories(basePath: string): string[] {
    const result: string[] = [];
    const normalizedBase = normalizePath(basePath);
    
    function traverse(currentPath: string, relativePrefix: string) {
        try {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
                    result.push(relativePath);
                    traverse(path.join(currentPath, entry.name), relativePath);
                }
            }
        } catch (e) {
            // 忽略无权限访问的目录
        }
    }
    
    traverse(normalizedBase, '');
    return result;
}

// 处理includePath，将/**递归展开为实际子目录
function expandIncludePath(includePath: string[], workspacePath: string): string[] {
    const result: string[] = [];
    
    for (const inc of includePath) {
        if (!inc || typeof inc !== 'string') continue;
        
        if (inc.includes('/**')) {
            const basePathWithVar = inc.replace('/**', '');
            const basePath = basePathWithVar.replace('${workspaceFolder}', workspacePath);
            const normalizedBase = normalizePath(basePath);
            
            if (inc.includes('${workspaceFolder}')) {
                result.push(basePathWithVar);
            } else if (path.isAbsolute(basePathWithVar)) {
                result.push(toWorkspaceRelativePathWithDotDot(basePathWithVar, workspacePath));
            } else {
                result.push('${workspaceFolder}/' + normalizePath(basePathWithVar));
            }
            
            if (fs.existsSync(normalizedBase) && fs.statSync(normalizedBase).isDirectory()) {
                const subDirs = getAllSubdirectories(normalizedBase);
                for (const subDir of subDirs) {
                    result.push('${workspaceFolder}/' + subDir);
                }
            }
        } else if (inc.includes('${workspaceFolder}') || inc.includes('${default}')) {
            result.push(normalizePath(inc));
        } else if (path.isAbsolute(inc)) {
            result.push(toWorkspaceRelativePathWithDotDot(inc, workspacePath));
        } else {
            result.push('${workspaceFolder}/' + normalizePath(inc));
        }
    }
    
    return [...new Set(result)];
}

async function generateConfigFiles(data: any, workspacePath: string, cppConfig: any) {
    const vscodePath = path.join(workspacePath, '.vscode');
    
    if (!fs.existsSync(vscodePath)) {
        fs.mkdirSync(vscodePath, { recursive: true });
    }

    try {
        const config = cppConfig.configurations?.[0] || {};
        const compilerPath = config.compilerPath || '';
        const includePath = config.includePath || [];
        const defines = config.defines || [];
        const compilerArgs = config.compilerArgs || [];
        const cStandard = config.cStandard || '';
        const cppStandard = config.cppStandard || '';

        // 确定编译器路径和类型
        let compiler = compilerPath ? normalizePath(compilerPath) : '';
        let isCppCompiler = false;
        
        if (!compiler) {
            // 根据源文件类型推断
            const hasCpp = data.sourceFiles.some((f: string) => 
                f.includes('.cpp') || f.includes('.cc') || f.includes('.cxx')
            );
            isCppCompiler = hasCpp;
            compiler = hasCpp ? 'g++' : 'gcc';
        } else {
            // 根据编译器路径判断是gcc还是g++
            const compilerName = path.basename(compilerPath).toLowerCase();
            isCppCompiler = compilerName.includes('g++') || 
                           compilerName.includes('clang++') ||
                           compilerName.includes('c++');
        }

        // 确定 -std 参数
        let stdFlag = '';
        if (isCppCompiler) {
            if (cppStandard) {
                const cppStd = cppStandard.toLowerCase().replace(/c\+\+/g, 'c++').replace(/gnu\+\+/g, 'gnu++');
                if (cppStd.startsWith('c++') || cppStd.startsWith('gnu++')) {
                    stdFlag = `-std=${cppStd}`;
                }
            }
        } else {
            if (cStandard) {
                const cStd = cStandard.toLowerCase().replace(/gnu/g, 'gnu');
                if (cStd.startsWith('c') || cStd.startsWith('gnu')) {
                    stdFlag = `-std=${cStd}`;
                }
            }
        }

        const compilerDir = compilerPath ? normalizePath(path.dirname(compilerPath)) : '';
        const expandedIncludes = expandIncludePath(includePath, workspacePath);

        // 构建编译任务参数
        const args: string[] = [];
        
        if (stdFlag) {
            args.push(stdFlag);
        }
        
        args.push(...data.sourceFiles);
        
        expandedIncludes.forEach((inc: string) => {
            args.push('-I', inc);
        });
        
        defines.forEach((def: string) => {
            if (def && typeof def === 'string') {
                args.push('-D', def);
            }
        });

        compilerArgs.forEach((arg: string) => {
            if (arg && typeof arg === 'string') {
                args.push(arg);
            }
        });
        
        args.push(...data.libraryFiles);
        
        const outputPathWithPrefix = '${workspaceFolder}/' + normalizePath(path.join(data.outputPath, data.outputName));
        args.push('-o', outputPathWithPrefix);

        // 检测平台
        const platform = getPlatform();
        const isWin = platform === 'win32';

        // 生成tasks.json，包含创建目录的预任务
        const tasks: any[] = [
            {
                label: "创建输出目录",
                type: "shell",
                command: isWin ? "powershell" : "mkdir",
                args: isWin 
                    ? ['-Command', 'New-Item', '-ItemType', 'Directory', '-Force', '-Path', '${workspaceFolder}/' + normalizePath(data.outputPath)]
                    : ['-p', '${workspaceFolder}/' + normalizePath(data.outputPath)],
                options: {
                    cwd: "${workspaceFolder}"
                },
                group: "build",
                problemMatcher: [],
                detail: "自动创建编译输出目录"
            },
            {
                label: `构建 ${data.outputName}`,
                type: "shell",
                command: compiler,
                args: args,
                options: {
                    cwd: compilerDir || "${workspaceFolder}"
                },
                group: {
                    kind: "build",
                    isDefault: true
                },
                dependsOn: "创建输出目录",
                problemMatcher: ["$gcc"],
                detail: "编译并链接生成可执行文件"
            }
        ];

        const tasksJson = { version: "2.0.0", tasks: tasks };

        fs.writeFileSync(
            path.join(vscodePath, 'tasks.json'),
            JSON.stringify(tasksJson, null, 4),
            'utf8'
        );

        // 推断默认的调试器路径（WSL下优先使用系统gdb）
        let defaultDebuggerPath = '';
        if (data.miDebuggerPath && data.miDebuggerPath.trim()) {
            defaultDebuggerPath = normalizePath(data.miDebuggerPath.trim());
        } else if (compilerPath) {
            const compilerDir = path.dirname(compilerPath);
            const compilerName = path.basename(compilerPath).toLowerCase();
            
            if (compilerName.includes('gcc') || compilerName.includes('g++')) {
                if (isWSL() || platform !== 'win32') {
                    defaultDebuggerPath = '/usr/bin/gdb';
                } else {
                    defaultDebuggerPath = normalizePath(path.join(compilerDir, 'gdb.exe'));
                }
            } else if (compilerName.includes('clang')) {
                if (isWSL() || platform !== 'win32') {
                    defaultDebuggerPath = '/usr/bin/lldb';
                } else {
                    defaultDebuggerPath = normalizePath(path.join(compilerDir, 'lldb-mi.exe'));
                }
            } else {
                defaultDebuggerPath = isWSL() || platform !== 'win32' ? 'gdb' : 'gdb.exe';
            }
        } else {
            defaultDebuggerPath = isWSL() || platform !== 'win32' ? 'gdb' : 'gdb.exe';
        }

        const launchConfig: any = {
            name: `调试 ${data.outputName}`,
            type: "cppdbg",
            request: "launch",
            program: "${workspaceFolder}/" + normalizePath(path.join(data.outputPath, data.outputName)),
            args: data.args || [],
            stopAtEntry: data.stopAtEntry || false,
            cwd: data.cwd || "${workspaceFolder}",
            environment: data.environment || [],
            externalConsole: data.externalConsole || false,
            MIMode: data.miMode || "gdb",
            miDebuggerPath: defaultDebuggerPath,
            preLaunchTask: `构建 ${data.outputName}`,
            setupCommands: [
                {
                    description: "为gdb启用整齐打印",
                    text: "-enable-pretty-printing",
                    ignoreFailures: true
                }
            ]
        };

        const launchJson = {
            version: "0.2.0",
            configurations: [launchConfig]
        };

        fs.writeFileSync(
            path.join(vscodePath, 'launch.json'),
            JSON.stringify(launchJson, null, 4),
            'utf8'
        );

        vscode.window.showInformationMessage(
            `✅ 配置生成成功！包含路径: ${expandedIncludes.length}个${stdFlag ? '，标准: ' + stdFlag : ''}，自动创建输出目录`
        );

        const openNow = await vscode.window.showInformationMessage(
            '是否立即查看生成的配置文件？',
            '打开tasks.json', '打开launch.json', '稍后'
        );
        
        if (openNow === '打开tasks.json') {
            const doc = await vscode.workspace.openTextDocument(path.join(vscodePath, 'tasks.json'));
            await vscode.window.showTextDocument(doc);
        } else if (openNow === '打开launch.json') {
            const doc = await vscode.workspace.openTextDocument(path.join(vscodePath, 'launch.json'));
            await vscode.window.showTextDocument(doc);
        }

    } catch (error) {
        vscode.window.showErrorMessage(`生成配置文件失败: ${error}`);
    }
}

export function deactivate() {
    // 清理文件监听器
    if (cppPropertiesWatcher) {
        cppPropertiesWatcher.dispose();
    }
}