import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CodeGraph } from '../models/graph';

export class WorkspaceIndexer implements vscode.Disposable {
	private readonly graphs = new Map<string, CodeGraph>();
	private readonly processes = new Set<ChildProcessWithoutNullStreams>();
	private readonly folderRuns = new Map<string, Promise<void>>();
	private readonly activeFolderUris = new Set<string>();
	private disposed = false;
	private activeRun?: Promise<void>;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly status: vscode.StatusBarItem,
		private readonly onUpdated: (folder: vscode.WorkspaceFolder, graph: CodeGraph) => void,
	) {}

	getGraph(folder?: vscode.WorkspaceFolder): CodeGraph | undefined {
		const selected = folder ?? vscode.workspace.workspaceFolders?.[0];
		return selected ? this.graphs.get(selected.uri.toString()) : undefined;
	}

	getAllGraphs(): Array<{ folder: vscode.WorkspaceFolder; graph: CodeGraph }> {
		return (vscode.workspace.workspaceFolders ?? [])
			.map(folder => ({ folder, graph: this.graphs.get(folder.uri.toString()) }))
			.filter((item): item is { folder: vscode.WorkspaceFolder; graph: CodeGraph } => !!item.graph);
	}

	async loadCachedIndexes(): Promise<void> {
		await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			try {
				const raw = await fs.readFile(this.cachePath(folder), 'utf8');
				const graph = JSON.parse(raw) as CodeGraph;
				if (graph.metadata?.schemaVersion === 1 && Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
					this.graphs.set(folder.uri.toString(), graph);
					this.onUpdated(folder, graph);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					console.warn(`CodeMapper could not load a cached index for ${folder.name}: ${String(error)}`);
				}
			}
		}
	}

	async indexAll(rebuild = false, selectedFolders = vscode.workspace.workspaceFolders ?? []): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (this.activeRun) {
			const missingFolders = selectedFolders.filter(folder => !this.activeFolderUris.has(folder.uri.toString()));
			if (!missingFolders.length) {
				return this.activeRun;
			}
			const currentRun = this.activeRun;
			return currentRun.catch(() => undefined).then(() => this.indexAll(rebuild, missingFolders));
		}
		const folders = selectedFolders;
		for (const folder of folders) {this.activeFolderUris.add(folder.uri.toString());}
		this.activeRun = Promise.resolve(vscode.window.withProgress({
			location: vscode.ProgressLocation.Window,
			title: 'CodeMapper: indexing workspace',
			cancellable: true,
		}, async (progress, token) => {
			this.status.text = '$(sync~spin) CodeMapper: indexing';
			const cancellation = token.onCancellationRequested(() => {
				for (const child of this.processes) {child.kill();}
			});
			let completed = 0;
			try {
				for (const folder of folders) {
					if (token.isCancellationRequested) {
						break;
					}
					progress.report({ message: `${folder.name} (${completed + 1}/${folders.length})` });
					await this.scanFolder(folder, () => token.isCancellationRequested);
					if (token.isCancellationRequested || this.disposed) {break;}
					completed++;
				}
				this.status.text = completed && this.totalFiles() ? `$(symbol-misc) CodeMapper: ${this.totalSymbols()} symbols` : '$(info) CodeMapper: no Python files';
			} catch (error) {
				if (token.isCancellationRequested) {
					this.status.text = this.totalFiles() ? `$(symbol-misc) CodeMapper: ${this.totalSymbols()} symbols` : '$(info) CodeMapper';
					return;
				}
				this.status.text = '$(error) CodeMapper: indexing failed';
				vscode.window.showErrorMessage(`CodeMapper could not index the workspace: ${String(error)}`);
				throw error;
			} finally {
				cancellation.dispose();
				this.activeRun = undefined;
				this.activeFolderUris.clear();
			}
		}));
		return this.activeRun;
	}

	async refreshFolder(folder: vscode.WorkspaceFolder): Promise<void> {
		await this.scanFolder(folder);
	}

	async removeFolder(folder: vscode.WorkspaceFolder): Promise<void> {
		await this.folderRuns.get(folder.uri.toString())?.catch(() => undefined);
		this.graphs.delete(folder.uri.toString());
		try {
			await fs.unlink(this.cachePath(folder));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const process of this.processes) {
			process.kill();
		}
		this.processes.clear();
		this.status.dispose();
	}

	private totalSymbols(): number {
		return [...this.graphs.values()].reduce((sum, graph) => sum + graph.nodes.filter(node => ['function', 'method', 'class'].includes(node.type)).length, 0);
	}

	private totalFiles(): number {
		return [...this.graphs.values()].reduce((sum, graph) => sum + Object.keys(graph.metadata.sourceHashes).length, 0);
	}

	private async scanFolder(folder: vscode.WorkspaceFolder, cancelled: () => boolean = () => false): Promise<void> {
		const key = folder.uri.toString();
		const previous = this.folderRuns.get(key);
		if (previous) {await previous.catch(() => undefined);}
		if (this.disposed || cancelled()) {return;}
		const run = (async () => {
			this.status.text = `$(sync~spin) CodeMapper: updating ${folder.name}`;
			const graph = await this.analyze(folder);
			if (this.disposed || cancelled() || !(vscode.workspace.workspaceFolders ?? []).some(item => item.uri.toString() === key)) {return;}
			await this.persist(folder, graph);
			this.graphs.set(key, graph);
			this.status.text = this.totalFiles()
				? `$(symbol-misc) CodeMapper: ${this.totalSymbols()} symbols`
				: '$(info) CodeMapper: no Python files';
			this.onUpdated(folder, graph);
		})();
		this.folderRuns.set(key, run);
		try {
			await run;
		} finally {
			if (this.folderRuns.get(key) === run) {this.folderRuns.delete(key);}
		}
	}

	private cachePath(folder: vscode.WorkspaceFolder): string {
		const key = createHash('sha256').update(folder.uri.toString()).digest('hex').slice(0, 20);
		return path.join(this.context.globalStorageUri.fsPath, `${key}.json`);
	}

	private async persist(folder: vscode.WorkspaceFolder, graph: CodeGraph): Promise<void> {
		const target = this.cachePath(folder);
		const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
		await fs.mkdir(path.dirname(target), { recursive: true });
		try {
			await fs.writeFile(temporary, JSON.stringify(graph), { encoding: 'utf8', mode: 0o600 });
			await fs.rename(temporary, target);
		} catch (error) {
			await fs.rm(temporary, { force: true });
			throw error;
		}
	}

	private async analyze(folder: vscode.WorkspaceFolder): Promise<CodeGraph> {
		const config = vscode.workspace.getConfiguration('codemapper', folder.uri);
		const pythonPath = config.get<string>('pythonPath', '');
		const executable = pythonPath || (process.platform === 'win32' ? 'py' : 'python3');
		const script = path.join(this.context.extensionPath, 'analyzers', 'python', 'analyze.py');
		const exclude = config.get<string[]>('exclude', []);
		const pythonFiles = await vscode.workspace.findFiles(
			new vscode.RelativePattern(folder, '**/*.py'),
			'**/{.git,.hg,.svn,.venv,venv,node_modules,__pycache__,build,dist,.tox,.mypy_cache,.pytest_cache}/**',
			1,
		);
		if (!pythonFiles.length) {
			const empty: CodeGraph = {
				metadata: {
					schemaVersion: 1,
					workspaceId: createHash('sha256').update(folder.uri.toString()).digest('hex').slice(0, 16),
					indexedAt: '',
					sourceHashes: {},
					diagnostics: [],
				},
				nodes: [],
				edges: [],
			};
			const previous = this.graphs.get(folder.uri.toString());
			empty.metadata.indexedAt = previous && !Object.keys(previous.metadata.sourceHashes).length
				? previous.metadata.indexedAt
				: new Date().toISOString();
			return empty;
		}
		const graph = await new Promise<CodeGraph>((resolve, reject) => {
			const args = executable === 'py' ? ['-3', script] : [script];
			const child = spawn(executable, args, { cwd: folder.uri.fsPath, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
			this.processes.add(child);
			let output = '';
			let errorOutput = '';
			let settled = false;
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => {
				output += chunk;
				if (output.length > 80 * 1024 * 1024 && !settled) {
					settled = true;
					child.kill();
					reject(new Error('Python analyzer output exceeded the 80 MB safety limit.'));
				}
			});
			child.stderr.on('data', (chunk: string) => { errorOutput = (errorOutput + chunk).slice(-32 * 1024); });
			child.stdin.on('error', error => {
				if (settled) {return;}
				settled = true;
				reject(new Error(`Could not send the analysis request to Python: ${error.message}`));
			});
			child.on('error', error => {
				this.processes.delete(child);
				settled = true;
				reject(new Error(`Python 3 was not found. Install Python 3 or set codemapper.pythonPath. (${error.message})`));
			});
			child.on('close', code => {
				this.processes.delete(child);
				if (settled) {return;}
				if (code !== 0) {
					settled = true;
					reject(new Error(`Python analyzer exited with code ${code}: ${errorOutput.trim() || 'no diagnostic output'}`));
					return;
				}
				try {
					settled = true;
					resolve(JSON.parse(output) as CodeGraph);
				} catch (error) {
					settled = true;
					reject(new Error(`Python analyzer returned invalid graph data: ${String(error)}`));
				}
			});
			child.stdin.end(JSON.stringify({ root: folder.uri.fsPath, exclude }));
		});
		const previous = this.graphs.get(folder.uri.toString());
		const previousHashes = previous?.metadata.sourceHashes ?? {};
		const currentHashes = graph.metadata.sourceHashes;
		const unchanged = previous && Object.keys(previousHashes).length === Object.keys(currentHashes).length &&
			Object.entries(previousHashes).every(([file, hash]) => currentHashes[file] === hash);
		graph.metadata.indexedAt = unchanged ? previous.metadata.indexedAt : new Date().toISOString();
		return graph;
	}
}
