import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { CodeGraph, GraphNode } from '../models/graph';

export class GraphPanel implements vscode.Disposable {
	private readonly panels = new Map<vscode.WebviewPanel, { folder: vscode.WorkspaceFolder; graph: CodeGraph; maxNodes: number }>();

	constructor(private readonly context: vscode.ExtensionContext, private readonly openNode: (node: GraphNode, folder: vscode.WorkspaceFolder) => Promise<void>) {}

	open(folder: vscode.WorkspaceFolder, graph: CodeGraph, maxNodes: number): void {
		const panel = vscode.window.createWebviewPanel(
			'codemapper.graph',
			`CodeMapper: ${folder.name}`,
			vscode.ViewColumn.Active,
			{ enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'node_modules', 'cytoscape', 'dist'))] },
		);
		const state = { folder, graph, maxNodes };
		this.panels.set(panel, state);
		panel.webview.html = this.html(panel.webview, state);
		panel.onDidDispose(() => this.panels.delete(panel));
		panel.webview.onDidReceiveMessage(async message => {
			if (message.command === 'open' && typeof message.id === 'string') {
				const current = this.panels.get(panel);
				const node = current?.graph.nodes.find(item => item.id === message.id);
				if (node && current) {await this.openNode(node, current.folder);}
			}
		});
	}

	refresh(folder?: vscode.WorkspaceFolder, graph?: CodeGraph): void {
		for (const [panel, state] of this.panels) {
			if (folder && state.folder.uri.toString() !== folder.uri.toString()) {continue;}
			if (graph) {state.graph = graph;}
			panel.webview.html = this.html(panel.webview, state);
		}
	}

	dispose(): void {
		for (const panel of this.panels.keys()) {panel.dispose();}
		this.panels.clear();
	}

	private html(webview: vscode.Webview, state: { folder: vscode.WorkspaceFolder; graph: CodeGraph; maxNodes: number }): string {
		const { folder, graph, maxNodes } = state;
		const nonce = randomBytes(16).toString('base64');
		const cytoscape = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js')));
		const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};`;
		const json = JSON.stringify(graph).replace(/</g, '\\u003c');
		return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>CodeMapper graph</title>
<style>
html,body{height:100%;margin:0;padding:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}
body{display:flex;flex-direction:column}#toolbar{display:flex;gap:8px;padding:10px;align-items:center;border-bottom:1px solid var(--vscode-panel-border)}
input,select,button{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:6px}
button{cursor:pointer}#status{font-size:12px;opacity:.8}#graph{flex:1;min-height:200px}
</style></head><body>
<div id="toolbar"><strong>CodeMapper · ${escapeHtml(folder.name)}</strong>
<select id="mode"><option value="calls">Function calls</option><option value="modules">Module dependencies</option></select>
<input id="search" placeholder="Search symbol or module" aria-label="Search graph">
<button id="focus">Focus selected neighborhood</button><button id="fit">Fit</button><span id="details"></span><span id="status"></span></div>
<div id="graph"></div>
<script nonce="${nonce}" src="${cytoscape}"></script>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(), graph=${json}, cap=${Math.max(1, maxNodes)};
const nodeMap=new Map(graph.nodes.map(n=>[n.id,n]));
const status=document.getElementById('status');
const details=document.getElementById('details');
const fg=getComputedStyle(document.body).getPropertyValue('--vscode-foreground').trim()||'#ddd';
const edgeColor=getComputedStyle(document.body).getPropertyValue('--vscode-descriptionForeground').trim()||'#888';
const focusColor=getComputedStyle(document.body).getPropertyValue('--vscode-focusBorder').trim()||'#3794ff';
const cy=cytoscape({container:document.getElementById('graph'),elements:[],style:[
{selector:'node',style:{'label':'data(label)','font-size':11,'color':fg,'text-wrap':'ellipsis','text-max-width':140,'background-color':'data(color)','width':24,'height':24,'border-width':1,'border-color':edgeColor}},
{selector:'edge',style:{'width':1,'line-color':edgeColor,'target-arrow-color':edgeColor,'target-arrow-shape':'triangle','curve-style':'bezier','label':'data(label)','font-size':8,'color':fg,'text-background-opacity':0}},
{selector:'.faded',style:{'opacity':0.12}},{selector:'.selected-neighborhood',style:{'border-width':3,'border-color':focusColor}}
],layout:{name:'cose',animate:false}});
let selected=null, mode='calls';
function render(focus){
 mode=document.getElementById('mode').value;
 const search=document.getElementById('search').value.toLowerCase();
 const allowed=mode==='calls'?new Set(['function','method','unresolved']):new Set(['module']);
 let ns=graph.nodes.filter(n=>allowed.has(n.type)).sort((a,b)=>a.id.localeCompare(b.id));
 const total=ns.length;
 if(search) ns=ns.filter(n=>(n.name+' '+n.qualifiedName+' '+(n.signature||'')+' '+(n.file||'')).toLowerCase().includes(search));
 const matching=ns.length; ns=ns.slice(0,cap);
 const included=new Set(ns.map(n=>n.id));
 const edgeType=mode==='calls'?'FUNCTION_CALLS_FUNCTION':'MODULE_IMPORTS_MODULE';
 let es=graph.edges.filter(e=>e.type===edgeType&&included.has(e.source)&&included.has(e.target));
 let focusedId=focus||null;
 if(focusedId&&included.has(focusedId)){
  const neighborhood=new Set([focusedId]);
  for(const e of es) if(e.source===focusedId||e.target===focusedId){neighborhood.add(e.source);neighborhood.add(e.target);}
  ns=ns.filter(n=>neighborhood.has(n.id)); es=es.filter(e=>neighborhood.has(e.source)&&neighborhood.has(e.target));
 }
 const elements=[
  ...ns.map(n=>({data:{id:n.id,label:n.name+(n.signature?'\\n'+n.signature:''),color:n.type==='unresolved'?'#d05a5a':n.type==='module'?'#4c9bd6':'#45a37a',type:n.type,file:n.file,line:n.startLine}})),
  ...es.map((e,i)=>({data:{id:'e'+i,source:e.source,target:e.target,label:e.resolution,type:e.type,resolution:e.resolution,sourceLine:e.sourceLine}}))
 ];
 cy.elements().remove(); cy.add(elements);
 if(focusedId) cy.getElementById(focusedId).addClass('selected-neighborhood');
 cy.layout({name:'cose',animate:false,fit:true,padding:30,randomize:true}).run();
 status.text=(search?'Showing '+Math.min(matching,cap)+' of '+matching+' matching nodes':'Showing '+Math.min(total,cap)+' of '+total+' nodes')+(matching>cap?' · use a narrower search':'');
 if(graph.metadata.diagnostics.length) status.text+=' · '+graph.metadata.diagnostics.length+' diagnostic(s)';
}
cy.on('tap','node',event=>{selected=event.target.id();const n=nodeMap.get(selected);details.innerText=n?(n.qualifiedName+' · '+n.type+' · '+(n.file||'')+':'+(n.startLine||'')):selected;vscode.postMessage({command:'open',id:selected});});
cy.on('tap','edge',event=>{const e=event.target;details.innerText=e.data('type')+' · '+e.data('resolution')+(e.data('sourceLine')?' · line '+e.data('sourceLine'):'');});
document.getElementById('mode').addEventListener('change',()=>render());
document.getElementById('search').addEventListener('input',()=>render());
document.getElementById('focus').addEventListener('click',()=>render(selected));
document.getElementById('fit').addEventListener('click',()=>cy.fit(undefined,30));
render();
</script></body></html>`;
	}
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
