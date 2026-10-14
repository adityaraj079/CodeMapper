import * as vscode from 'vscode';
import { CodeGraph, GraphNode, callersOf, calleesOf } from '../models/graph';

interface ExplorerItem extends vscode.TreeItem {
	node?: GraphNode;
	graph?: CodeGraph;
	folder?: vscode.WorkspaceFolder;
	children?: ExplorerItem[];
}

export class ExplorerProvider implements vscode.TreeDataProvider<ExplorerItem> {
	private readonly changeEmitter = new vscode.EventEmitter<ExplorerItem | undefined>();
	readonly onDidChangeTreeData = this.changeEmitter.event;
	private readonly graphs = new Map<string, { folder: vscode.WorkspaceFolder; graph: CodeGraph }>();

	refresh(): void {
		this.changeEmitter.fire(undefined);
	}

	setGraph(folder: vscode.WorkspaceFolder, graph: CodeGraph): void {
		this.graphs.set(folder.uri.toString(), { folder, graph });
		this.refresh();
	}

	getGraph(folder?: vscode.WorkspaceFolder): CodeGraph | undefined {
		return (folder ? this.graphs.get(folder.uri.toString()) : this.graphs.values().next().value)?.graph;
	}

	getGraphs(): Array<{ folder: vscode.WorkspaceFolder; graph: CodeGraph }> {
		return [...this.graphs.values()];
	}

	removeGraph(folder: vscode.WorkspaceFolder): void {
		this.graphs.delete(folder.uri.toString());
		this.refresh();
	}

	getTreeItem(element: ExplorerItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: ExplorerItem): ExplorerItem[] {
		if (!element) {
			const items = [...this.graphs.values()].map(({ folder, graph }) => this.makeWorkspaceItem(folder, graph));
			if (!items.length) {
				return [new vscode.TreeItem(vscode.workspace.workspaceFolders?.length ? 'Indexing Python workspace…' : 'Open a workspace to get started')];
			}
			return items;
		}
		return element.children ?? [];
	}

	private makeWorkspaceItem(folder: vscode.WorkspaceFolder, graph: CodeGraph): ExplorerItem {
		const modules = graph.nodes.filter(node => node.type === 'module' && node.file).sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
		const children = modules.map(module => {
			const file = module.file ?? '';
			const defined = graph.nodes.filter(node => node.file === file && ['class', 'function', 'method'].includes(node.type));
			const classes = defined.filter(node => node.type === 'class').map(classNode => this.symbolItem(classNode, graph, folder, defined.filter(node => node.type === 'method' && node.qualifiedName.startsWith(classNode.qualifiedName + '.'))));
			const functions = defined.filter(node => node.type === 'function').map(node => this.symbolItem(node, graph, folder));
			const fileNode: ExplorerItem = new vscode.TreeItem(file, vscode.TreeItemCollapsibleState.Collapsed);
			fileNode.children = [...classes, ...functions];
			fileNode.iconPath = new vscode.ThemeIcon('file-code');
			fileNode.tooltip = `${file}\n${defined.length} symbols`;
			const moduleItem: ExplorerItem = new vscode.TreeItem(module.qualifiedName, vscode.TreeItemCollapsibleState.Expanded);
			moduleItem.children = [fileNode];
			moduleItem.iconPath = new vscode.ThemeIcon('package');
			moduleItem.tooltip = `Python module ${module.qualifiedName}`;
			return moduleItem;
		});
		if (!children.length) {
			children.push(new vscode.TreeItem('No Python files found. Run Index Repository to scan again.'));
		}
		const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.Expanded) as ExplorerItem;
		item.children = children;
		item.tooltip = `${modules.length} Python modules; ${graph.nodes.filter(node => node.type === 'function' || node.type === 'method').length} functions and methods`;
		return item;
	}

	private symbolItem(node: GraphNode, graph: CodeGraph, folder: vscode.WorkspaceFolder, children?: GraphNode[]): ExplorerItem {
		const item = new vscode.TreeItem(node.signature ?? node.name, children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None) as ExplorerItem;
		item.node = node;
		item.graph = graph;
		item.folder = folder;
		item.children = children?.map(child => this.symbolItem(child, graph, folder));
		item.description = node.type === 'function' || node.type === 'method'
			? `${callersOf(graph, node.id).length} callers · ${calleesOf(graph, node.id).length} callees`
			: node.type;
		item.tooltip = `${node.type} ${node.qualifiedName}\n${node.file ?? ''}:${node.startLine ?? 1}\n${node.docstring ?? ''}`;
		item.iconPath = new vscode.ThemeIcon(node.type === 'class' ? 'symbol-class' : node.type === 'method' ? 'symbol-method' : 'symbol-function');
		item.contextValue = node.type === 'function' || node.type === 'method' ? 'codemapperFunction' : 'codemapperSymbol';
		item.command = { command: 'codemapper.openSymbol', title: 'Open source', arguments: [node, folder] };
		return item;
	}
}

