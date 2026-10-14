export type NodeType = 'workspace' | 'module' | 'file' | 'class' | 'function' | 'method' | 'decorator' | 'unresolved';
export type Resolution = 'resolved' | 'inferred' | 'unresolved';

export interface ParameterInfo {
	name: string;
	kind: 'positionalOnly' | 'positionalOrKeyword' | 'varPositional' | 'keywordOnly' | 'varKeyword';
	annotation?: string | null;
	default?: string | null;
}

export interface GraphNode {
	id: string;
	type: NodeType;
	name: string;
	qualifiedName: string;
	file?: string;
	startLine?: number;
	endLine?: number;
	signature?: string;
	parameters?: ParameterInfo[];
	returnAnnotation?: string | null;
	isAsync?: boolean;
	decorators?: string[];
	docstring?: string | null;
	hash?: string;
}

export interface GraphEdge {
	source: string;
	target: string;
	type: 'FILE_CONTAINS_FUNCTION' | 'FILE_CONTAINS_CLASS' | 'CLASS_CONTAINS_METHOD' |
		'MODULE_IMPORTS_MODULE' | 'FUNCTION_CALLS_FUNCTION' | 'CLASS_INHERITS_CLASS' |
		'FUNCTION_DECORATED_BY' | 'ENTRYPOINT_INVOKES_FUNCTION';
	resolution: Resolution;
	sourceLine?: number;
}

export interface FileDiagnostic {
	file: string;
	message: string;
	line?: number;
}

export interface GraphMetadata {
	schemaVersion: 1;
	workspaceId: string;
	indexedAt: string;
	sourceHashes: Record<string, string>;
	diagnostics: FileDiagnostic[];
}

export interface CodeGraph {
	metadata: GraphMetadata;
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export function callersOf(graph: CodeGraph, id: string): GraphEdge[] {
	return graph.edges.filter(edge => edge.type === 'FUNCTION_CALLS_FUNCTION' && edge.target === id);
}

export function calleesOf(graph: CodeGraph, id: string): GraphEdge[] {
	return graph.edges.filter(edge => edge.type === 'FUNCTION_CALLS_FUNCTION' && edge.source === id);
}
