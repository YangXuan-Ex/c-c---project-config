"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
let cppPropertiesWatcher;
let currentCppConfig = {};
let currentWorkspacePath = '';
let lastSourceDir;
let lastLibDir;
function isWSL() {
    const release = process.platform === 'linux' ? require('os').release().toLowerCase() : '';
    return release.includes('microsoft') || release.includes('wsl');
}
function getPlatform() {
    return process.platform;
}
// 根据 c_cpp_properties.json 配置推断默认调试器路径
function getDefaultDebuggerPathFromConfig(cppConfig, platform, wsl) {
    const config = cppConfig.configurations?.[0] || {};
    const compilerPath = config.compilerPath || '';
    if (compilerPath) {
        const compilerDir = path.dirname(compilerPath);
        const compilerName = path.basename(compilerPath).toLowerCase();
        if (compilerName.includes('gcc') || compilerName.includes('g++')) {
            if (wsl || platform !== 'win32') {
                return '/usr/bin/gdb';
            }
            else {
                return normalizePath(path.join(compilerDir, 'gdb.exe'));
            }
        }
        else if (compilerName.includes('clang')) {
            if (wsl || platform !== 'win32') {
                return '/usr/bin/lldb';
            }
            else {
                return normalizePath(path.join(compilerDir, 'lldb-mi.exe'));
            }
        }
        else {
            return (wsl || platform !== 'win32') ? 'gdb' : 'gdb.exe';
        }
    }
    else {
        // 没有编译器路径，返回系统默认
        return (wsl || platform !== 'win32') ? 'gdb' : 'gdb.exe';
    }
}
function activate(context) {
    console.log('C/C++工程配置助手已激活');
    console.log(`运行平台: ${getPlatform()}, WSL: ${isWSL()}`);
    setupFileWatcher(context);
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        setupFileWatcher(context);
    }));
    let editConfigsCmd = vscode.commands.registerCommand('cpp-configurator.editConfigs', async () => {
        try {
            await vscode.commands.executeCommand('C_Cpp.ConfigurationEditUI');
            vscode.window.showInformationMessage('已尝试打开 C/C++ 配置界面。如果未显示，请稍后重试（可能正在进行 IntelliSense 扫描）。');
        }
        catch (error) {
            const install = await vscode.window.showErrorMessage('未检测到 Microsoft C/C++ 扩展，是否前往安装？', '安装', '取消');
            if (install === '安装') {
                vscode.commands.executeCommand('workbench.extensions.search', 'ms-vscode.cpptools');
            }
        }
    });
    let setupBuildDebugCmd = vscode.commands.registerCommand('cpp-configurator.setupBuildDebug', async (uri) => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('请先打开一个工作区文件夹');
            return;
        }
        const vscodePath = path.join(workspaceFolder.uri.fsPath, '.vscode');
        const cppPropertiesPath = path.join(vscodePath, 'c_cpp_properties.json');
        const tasksPath = path.join(vscodePath, 'tasks.json');
        const launchPath = path.join(vscodePath, 'launch.json');
        if (!fs.existsSync(cppPropertiesPath)) {
            vscode.window.showErrorMessage('未找到c_cpp_properties.json，请先使用"配置C/C++工程"生成该文件');
            return;
        }
        let cppConfig = {};
        try {
            const content = fs.readFileSync(cppPropertiesPath, 'utf8');
            cppConfig = JSON.parse(content);
            currentCppConfig = cppConfig;
            currentWorkspacePath = workspaceFolder.uri.fsPath;
        }
        catch (error) {
            vscode.window.showErrorMessage('读取c_cpp_properties.json失败，请检查文件格式');
            return;
        }
        let existingSources = [];
        let existingLibs = [];
        let existingOutputName = 'main';
        let existingOutputPath = './build';
        if (fs.existsSync(tasksPath)) {
            try {
                const existingTasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
                if (existingTasks.tasks && existingTasks.tasks.length > 0) {
                    let buildTask = existingTasks.tasks.find((t) => t.group && t.group.isDefault === true && t.group.kind === 'build');
                    if (!buildTask) {
                        buildTask = existingTasks.tasks.find((t) => t.args && Array.isArray(t.args) && t.args.length > 0);
                    }
                    const task = buildTask || existingTasks.tasks[0];
                    if (task.args) {
                        existingSources = task.args.filter((arg) => arg.includes('.c') || arg.includes('.cpp') || arg.includes('.cc') || arg.includes('.cxx')).filter((arg) => !arg.startsWith('-')).map(normalizePath);
                        existingLibs = task.args.filter((arg) => arg.includes('.a') || arg.includes('.o') || arg.includes('.so') ||
                            arg.includes('.lib') || arg.includes('.dll')).filter((arg) => !arg.startsWith('-')).map(normalizePath);
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
            }
            catch (e) {
                console.log('读取现有tasks.json失败');
            }
        }
        let existingLaunchConfig = {};
        if (fs.existsSync(launchPath)) {
            try {
                const existingLaunch = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
                if (existingLaunch.configurations && existingLaunch.configurations.length > 0) {
                    existingLaunchConfig = existingLaunch.configurations[0];
                }
            }
            catch (e) {
                console.log('读取现有launch.json失败');
            }
        }
        // 如果 miDebuggerPath 为空，则根据 cppConfig 推断一个合理的默认值
        if (!existingLaunchConfig.miDebuggerPath) {
            existingLaunchConfig.miDebuggerPath = getDefaultDebuggerPathFromConfig(cppConfig, getPlatform(), isWSL());
        }
        const panel = vscode.window.createWebviewPanel('cppBuildConfig', '配置编译调试文件', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
        panel.webview.html = getWebviewContent(existingSources, existingLibs, existingOutputName, existingOutputPath, existingLaunchConfig, workspaceFolder.uri.fsPath, panel.webview);
        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'generate':
                    await generateConfigFiles(message.data, workspaceFolder.uri.fsPath, cppConfig);
                    currentCppConfig = cppConfig;
                    currentWorkspacePath = workspaceFolder.uri.fsPath;
                    panel.dispose();
                    break;
                case 'cancel':
                    panel.dispose();
                    break;
                case 'browseFile':
                    const currentRelativePaths = message.currentFiles || [];
                    const initialAbsPaths = currentRelativePaths.map(p => toAbsolutePath(p, workspaceFolder.uri.fsPath));
                    const selectedPaths = await showCustomFilePicker(workspaceFolder.uri.fsPath, message.filter || {}, message.fieldId === 'sourceFiles', initialAbsPaths);
                    if (selectedPaths && selectedPaths.length > 0) {
                        const processedPaths = selectedPaths.map(p => toWorkspaceRelativePathWithDotDot(p, workspaceFolder.uri.fsPath));
                        panel.webview.postMessage({
                            command: 'fileSelected',
                            fieldId: message.fieldId,
                            paths: processedPaths
                        });
                    }
                    break;
            }
        }, undefined, context.subscriptions);
    });
    let syncCmd = vscode.commands.registerCommand('cpp-configurator.syncConfigs', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('请先打开一个工作区文件夹');
            return;
        }
        const success = await autoSyncConfigs(workspaceFolder.uri.fsPath);
        if (success) {
            vscode.window.showInformationMessage('✅ 已同步更新 tasks.json 和 launch.json');
        }
        else {
            vscode.window.showWarningMessage('⚠️ 同步失败，请检查 c_cpp_properties.json 是否存在');
        }
    });
    context.subscriptions.push(editConfigsCmd, setupBuildDebugCmd, syncCmd);
    updateContext();
}
function toAbsolutePath(relativePath, workspacePath) {
    let normalized = normalizePath(relativePath);
    if (normalized.startsWith('${workspaceFolder}')) {
        normalized = normalized.replace('${workspaceFolder}', workspacePath);
    }
    let absPath;
    if (path.isAbsolute(normalized)) {
        absPath = normalized;
    }
    else {
        absPath = path.resolve(workspacePath, normalized);
    }
    return normalizePath(absPath);
}
async function showCustomFilePicker(workspaceRoot, filters, isSourceFile, initialSelected = []) {
    return new Promise(async (resolve) => {
        const panel = vscode.window.createWebviewPanel('customFilePicker', '选择文件（支持多选）', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: false });
        let currentDir = workspaceRoot;
        let selectedFiles = new Set(initialSelected.map(p => normalizePath(p)));
        let allowedExtensions = [];
        for (const extList of Object.values(filters)) {
            if (Array.isArray(extList)) {
                allowedExtensions.push(...extList.map(e => e.toLowerCase()));
            }
        }
        async function refreshFileList() {
            try {
                const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
                const dirs = [];
                const files = [];
                for (const entry of entries) {
                    const fullPath = normalizePath(path.join(currentDir, entry.name));
                    if (entry.isDirectory()) {
                        if (!entry.name.startsWith('.')) {
                            dirs.push({ name: entry.name, path: fullPath });
                        }
                    }
                    else if (entry.isFile()) {
                        const ext = path.extname(entry.name).slice(1).toLowerCase();
                        if (allowedExtensions.length === 0 || allowedExtensions.includes(ext)) {
                            files.push({ name: entry.name, path: fullPath, ext });
                        }
                    }
                }
                dirs.sort((a, b) => a.name.localeCompare(b.name));
                files.sort((a, b) => a.name.localeCompare(b.name));
                const allSelected = files.length > 0 && files.every(f => selectedFiles.has(f.path));
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
                panel.webview.html = getFilePickerHtml(currentDir, workspaceRoot, fileListHtml, Array.from(selectedFiles).map(f => toWorkspaceRelativePathWithDotDot(f, workspaceRoot)));
            }
            catch (err) {
                vscode.window.showErrorMessage(`无法读取目录: ${currentDir}`);
                panel.dispose();
                resolve([]);
            }
        }
        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'navigate':
                    if (msg.path) {
                        try {
                            const stat = await fs.promises.stat(msg.path);
                            if (stat.isDirectory()) {
                                currentDir = normalizePath(msg.path);
                                await refreshFileList();
                            }
                        }
                        catch (e) {
                            vscode.window.showErrorMessage('无法进入该目录');
                        }
                    }
                    break;
                case 'goUp':
                    const parent = normalizePath(path.dirname(currentDir));
                    if (parent !== currentDir) {
                        currentDir = parent;
                        await refreshFileList();
                    }
                    else {
                        vscode.window.showWarningMessage('已是根目录');
                    }
                    break;
                case 'setPath':
                    let targetPath = msg.path;
                    if (targetPath.startsWith('${workspaceFolder}')) {
                        targetPath = targetPath.replace('${workspaceFolder}', workspaceRoot);
                    }
                    if (!path.isAbsolute(targetPath)) {
                        targetPath = path.resolve(currentDir, targetPath);
                    }
                    const normalized = normalizePath(path.normalize(targetPath));
                    try {
                        const stat = await fs.promises.stat(normalized);
                        if (stat.isDirectory()) {
                            currentDir = normalized;
                            await refreshFileList();
                        }
                        else {
                            vscode.window.showErrorMessage('路径不是目录');
                        }
                    }
                    catch (e) {
                        vscode.window.showErrorMessage('路径无效或不存在');
                    }
                    break;
                case 'toggleFile':
                    const filePath = normalizePath(msg.path);
                    if (selectedFiles.has(filePath)) {
                        selectedFiles.delete(filePath);
                    }
                    else {
                        selectedFiles.add(filePath);
                    }
                    await refreshFileList();
                    break;
                case 'selectAll':
                    const selectAll = msg.selectAll;
                    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
                    const filePaths = [];
                    for (const entry of entries) {
                        if (entry.isFile()) {
                            const fullPath = normalizePath(path.join(currentDir, entry.name));
                            const ext = path.extname(entry.name).slice(1).toLowerCase();
                            if (allowedExtensions.length === 0 || allowedExtensions.includes(ext)) {
                                filePaths.push(fullPath);
                            }
                        }
                    }
                    if (selectAll) {
                        filePaths.forEach(fp => selectedFiles.add(fp));
                    }
                    else {
                        filePaths.forEach(fp => selectedFiles.delete(fp));
                    }
                    await refreshFileList();
                    break;
                case 'confirm':
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
        await refreshFileList();
    });
}
function getFilePickerHtml(currentDir, workspaceRoot, fileListHtml, selectedRelativePaths) {
    const displayPath = normalizePath(currentDir);
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
        .header { margin-bottom: 20px; }
        .current-path { background: var(--vscode-input-background); padding: 8px; border-radius: 4px; font-family: monospace; margin-bottom: 10px; word-break: break-all; }
        .path-input { display: flex; gap: 8px; margin-bottom: 10px; }
        .path-input input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; border-radius: 4px; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        .nav-buttons { display: flex; gap: 8px; margin-bottom: 15px; }
        .file-list { max-height: 400px; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; background: var(--vscode-list-background); }
        .select-all { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
        .file-item { display: flex; align-items: center; padding: 4px 8px; cursor: pointer; border-radius: 4px; }
        .file-item:hover { background: var(--vscode-list-hoverBackground); }
        .dir-item { font-weight: bold; }
        .file-checkbox { margin-right: 8px; cursor: pointer; }
        .file-icon { margin-right: 8px; font-size: 1.1em; }
        .file-name { flex: 1; }
        .selected-info { margin-top: 15px; padding: 8px; background: var(--vscode-input-background); border-radius: 4px; max-height: 100px; overflow-y: auto; }
        .actions { margin-top: 20px; display: flex; justify-content: flex-end; gap: 10px; }
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
        document.querySelectorAll('.dir-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT') return;
                const path = el.getAttribute('data-path');
                vscode.postMessage({ command: 'navigate', path: path });
            });
        });
        document.querySelectorAll('.file-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                const path = cb.getAttribute('data-path');
                vscode.postMessage({ command: 'toggleFile', path: path });
            });
        });
        const selectAllCheckbox = document.getElementById('selectAllCheckbox');
        if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener('change', (e) => {
                const isChecked = e.target.checked;
                vscode.postMessage({ command: 'selectAll', selectAll: isChecked });
            });
        }
        document.getElementById('upBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'goUp' });
        });
        document.getElementById('goToPathBtn').addEventListener('click', () => {
            const input = document.getElementById('pathInput').value;
            vscode.postMessage({ command: 'setPath', path: input });
        });
        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });
        document.getElementById('confirmBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'confirm' });
        });
    </script>
