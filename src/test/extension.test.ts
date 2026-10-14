import * as assert from 'assert';
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exportContext } from '../export/contextExporter';
import { CodeGraph, callersOf, calleesOf } from '../models/graph';

function sampleGraph(): CodeGraph {
	return {
		metadata: { schemaVersion: 1, workspaceId: 'test', indexedAt: '2026-01-01T00:00:00.000Z', sourceHashes: { 'src.py': 'hash' }, diagnostics: [] },
		nodes: [
			{ id: 'src.py::<module>', type: 'module', name: 'src', qualifiedName: 'src', file: 'src.py' },
			{ id: 'src.py::first', type: 'function', name: 'first', qualifiedName: 'first', file: 'src.py', startLine: 1, endLine: 2, signature: 'first(value)', parameters: [{ name: 'value', kind: 'positionalOrKeyword' }] },
			{ id: 'src.py::second', type: 'function', name: 'second', qualifiedName: 'second', file: 'src.py', startLine: 4, endLine: 5, signature: 'second()', parameters: [] },
		],
		edges: [
			{ source: 'src.py::<file>', target: 'src.py::first', type: 'FILE_CONTAINS_FUNCTION', resolution: 'resolved', sourceLine: 1 },
			{ source: 'src.py::first', target: 'src.py::second', type: 'FUNCTION_CALLS_FUNCTION', resolution: 'resolved', sourceLine: 2 },
		],
	};
}

function waitForWorkspaceFolderChange(uri: vscode.Uri, change: 'added' | 'removed'): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			subscription.dispose();
			reject(new Error(`Timed out waiting for workspace folder ${change}: ${uri.fsPath}`));
		}, 5000);
		const subscription = vscode.workspace.onDidChangeWorkspaceFolders(event => {
			const folders = change === 'added' ? event.added : event.removed;
			if (folders.some(folder => folder.uri.toString() === uri.toString())) {
				clearTimeout(timeout);
				subscription.dispose();
				resolve();
			}
		});
	});
}

