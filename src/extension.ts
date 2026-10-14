import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceIndexer } from './indexing/workspaceIndexer';
import { ExplorerProvider, registerExplorerCommands } from './providers/explorerProvider';
import { GraphPanel } from './webview/graphPanel';
import { exportContext, updateAgentsFile } from './export/contextExporter';
import { GraphNode } from './models/graph';

let indexer: WorkspaceIndexer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const provider = new ExplorerProvider();
	const tree = vscode.window.createTreeView('codemapper.explorer', { treeDataProvider: provider, showCollapseAll: true });
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	status.name = 'CodeMapper Index Status';
	status.command = 'codemapper.indexRepository';
	status.text = '$(sync) CodeMapper';
	status.tooltip = 'Index the current workspace with CodeMapper';
	status.show();
	const graphPanels = new GraphPanel(context, async (node, folder) => openSource(node, folder));
	indexer = new WorkspaceIndexer(context, status, (folder, graph) => {
		provider.setGraph(folder, graph);
		graphPanels.refresh(folder, graph);
		if (vscode.workspace.getConfiguration('codemapper', folder.uri).get<boolean>('autoExport', false)) {
			const output = vscode.workspace.getConfiguration('codemapper', folder.uri).get<string>('outputDirectory', '.codemapper');
			void exportContext(folder, graph, output).catch(error => vscode.window.showErrorMessage(`CodeMapper auto-export failed: ${String(error)}`));
		}
	});
	context.subscriptions.push(indexer, tree, graphPanels);
	registerExplorerCommands(context, provider);

	const enabled = (folder?: vscode.WorkspaceFolder) => vscode.workspace.getConfiguration('codemapper', folder?.uri).get<boolean>('enabled', true);
	const autoIndex = (folder: vscode.WorkspaceFolder) => vscode.workspace.getConfiguration('codemapper', folder.uri).get<boolean>('autoIndex', true);
	const runIndex = async (rebuild = false, automatic = false) => {
		if (!vscode.workspace.isTrusted) {
			vscode.window.showWarningMessage('Trust this workspace before CodeMapper can analyze its source files.');
			return;
		}
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => enabled(folder) && (!automatic || autoIndex(folder)));
		if (!folders.length) {
			if (!automatic) {
				vscode.window.showInformationMessage('CodeMapper is disabled or no workspace folder is open. Enable codemapper.enabled to index a workspace.');
			}
			return;
		}
		await indexer?.indexAll(rebuild, folders);
	};
	context.subscriptions.push(
		vscode.commands.registerCommand('codemapper.indexRepository', () => runIndex()),
		vscode.commands.registerCommand('codemapper.rebuildIndex', () => runIndex(true)),
		vscode.commands.registerCommand('codemapper.openGraph', async () => {
			const activeDocument = vscode.window.activeTextEditor?.document;
			const folder = (activeDocument ? vscode.workspace.getWorkspaceFolder(activeDocument.uri) : undefined) ?? vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				vscode.window.showInformationMessage('Open a repository folder to view its CodeMapper graph.');
				return;
			}
			const graph = indexer?.getGraph(folder);
			if (!graph) {
				vscode.window.showInformationMessage('CodeMapper has not indexed this workspace yet.');
				return;
			}
			const maxNodes = vscode.workspace.getConfiguration('codemapper', folder.uri).get<number>('maxGraphNodes', 200);
			graphPanels.open(folder, graph, maxNodes);
		}),
		vscode.commands.registerCommand('codemapper.exportContext', async () => {
			const activeDocument = vscode.window.activeTextEditor?.document;
			const folder = (activeDocument ? vscode.workspace.getWorkspaceFolder(activeDocument.uri) : undefined) ?? vscode.workspace.workspaceFolders?.[0];
			if (!folder) {return void vscode.window.showInformationMessage('Open a repository folder before exporting context.');}
			const graph = indexer?.getGraph(folder);
			if (!graph) {return void vscode.window.showInformationMessage('Index the repository before exporting context.');}
			const output = vscode.workspace.getConfiguration('codemapper', folder.uri).get<string>('outputDirectory', '.codemapper');
			await exportContext(folder, graph, output);
			vscode.window.showInformationMessage(`CodeMapper context exported to ${path.posix.join(output, 'CODEBASE.md')}.`);
		}),
		vscode.commands.registerCommand('codemapper.updateAgents', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {return void vscode.window.showInformationMessage('Open a repository folder before updating AGENTS.md.');}
			const answer = await vscode.window.showWarningMessage('Update or create AGENTS.md with a clearly marked CodeMapper section?', { modal: true }, 'Update AGENTS.md');
			if (answer !== 'Update AGENTS.md') {return;}
			const output = vscode.workspace.getConfiguration('codemapper', folder.uri).get<string>('outputDirectory', '.codemapper');
			await updateAgentsFile(folder, output);
			vscode.window.showInformationMessage('CodeMapper guidance was updated in AGENTS.md.');
		}),
		vscode.commands.registerCommand('codemapper.refreshExplorer', () => provider.refresh()),
	);

	const watchers = new Map<string, vscode.FileSystemWatcher>();
	const pending = new Map<string, ReturnType<typeof setTimeout>>();
	context.subscriptions.push({ dispose: () => {
		for (const timer of pending.values()) {clearTimeout(timer);}
		pending.clear();
	} });
	const watchFolder = (folder: vscode.WorkspaceFolder) => {
		if (watchers.has(folder.uri.toString())) {return;}
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.py'));
		const queueRefresh = () => {
			if (!enabled(folder) || !vscode.workspace.getConfiguration('codemapper', folder.uri).get<boolean>('autoUpdate', true)) {return;}
			const key = folder.uri.toString();
			const previous = pending.get(key);
			if (previous) {clearTimeout(previous);}
			pending.set(key, setTimeout(() => {
				pending.delete(key);
				void indexer?.refreshFolder(folder).catch(error => vscode.window.showErrorMessage(`CodeMapper update failed for ${folder.name}: ${String(error)}`));
			}, 450));
		};
		context.subscriptions.push(watcher, watcher.onDidCreate(queueRefresh), watcher.onDidChange(queueRefresh), watcher.onDidDelete(queueRefresh));
		watchers.set(folder.uri.toString(), watcher);
	};
	for (const folder of vscode.workspace.workspaceFolders ?? []) {watchFolder(folder);}
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
		if (document.languageId !== 'python') {return;}
		const folder = vscode.workspace.getWorkspaceFolder(document.uri);
		if (folder) {
			const key = folder.uri.toString();
			const previous = pending.get(key);
			if (previous) {clearTimeout(previous);}
			if (enabled(folder) && vscode.workspace.getConfiguration('codemapper', folder.uri).get<boolean>('autoUpdate', true)) {
				pending.set(key, setTimeout(() => {
					pending.delete(key);
					void indexer?.refreshFolder(folder).catch(error => vscode.window.showErrorMessage(`CodeMapper update failed for ${folder.name}: ${String(error)}`));
				}, 450));
			}
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
		for (const folder of event.removed) {
			watchers.get(folder.uri.toString())?.dispose();
			watchers.delete(folder.uri.toString());
			const timer = pending.get(folder.uri.toString());
			if (timer) {clearTimeout(timer);}
			pending.delete(folder.uri.toString());
			provider.removeGraph(folder);
			void indexer?.removeFolder(folder);
		}
		for (const folder of event.added) {watchFolder(folder);}
		if (event.added.length && vscode.workspace.isTrusted) {void runIndex(false, true);}
	}));
	context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
		void runIndex(false, true);
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('codemapper.enabled') ||
			event.affectsConfiguration('codemapper.autoIndex') ||
			event.affectsConfiguration('codemapper.pythonPath') ||
			event.affectsConfiguration('codemapper.exclude')) {
			if (vscode.workspace.isTrusted) {
				void runIndex(false, true);
			}
		}
	}));

	await indexer.loadCachedIndexes();
	if (vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.length) {
		void runIndex(false, true).catch(() => undefined);
	}
}

export function deactivate(): void {
	indexer?.dispose();
	indexer = undefined;
}

async function openSource(node: GraphNode, folder: vscode.WorkspaceFolder): Promise<void> {
	if (!node.file) {return;}
	const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, node.file));
	const editor = await vscode.window.showTextDocument(document);
	const position = new vscode.Position(Math.max(0, (node.startLine ?? 1) - 1), 0);
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}