</body>
</html>`;
}
function escapeHtml(str) {
    return str.replace(/[&<>]/g, m => {
        if (m === '&')
            return '&amp;';
        if (m === '<')
            return '&lt;';
        if (m === '>')
            return '&gt;';
        return m;
    });
}
function setupFileWatcher(context) {
    if (cppPropertiesWatcher) {
        cppPropertiesWatcher.dispose();
        cppPropertiesWatcher = undefined;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder)
        return;
    const cppPropertiesPattern = new vscode.RelativePattern(workspaceFolder, '.vscode/c_cpp_properties.json');
    cppPropertiesWatcher = vscode.workspace.createFileSystemWatcher(cppPropertiesPattern);
    cppPropertiesWatcher.onDidCreate((uri) => handleCppPropertiesChange(uri.fsPath));
    cppPropertiesWatcher.onDidChange((uri) => handleCppPropertiesChange(uri.fsPath));
    cppPropertiesWatcher.onDidDelete(() => {
        currentCppConfig = {};
        currentWorkspacePath = '';
    });
    context.subscriptions.push(cppPropertiesWatcher);
    const cppPropertiesPath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'c_cpp_properties.json');
    if (fs.existsSync(cppPropertiesPath)) {
        try {
            const content = fs.readFileSync(cppPropertiesPath, 'utf8');
            currentCppConfig = JSON.parse(content);
            currentWorkspacePath = workspaceFolder.uri.fsPath;
        }
        catch (e) { }
    }
}
async function handleCppPropertiesChange(filePath) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const newConfig = JSON.parse(content);
        if (JSON.stringify(newConfig) === JSON.stringify(currentCppConfig))
            return;
        currentCppConfig = newConfig;
        const workspacePath = path.dirname(path.dirname(filePath));
        currentWorkspacePath = workspacePath;
        const tasksPath = path.join(workspacePath, '.vscode', 'tasks.json');
        if (!fs.existsSync(tasksPath))
            return;
        const existingTasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
        const launchPath = path.join(workspacePath, '.vscode', 'launch.json');
        const existingLaunch = fs.existsSync(launchPath) ? JSON.parse(fs.readFileSync(launchPath, 'utf8')) : { configurations: [{}] };
        const data = extractDataFromExistingConfigs(existingTasks.tasks || [], existingLaunch.configurations?.[0] || {});
        await generateConfigFiles(data, workspacePath, newConfig);
        vscode.window.showInformationMessage('🔄 c_cpp_properties.json 已更新，已自动同步 tasks.json 和 launch.json');
    }
    catch (error) {
        console.error(error);
        vscode.window.showErrorMessage(`同步配置失败: ${error}`);
    }
}
function extractDataFromExistingConfigs(tasks, launchConfig) {
    let buildTask = null;
    for (const task of tasks) {
        if (task.group && task.group.isDefault === true && task.group.kind === 'build') {
            buildTask = task;
            break;
        }
    }
    if (!buildTask)
        buildTask = tasks.find(t => t.args && Array.isArray(t.args) && t.args.length > 0);
    const task = buildTask || { args: [] };
    const data = {
        sourceFiles: [], libraryFiles: [], outputName: 'main', outputPath: './build', args: [],
        miDebuggerPath: launchConfig.miDebuggerPath || '', miDebuggerServerAddress: launchConfig.miDebuggerServerAddress || '',
        miMode: launchConfig.MIMode || 'gdb', cwd: launchConfig.cwd || '${workspaceFolder}',
        environment: launchConfig.environment || [], externalConsole: launchConfig.externalConsole || false,
        stopAtEntry: launchConfig.stopAtEntry || false, generateCleanTask: false
    };
    if (task.args && Array.isArray(task.args)) {
        data.sourceFiles = task.args.filter((arg) => !arg.startsWith('-') && (arg.includes('.c') || arg.includes('.cpp') || arg.includes('.cc') || arg.includes('.cxx'))).map(normalizePath);
        data.libraryFiles = task.args.filter((arg) => !arg.startsWith('-') && (arg.includes('.a') || arg.includes('.o') || arg.includes('.so') || arg.includes('.lib') || arg.includes('.dll'))).map(normalizePath);
        const outputIndex = task.args.indexOf('-o');
        if (outputIndex !== -1 && outputIndex + 1 < task.args.length) {
            const outputPath = task.args[outputIndex + 1];
            const cleanPath = outputPath.replace('${workspaceFolder}/', '').replace('${workspaceFolder}\\', '');
            data.outputName = path.basename(cleanPath);
            data.outputPath = path.dirname(cleanPath) || './build';
        }
    }
    if (launchConfig.args && Array.isArray(launchConfig.args))
        data.args = launchConfig.args;
    return data;
}
async function autoSyncConfigs(workspacePath) {
    const cppPropertiesPath = path.join(workspacePath, '.vscode', 'c_cpp_properties.json');
    const tasksPath = path.join(workspacePath, '.vscode', 'tasks.json');
    if (!fs.existsSync(cppPropertiesPath) || !fs.existsSync(tasksPath))
        return false;
    try {
        const cppContent = fs.readFileSync(cppPropertiesPath, 'utf8');
        const newConfig = JSON.parse(cppContent);
        currentCppConfig = newConfig;
        const existingTasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
        const launchPath = path.join(workspacePath, '.vscode', 'launch.json');
        const existingLaunch = fs.existsSync(launchPath) ? JSON.parse(fs.readFileSync(launchPath, 'utf8')) : { configurations: [{}] };
        const data = extractDataFromExistingConfigs(existingTasks.tasks || [], existingLaunch.configurations?.[0] || {});
        await generateConfigFiles(data, workspacePath, newConfig);
        return true;
    }
    catch (e) {
        console.error(e);
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
function getWebviewContent(existingSources, existingLibs, existingOutputName, existingOutputPath, existingLaunchConfig, workspacePath, webview) {
    const sourceFilesHtml = existingSources.map(f => `<div class="file-item" data-path="${f}"><span class="file-path">${f}</span><button onclick="removeFile(this)" title="删除">×</button></div>`).join('');
    const libFilesHtml = existingLibs.map(f => `<div class="file-item" data-path="${f}"><span class="file-path">${f}</span><button onclick="removeFile(this)" title="删除">×</button></div>`).join('');
    const existingArgs = (existingLaunchConfig.args || []).join(' ');
    const existingMiDebuggerPath = existingLaunchConfig.miDebuggerPath || '';
    const existingMiDebuggerServerAddress = existingLaunchConfig.miDebuggerServerAddress || '';
    const existingMiMode = existingLaunchConfig.MIMode || 'gdb';
    const existingCwd = existingLaunchConfig.cwd || '${workspaceFolder}';
    const existingStopAtEntry = existingLaunchConfig.stopAtEntry || false;
    const existingExternalConsole = existingLaunchConfig.externalConsole || false;
    let existingEnvironment = '';
    if (existingLaunchConfig.environment && Array.isArray(existingLaunchConfig.environment)) {
        existingEnvironment = existingLaunchConfig.environment.map((env) => `${env.name}=${env.value}`).join('\n');
    }
    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>配置编译调试文件</title><style>
*{box-sizing:border-box}body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:20px;max-width:700px;margin:0 auto;line-height:1.5}h2{color:var(--vscode-titleBar-activeForeground);border-bottom:2px solid var(--vscode-panel-border);padding-bottom:10px;margin-bottom:20px}.section{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:15px;margin-bottom:15px}.section-title{font-weight:bold;margin-bottom:12px;color:var(--vscode-textLink-foreground);font-size:1.1em}.form-group{margin-bottom:15px}label{display:block;margin-bottom:6px;font-weight:500}input[type="text"],select,textarea{width:100%;padding:8px 10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;font-family:var(--vscode-editor-font-family)}.hint{font-size:0.85em;color:var(--vscode-descriptionForeground);margin-top:4px}.file-list{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:8px;min-height:50px;background:var(--vscode-input-background);max-height:150px;overflow-y:auto}.file-list:empty::before{content:'暂无文件，请点击下方按钮添加';color:var(--vscode-descriptionForeground);font-style:italic;display:block;text-align:center;padding:15px}.file-item{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;margin:3px 0;background:var(--vscode-list-hoverBackground);border-radius:4px}.file-path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family);margin-right:8px}.file-item button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;width:22px;height:22px;border-radius:3px;cursor:pointer;font-size:14px}.btn-add{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 14px;border-radius:4px;cursor:pointer;margin-top:8px}.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:15px}.actions{position:sticky;bottom:0;background:var(--vscode-editor-background);padding:15px 0;border-top:2px solid var(--vscode-panel-border);margin-top:20px;display:flex;gap:10px;justify-content:flex-end}.btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:10px 24px;border-radius:4px;cursor:pointer;font-weight:bold}.btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;padding:10px 20px;border-radius:4px;cursor:pointer}.checkbox-group{display:flex;align-items:center;gap:8px}input[type="checkbox"]{width:16px;height:16px;cursor:pointer}
</style></head>
<body>
<h2>🛠️ 配置编译调试文件</h2>
<div class="section"><div class="section-title">📄 源文件</div><div class="hint" style="margin-bottom:8px;">选择需要编译的C/C++源文件</div><div id="sourceFiles" class="file-list">${sourceFilesHtml}</div><button class="btn-add" onclick="addSourceFiles()">+ 添加源文件 (.c .cpp .cc)</button></div>
<div class="section"><div class="section-title">🔗 链接库文件</div><div class="hint" style="margin-bottom:8px;">选择需要链接的库文件（静态库.a、动态库.so、目标文件.o等）</div><div id="libraryFiles" class="file-list">${libFilesHtml}</div><button class="btn-add" onclick="addLibraryFiles()">+ 添加库文件 (.a .o .so .lib)</button></div>
<div class="section"><div class="section-title">📤 输出设置</div><div class="grid-2"><div class="form-group"><label>可执行文件名称</label><input type="text" id="outputName" value="${existingOutputName}" placeholder="main"></div><div class="form-group"><label>输出目录</label><input type="text" id="outputPath" value="${existingOutputPath}" placeholder="./build"></div></div></div>
<div class="section"><div class="section-title">🐛 调试设置</div>
<div class="form-group"><label>程序启动参数</label><input type="text" id="args" value="${existingArgs}" placeholder="arg1 arg2 arg3"><div class="hint">传递给main函数的命令行参数，空格分隔</div></div>
<div class="form-group"><label>调试器路径 (miDebuggerPath)</label><input type="text" id="miDebuggerPath" value="${existingMiDebuggerPath}" placeholder="/usr/bin/gdb"><div class="hint">GDB或LLDB调试器的完整路径，如 /usr/bin/gdb 或 gdb</div></div>
<div class="form-group"><label>远程调试服务器地址 (miDebuggerServerAddress)</label><input type="text" id="miDebuggerServerAddress" value="${existingMiDebuggerServerAddress}" placeholder="localhost:1234"><div class="hint">用于远程调试，格式如 localhost:1234 或 192.168.1.100:2345。留空则使用本地调试器。</div></div>
<div class="grid-2"><div class="form-group"><label>调试模式 (MIMode)</label><select id="miMode"><option value="gdb" ${existingMiMode === 'gdb' ? 'selected' : ''}>GDB</option><option value="lldb" ${existingMiMode === 'lldb' ? 'selected' : ''}>LLDB</option></select></div><div class="form-group"><label>工作目录 (cwd)</label><input type="text" id="cwd" value="${existingCwd}" placeholder="\${workspaceFolder}"></div></div>
<div class="form-group"><label>环境变量 (environment)</label><textarea id="environment" placeholder="NAME=VALUE&#10;PATH=/custom/path&#10;DEBUG=1">${existingEnvironment}</textarea><div class="hint">每行一个，格式：NAME=VALUE</div></div>
<div class="checkbox-group" style="margin-top:10px;"><input type="checkbox" id="externalConsole" ${existingExternalConsole ? 'checked' : ''}><label for="externalConsole" style="margin:0;cursor:pointer;">使用外部控制台 (externalConsole)</label></div>
<div class="checkbox-group" style="margin-top:10px;"><input type="checkbox" id="stopAtEntry" ${existingStopAtEntry ? 'checked' : ''}><label for="stopAtEntry" style="margin:0;cursor:pointer;">启动时停止在main函数入口 (stopAtEntry)</label></div>
</div>
<div class="actions"><button class="btn-secondary" onclick="cancel()">取消</button><button class="btn-primary" onclick="generate()">✅ 生成配置</button></div>
<script>
const vscode = acquireVsCodeApi();
function addSourceFiles(){ vscode.postMessage({ command:'browseFile', fieldId:'sourceFiles', currentFiles: getFileList('sourceFiles'), filter:{'C/C++源文件':['c','cpp','cc','cxx']} }); }
function addLibraryFiles(){ vscode.postMessage({ command:'browseFile', fieldId:'libraryFiles', currentFiles: getFileList('libraryFiles'), filter:{'库文件':['a','o','so','lib','dll','dylib']} }); }
function removeFile(btn){ btn.parentElement.remove(); }
function setFilesList(fieldId, paths) {
    const container = document.getElementById(fieldId);
    container.innerHTML = '';
    paths.forEach(p => {
        const div = document.createElement('div');
        div.className = 'file-item';
        div.setAttribute('data-path', p);
        div.innerHTML = '<span class="file-path">' + p + '</span><button onclick="removeFile(this)" title="删除">×</button>';
        container.appendChild(div);
    });
}
window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'fileSelected') {
        setFilesList(msg.fieldId, msg.paths);
    }
});
function getFileList(fieldId){ return Array.from(document.querySelectorAll('#'+fieldId+' .file-item')).map(item=>item.getAttribute('data-path')); }
function cancel(){ vscode.postMessage({ command:'cancel' }); }
function generate(){
    const data={
        sourceFiles: getFileList('sourceFiles'),
        libraryFiles: getFileList('libraryFiles'),
        outputName: document.getElementById('outputName').value||'main',
        outputPath: document.getElementById('outputPath').value||'./build',
        args: document.getElementById('args').value.split(' ').filter(s=>s.trim()),
        miDebuggerPath: document.getElementById('miDebuggerPath').value,
        miDebuggerServerAddress: document.getElementById('miDebuggerServerAddress').value,
        miMode: document.getElementById('miMode').value,
        cwd: document.getElementById('cwd').value||'\${workspaceFolder}',
        environment: document.getElementById('environment').value.split('\\n').filter(s=>s.trim()).map(line=>{ const eq=line.indexOf('='); return eq>0?{name:line.substring(0,eq),value:line.substring(eq+1)}:{name:line,value:''}; }),
        externalConsole: document.getElementById('externalConsole').checked,
        stopAtEntry: document.getElementById('stopAtEntry').checked
    };
    vscode.postMessage({ command:'generate', data:data });
}
</script>
</body></html>`;
}
function normalizePath(p) { return p.replace(/\\/g, '/'); }
function toWorkspaceRelativePathWithDotDot(fullPath, workspacePath) {
    const normalizedFull = normalizePath(fullPath);
    const normalizedWorkspace = normalizePath(workspacePath);
    let relative = path.relative(normalizedWorkspace, normalizedFull);
    relative = normalizePath(relative);
    if (!relative || relative === '.')
        return '${workspaceFolder}/';
    if (!relative.startsWith('..'))
        return '${workspaceFolder}/' + relative;
    return '${workspaceFolder}/' + relative;
}
function getAllSubdirectories(basePath) {
    const result = [];
    const normalizedBase = normalizePath(basePath);
    function traverse(currentPath, relativePrefix) {
        try {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
                    result.push(relativePath);
                    traverse(path.join(currentPath, entry.name), relativePath);
                }
            }
        }
        catch (e) { }
    }
    traverse(normalizedBase, '');
    return result;
}
function expandIncludePath(includePath, workspacePath) {
    const result = [];
    for (const inc of includePath) {
        if (!inc || typeof inc !== 'string')
            continue;
        if (inc.includes('/**')) {
            const basePathWithVar = inc.replace('/**', '');
            const basePath = basePathWithVar.replace('${workspaceFolder}', workspacePath);
            const normalizedBase = normalizePath(basePath);
            if (inc.includes('${workspaceFolder}'))
                result.push(basePathWithVar);
            else if (path.isAbsolute(basePathWithVar))
                result.push(toWorkspaceRelativePathWithDotDot(basePathWithVar, workspacePath));
            else
                result.push('${workspaceFolder}/' + normalizePath(basePathWithVar));
            if (fs.existsSync(normalizedBase) && fs.statSync(normalizedBase).isDirectory()) {
                const subDirs = getAllSubdirectories(normalizedBase);
                for (const subDir of subDirs)
                    result.push('${workspaceFolder}/' + subDir);
            }
        }
        else if (inc.includes('${workspaceFolder}') || inc.includes('${default}'))
            result.push(normalizePath(inc));
        else if (path.isAbsolute(inc))
            result.push(toWorkspaceRelativePathWithDotDot(inc, workspacePath));
        else
            result.push('${workspaceFolder}/' + normalizePath(inc));
    }
    return [...new Set(result)];
}
async function generateConfigFiles(data, workspacePath, cppConfig) {
    const vscodePath = path.join(workspacePath, '.vscode');
    if (!fs.existsSync(vscodePath))
        fs.mkdirSync(vscodePath, { recursive: true });
    try {
        const config = cppConfig.configurations?.[0] || {};
        const compilerPath = config.compilerPath || '';
        const includePath = config.includePath || [];
        const defines = config.defines || [];
        const compilerArgs = config.compilerArgs || [];
        const cStandard = config.cStandard || '';
        const cppStandard = config.cppStandard || '';
        let compiler = compilerPath ? normalizePath(compilerPath) : '';
        let isCppCompiler = false;
        if (!compiler) {
            const hasCpp = data.sourceFiles.some((f) => f.includes('.cpp') || f.includes('.cc') || f.includes('.cxx'));
            isCppCompiler = hasCpp;
            compiler = hasCpp ? 'g++' : 'gcc';
        }
        else {
            const compilerName = path.basename(compilerPath).toLowerCase();
            isCppCompiler = compilerName.includes('g++') || compilerName.includes('clang++') || compilerName.includes('c++');
        }
        let stdFlag = '';
        if (isCppCompiler) {
            if (cppStandard) {
                const cppStd = cppStandard.toLowerCase().replace(/c\+\+/g, 'c++').replace(/gnu\+\+/g, 'gnu++');
                if (cppStd.startsWith('c++') || cppStd.startsWith('gnu++'))
                    stdFlag = `-std=${cppStd}`;
            }
        }
        else {
            if (cStandard) {
                const cStd = cStandard.toLowerCase().replace(/gnu/g, 'gnu');
                if (cStd.startsWith('c') || cStd.startsWith('gnu'))
                    stdFlag = `-std=${cStd}`;
            }
        }
        const compilerDir = compilerPath ? normalizePath(path.dirname(compilerPath)) : '';
        const expandedIncludes = expandIncludePath(includePath, workspacePath);
        const args = [];
        if (stdFlag)
            args.push(stdFlag);
        args.push(...data.sourceFiles);
        expandedIncludes.forEach(inc => { args.push('-I', inc); });
        defines.forEach((def) => { if (def && typeof def === 'string')
            args.push('-D', def); });
        compilerArgs.forEach((arg) => { if (arg && typeof arg === 'string')
            args.push(arg); });
        args.push(...data.libraryFiles);
        const outputPathWithPrefix = '${workspaceFolder}/' + normalizePath(path.join(data.outputPath, data.outputName));
        args.push('-o', outputPathWithPrefix);
        const platform = getPlatform();
        const isWin = platform === 'win32';
        const tasks = [
            { label: "创建输出目录", type: "shell", command: isWin ? "powershell" : "mkdir", args: isWin ? ['-Command', 'New-Item', '-ItemType', 'Directory', '-Force', '-Path', '${workspaceFolder}/' + normalizePath(data.outputPath)] : ['-p', '${workspaceFolder}/' + normalizePath(data.outputPath)], options: { cwd: "${workspaceFolder}" }, group: "build", problemMatcher: [], detail: "自动创建编译输出目录" },
            { label: `构建 ${data.outputName}`, type: "shell", command: compiler, args: args, options: { cwd: compilerDir || "${workspaceFolder}" }, group: { kind: "build", isDefault: true }, dependsOn: "创建输出目录", problemMatcher: ["$gcc"], detail: "编译并链接生成可执行文件" }
        ];
        fs.writeFileSync(path.join(vscodePath, 'tasks.json'), JSON.stringify({ version: "2.0.0", tasks }, null, 4), 'utf8');
        // 使用统一的推断函数获取默认调试器路径
        let defaultDebuggerPath = data.miDebuggerPath && data.miDebuggerPath.trim()
            ? normalizePath(data.miDebuggerPath.trim())
            : getDefaultDebuggerPathFromConfig(cppConfig, platform, isWSL());
        const launchConfig = {
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
            preLaunchTask: `构建 ${data.outputName}`,
            setupCommands: [
                {
                    description: "为gdb启用整齐打印",
                    text: "-enable-pretty-printing",
                    ignoreFailures: true
                }
            ]
        };
        if (data.miDebuggerServerAddress && data.miDebuggerServerAddress.trim()) {
            launchConfig.miDebuggerServerAddress = data.miDebuggerServerAddress.trim();
        }
        else {
            launchConfig.miDebuggerPath = defaultDebuggerPath;
        }
        fs.writeFileSync(path.join(vscodePath, 'launch.json'), JSON.stringify({ version: "0.2.0", configurations: [launchConfig] }, null, 4), 'utf8');
        vscode.window.showInformationMessage(`✅ 配置生成成功！包含路径: ${expandedIncludes.length}个${stdFlag ? '，标准: ' + stdFlag : ''}，自动创建输出目录`);
        const openNow = await vscode.window.showInformationMessage('是否立即查看生成的配置文件？', '打开tasks.json', '打开launch.json', '稍后');
        if (openNow === '打开tasks.json') {
            const doc = await vscode.workspace.openTextDocument(path.join(vscodePath, 'tasks.json'));
            await vscode.window.showTextDocument(doc);
        }
        else if (openNow === '打开launch.json') {
            const doc = await vscode.workspace.openTextDocument(path.join(vscodePath, 'launch.json'));
            await vscode.window.showTextDocument(doc);
        }
    }
    catch (error) {
        vscode.window.showErrorMessage(`生成配置文件失败: ${error}`);
    }
}
function deactivate() {
    if (cppPropertiesWatcher)
        cppPropertiesWatcher.dispose();
}
//# sourceMappingURL=extension.js.map