suite('CodeMapper Extension', () => {
	test('activates and registers the required CodeMapper commands', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'codemapper');
		assert.ok(extension, 'CodeMapper extension is available in the Extension Development Host');
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const command of [
			'codemapper.indexRepository', 'codemapper.rebuildIndex', 'codemapper.openGraph',
			'codemapper.showCallers', 'codemapper.showCallees', 'codemapper.exportContext',
			'codemapper.refreshExplorer',
		]) {
			assert.ok(commands.includes(command), `Missing registered command ${command}`);
		}
	});

	test('queries callers and callees from canonical call edges', () => {
		const graph = sampleGraph();
		assert.deepStrictEqual(callersOf(graph, 'src.py::second').map(edge => edge.source), ['src.py::first']);
		assert.deepStrictEqual(calleesOf(graph, 'src.py::first').map(edge => edge.target), ['src.py::second']);
		assert.deepStrictEqual(callersOf(graph, 'src.py::first'), []);
	});

	test('exports deterministic Markdown, JSON, module docs, and Mermaid', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codemapper-export-'));
		try {
			const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(directory), name: 'fixture', index: 0 };
			const graph = sampleGraph();
			await exportContext(folder, graph, '.codemapper');
			const target = path.join(directory, '.codemapper');
			const overview = await fs.readFile(path.join(target, 'CODEBASE.md'), 'utf8');
			const functions = await fs.readFile(path.join(target, 'functions.json'), 'utf8');
			const mermaid = await fs.readFile(path.join(target, 'graph.mmd'), 'utf8');
			assert.match(overview, /Repository overview/);
			assert.match(functions, /"callers"/);
			assert.match(mermaid, /^graph LR/);
			const manifest = JSON.parse(await fs.readFile(path.join(target, '.modules.json'), 'utf8')) as string[];
			assert.strictEqual(manifest.length, 1);
			const moduleDoc = await fs.readFile(path.join(target, 'modules', manifest[0]), 'utf8');
			assert.match(moduleDoc, /\.\.\/\.\.\/src\.py/);
			const firstOutput = await fs.readFile(path.join(target, 'graph.json'), 'utf8');
			await exportContext(folder, graph, '.codemapper');
			assert.strictEqual(await fs.readFile(path.join(target, 'graph.json'), 'utf8'), firstOutput);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('source navigation opens the selected symbol at its source line', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codemapper-navigation-'));
		try {
			await fs.writeFile(path.join(directory, 'sample.py'), 'def entry():\n    return 1\n', 'utf8');
			const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(directory), name: 'fixture', index: 0 };
			const node = {
				id: 'sample.py::entry', type: 'function' as const, name: 'entry', qualifiedName: 'entry',
				file: 'sample.py', startLine: 2, endLine: 2,
			};
			await vscode.commands.executeCommand('codemapper.openSymbol', node, folder);
			assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(directory, node.file));
			assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, 1);
		} finally {
			await vscode.window.activeTextEditor?.document.save();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('indexes a real Python workspace and exports the indexed graph', async () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'codemapper');
		assert.ok(extension);
		assert.ok(vscode.workspace.isTrusted, 'The integration workspace must be trusted to exercise indexing');
		assert.strictEqual(vscode.workspace.getConfiguration('codemapper').get<boolean>('enabled', true), true);
		const directory = await fs.mkdtemp(path.join(extension.extensionPath, 'codemapper-test-'));
		const workspaceIndex = vscode.workspace.workspaceFolders?.length ?? 0;
		try {
			await fs.mkdir(path.join(directory, '.vscode'), { recursive: true });
			await fs.writeFile(path.join(directory, '.vscode', 'settings.json'), JSON.stringify({
				'codemapper.enabled': true,
				'codemapper.autoIndex': false,
				'codemapper.autoUpdate': true,
				'codemapper.outputDirectory': '.codemapper',
			}), 'utf8');
			await fs.writeFile(path.join(directory, 'app.py'), [
				'def helper(value):',
				'    return value',
				'',
				'def main():',
				'    helper("ok")',
				'    dynamic_target()',
			].join('\n'), 'utf8');
			const fixtureUri = vscode.Uri.file(directory);
			const added = waitForWorkspaceFolderChange(fixtureUri, 'added');
			assert.ok(vscode.workspace.updateWorkspaceFolders(workspaceIndex, 0, { uri: fixtureUri, name: 'fixture' }));
			await added;
			assert.ok(vscode.workspace.workspaceFolders?.some(folder => folder.uri.fsPath === directory), 'The fixture folder must be present in the workspace');
			const fixtureFolder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.fsPath === directory);
			assert.ok(fixtureFolder);
			assert.strictEqual(vscode.workspace.getConfiguration('codemapper', fixtureFolder.uri).get<boolean>('enabled'), true);
			await vscode.commands.executeCommand('codemapper.indexRepository');
			const fixtureDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'app.py')));
			await vscode.window.showTextDocument(fixtureDocument);
			await vscode.commands.executeCommand('codemapper.exportContext');
			const exported = path.join(directory, '.codemapper');
			const graph = JSON.parse(await fs.readFile(path.join(exported, 'graph.json'), 'utf8')) as CodeGraph;
			const functionNames = graph.nodes.filter(node => node.type === 'function').map(node => node.name);
			assert.ok(functionNames.includes('helper'));
			assert.ok(functionNames.includes('main'));
			assert.ok(graph.edges.some(edge => edge.type === 'FUNCTION_CALLS_FUNCTION' && edge.resolution === 'resolved'));
			assert.ok(graph.edges.some(edge => edge.type === 'FUNCTION_CALLS_FUNCTION' && edge.resolution === 'unresolved'));
			assert.ok((await fs.readFile(path.join(exported, 'CODEBASE.md'), 'utf8')).includes('Codebase map'));

			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(directory, 'app.py')));
			const editor = await vscode.window.showTextDocument(document);
			await editor.edit(edit => edit.insert(new vscode.Position(document.lineCount, 0), '\n\ndef added():\n    return helper("updated")\n'));
			await document.save();
			await new Promise(resolve => setTimeout(resolve, 900));
			await vscode.commands.executeCommand('codemapper.exportContext');
			const updated = JSON.parse(await fs.readFile(path.join(exported, 'graph.json'), 'utf8')) as CodeGraph;
			assert.ok(updated.nodes.some(node => node.id === 'app.py::added'));
			assert.ok(updated.edges.some(edge => edge.source === 'app.py::added' && edge.target === 'app.py::helper'));
		} finally {
			const fixtureUri = vscode.Uri.file(directory);
			if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString() === fixtureUri.toString())) {
				const removed = waitForWorkspaceFolderChange(fixtureUri, 'removed');
				vscode.workspace.updateWorkspaceFolders(workspaceIndex, 1);
				await removed;
			}
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