export function registerExplorerCommands(context: vscode.ExtensionContext, provider: ExplorerProvider): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('codemapper.openSymbol', async (node: GraphNode, folder: vscode.WorkspaceFolder) => {
			if (!node.file) {return;}
			const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, node.file));
			const editor = await vscode.window.showTextDocument(document);
			const position = new vscode.Position(Math.max(0, (node.startLine ?? 1) - 1), 0);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
		}),
		vscode.commands.registerCommand('codemapper.showCallers', async (item?: ExplorerItem) => {
			const selected = await chooseFunction(provider, item?.node, item?.folder);
			if (!selected) {return;}
			const entries = callersOf(selected.graph, selected.node.id);
			await showRelationships(selected.graph, entries.map(edge => edge.source), 'Callers', selected.folder);
		}),
		vscode.commands.registerCommand('codemapper.showCallees', async (item?: ExplorerItem) => {
			const selected = await chooseFunction(provider, item?.node, item?.folder);
			if (!selected) {return;}
			const entries = calleesOf(selected.graph, selected.node.id);
			await showRelationships(selected.graph, entries.map(edge => edge.target), 'Callees', selected.folder);
		}),
	);
}

async function chooseFunction(provider: ExplorerProvider, node?: GraphNode, folder?: vscode.WorkspaceFolder): Promise<{ node: GraphNode; graph: CodeGraph; folder: vscode.WorkspaceFolder } | undefined> {
	if (node && folder) {
		const graph = provider.getGraph(folder);
		return graph ? { node, graph, folder } : undefined;
	}
	const candidates = provider.getGraphs().flatMap(entry => entry.graph.nodes
		.filter(candidate => candidate.type === 'function' || candidate.type === 'method')
		.map(candidate => ({ label: candidate.signature ?? candidate.qualifiedName, description: `${entry.folder.name} · ${candidate.file}:${candidate.startLine}`, node: candidate, graph: entry.graph, folder: entry.folder })));
	const selected = await vscode.window.showQuickPick(candidates, { title: 'Select a function or method' });
	return selected ? { node: selected.node, graph: selected.graph, folder: selected.folder } : undefined;
}

async function showRelationships(graph: CodeGraph, ids: string[], title: string, folder: vscode.WorkspaceFolder): Promise<void> {
	const byId = new Map(graph.nodes.map(node => [node.id, node]));
	const items = ids.map(id => {
		const node = byId.get(id);
		return node ? { label: node.signature ?? node.qualifiedName, description: `${node.file ?? ''}:${node.startLine ?? ''}`, node } : undefined;
	}).filter((item): item is { label: string; description: string; node: GraphNode } => !!item);
	if (!items.length) {
		vscode.window.showInformationMessage(`No ${title.toLowerCase()} found.`);
		return;
	}
	const choice = await vscode.window.showQuickPick(items, { title: `${title} (${items.length})` });
	if (choice) {
		if (choice.node.file) {
			const uri = vscode.Uri.joinPath(folder.uri, choice.node.file);
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc);
			const pos = new vscode.Position(Math.max(0, (choice.node.startLine ?? 1) - 1), 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
		}
	}
}
