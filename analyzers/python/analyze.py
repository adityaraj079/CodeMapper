#!/usr/bin/env python3
"""Offline Python repository analyzer. Parses source with ast; never imports project code."""

import ast
import hashlib
import io
import json
import os
import sys
import tokenize
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def dotted(path):
    parts = list(path.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts) or path.stem


def annotation(node):
    return ast.unparse(node) if node is not None else None


def args_text(args):
    values = []
    positional = list(args.posonlyargs) + list(args.args)
    defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
    for index, (arg, default) in enumerate(zip(positional, defaults)):
        prefix = ""
        if args.posonlyargs and index == len(args.posonlyargs) - 1:
            suffix = "/"
        else:
            suffix = ""
        value = arg.arg
        if arg.annotation:
            value += ": " + annotation(arg.annotation)
        if default is not None:
            value += "=" + ast.unparse(default)
        values.append(prefix + value)
        if suffix:
            values.append(suffix)
    if args.vararg:
        values.append("*" + args.vararg.arg)
    elif args.kwonlyargs:
        values.append("*")
    for arg, default in zip(args.kwonlyargs, args.kw_defaults):
        value = arg.arg
        if arg.annotation:
            value += ": " + annotation(arg.annotation)
        if default is not None:
            value += "=" + ast.unparse(default)
        values.append(value)
    if args.kwarg:
        values.append("**" + args.kwarg.arg)
    return ", ".join(values)


def parameter_data(args):
    result = []
    positional = list(args.posonlyargs) + list(args.args)
    defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
    for index, (arg, default) in enumerate(zip(positional, defaults)):
        result.append({
            "name": arg.arg,
            "kind": "positionalOnly" if index < len(args.posonlyargs) else "positionalOrKeyword",
            "annotation": annotation(arg.annotation),
            "default": ast.unparse(default) if default is not None else None,
        })
    if args.vararg:
        result.append({"name": args.vararg.arg, "kind": "varPositional", "annotation": annotation(args.vararg.annotation), "default": None})
    for arg, default in zip(args.kwonlyargs, args.kw_defaults):
        result.append({
            "name": arg.arg,
            "kind": "keywordOnly",
            "annotation": annotation(arg.annotation),
            "default": ast.unparse(default) if default is not None else None,
        })
    if args.kwarg:
        result.append({"name": args.kwarg.arg, "kind": "varKeyword", "annotation": annotation(args.kwarg.annotation), "default": None})
    return result


def nested_functions(statements):
    for statement in statements:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield statement
            continue
        if isinstance(statement, ast.ClassDef):
            continue
        yield from nested_functions(ast.iter_child_nodes(statement))


def ignored(path, excludes, gitignore):
    rel = path.as_posix()
    for pattern in excludes:
        clean = pattern.strip().rstrip("/")
        if not clean:
            continue
        if rel == clean or rel.startswith(clean + "/") or Path(rel).match(clean):
            return True
        if clean in rel.split("/"):
            return True
    for pattern in gitignore:
        pattern = pattern.strip()
        if not pattern or pattern.startswith("#") or pattern.startswith("!"):
            continue
        pattern = pattern.lstrip("/").rstrip("/")
        if rel == pattern or rel.startswith(pattern + "/") or Path(rel).match(pattern):
            return True
    return False


class FunctionCalls(ast.NodeVisitor):
    def __init__(self, class_name, owner_node):
        self.class_name = class_name
        self.calls = []
        bindings = FunctionBindings()
        for statement in owner_node.body:
            bindings.visit(statement)
        args = owner_node.args
        parameters = {arg.arg for arg in args.posonlyargs + args.args + args.kwonlyargs}
        if args.vararg:
            parameters.add(args.vararg.arg)
        if args.kwarg:
            parameters.add(args.kwarg.arg)
        self.local_names = (bindings.names | parameters) - bindings.globals
        self.nested_function_names = bindings.nested_functions

    def visit_Call(self, node):
        name = ast.unparse(node.func)
        self.calls.append((name, node.lineno, self.class_name))
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        return

    def visit_AsyncFunctionDef(self, node):
        return


class FunctionBindings(ast.NodeVisitor):
    def __init__(self):
        self.names = set()
        self.globals = set()
        self.nonlocals = set()
        self.nested_functions = set()

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Store):
            self.names.add(node.id)

    def visit_FunctionDef(self, node):
        self.names.add(node.name)
        self.nested_functions.add(node.name)

    def visit_AsyncFunctionDef(self, node):
        self.names.add(node.name)
        self.nested_functions.add(node.name)

    def visit_ClassDef(self, node):
        self.names.add(node.name)

    def visit_Lambda(self, node):
        return

    def visit_Import(self, node):
        for alias in node.names:
            self.names.add(alias.asname or alias.name.split(".")[0])

    def visit_ImportFrom(self, node):
        for alias in node.names:
            if alias.name != "*":
                self.names.add(alias.asname or alias.name)

    def visit_Global(self, node):
        self.globals.update(node.names)

    def visit_Nonlocal(self, node):
        self.nonlocals.update(node.names)


def analyze(root, excludes):
    root = Path(root).resolve()
    gitignore = []
    try:
        gitignore = (root / ".gitignore").read_text(encoding="utf-8").splitlines()
    except OSError:
        pass
    skip_dirs = {".git", ".hg", ".svn", ".venv", "venv", "node_modules", "__pycache__", "build", "dist", ".tox", ".mypy_cache", ".pytest_cache"}
    walk_diagnostics = []

    def walk_error(error):
        filename = getattr(error, "filename", None)
        try:
            rel = Path(filename).relative_to(root).as_posix() if filename else "."
        except ValueError:
            rel = "."
        walk_diagnostics.append({"file": rel, "message": "Unable to scan directory because of a permission or I/O error."})

    paths = []
    for base, dirs, files in os.walk(root, onerror=walk_error):
        dirs[:] = sorted(d for d in dirs if d not in skip_dirs and not ignored(Path(base).relative_to(root) / d, excludes, gitignore))
        for filename in sorted(files):
            path = Path(base) / filename
            if filename.endswith(".py") and not ignored(path.relative_to(root), excludes, gitignore):
                paths.append(path)

    nodes, edges, diagnostics = [], [], walk_diagnostics
    hashes, parsed, module_ids, symbols = {}, {}, {}, {}
    import_maps, calls = {}, []
    file_ids = {}

    for path in paths:
        rel = path.relative_to(root).as_posix()
        module = dotted(path.relative_to(root))
        module_id = rel + "::<module>"
        file_id = rel + "::<file>"
        file_ids[rel] = file_id
        module_ids[module] = module_id
        try:
            data = path.read_bytes()
            encoding, _ = tokenize.detect_encoding(io.BytesIO(data).readline)
            text = data.decode(encoding)
            hashes[rel] = digest(data)
        except (OSError, UnicodeError, SyntaxError):
            diagnostics.append({"file": rel, "message": "Unable to read source file because of a permission or encoding error."})
            continue
        nodes.extend([
            {"id": module_id, "type": "module", "name": module.rsplit(".", 1)[-1], "qualifiedName": module, "file": rel, "hash": hashes[rel]},
            {"id": file_id, "type": "file", "name": Path(rel).name, "qualifiedName": rel, "file": rel, "hash": hashes[rel]},
        ])
        try:
            tree = ast.parse(text, filename=rel)
        except SyntaxError as error:
            diagnostics.append({"file": rel, "message": error.msg, "line": error.lineno})
            continue
        parsed[rel] = (tree, module)
        imported = {}
        for item in ast.walk(tree):
            if isinstance(item, ast.Import):
                for alias in item.names:
                    imported[alias.asname or alias.name.split(".")[0]] = ("module", alias.name)
            elif isinstance(item, ast.ImportFrom):
                base = "." * item.level + (item.module or "")
                resolved_module = resolve_import(module, base, item.level)
                for alias in item.names:
                    imported[alias.asname or alias.name] = ("symbol", resolved_module, alias.name)
        import_maps[rel] = imported
        symbols[module] = {}

        def add_function(node, parent_name="", parent_id=None, class_name=None):
            kind = "method" if class_name else "function"
            qualified = ".".join(part for part in (parent_name, node.name) if part)
            identifier = rel + "::" + qualified
            decorators = [ast.unparse(value) for value in node.decorator_list]
            signature = node.name + "(" + args_text(node.args) + ")"
            if node.returns:
                signature += " -> " + annotation(node.returns)
            node_record = {
                "id": identifier, "type": kind, "name": node.name, "qualifiedName": qualified,
                "file": rel, "startLine": node.lineno, "endLine": getattr(node, "end_lineno", node.lineno),
                "signature": signature, "parameters": parameter_data(node.args),
                "returnAnnotation": annotation(node.returns), "isAsync": isinstance(node, ast.AsyncFunctionDef), "decorators": decorators,
                "docstring": ast.get_docstring(node), "hash": hashes[rel],
            }
            nodes.append(node_record)
            if parent_id:
                edges.append({"source": parent_id, "target": identifier, "type": "CLASS_CONTAINS_METHOD", "resolution": "resolved", "sourceLine": node.lineno})
            else:
                edges.append({"source": file_ids[rel], "target": identifier, "type": "FILE_CONTAINS_FUNCTION", "resolution": "resolved", "sourceLine": node.lineno})
            if not parent_name:
                symbols[module].setdefault(node.name, []).append(identifier)
            for decorator in decorators:
                decorator_id = "decorator::" + decorator
                if not any(entry["id"] == decorator_id for entry in nodes):
                    nodes.append({"id": decorator_id, "type": "decorator", "name": decorator, "qualifiedName": decorator})
                edges.append({"source": identifier, "target": decorator_id, "type": "FUNCTION_DECORATED_BY", "resolution": "inferred", "sourceLine": node.lineno})
            visitor = FunctionCalls(class_name, node)
            for statement in node.body:
                visitor.visit(statement)
            calls.extend((identifier, rel, item[0], item[1], item[2], visitor.local_names, visitor.nested_function_names) for item in visitor.calls)
            for child in nested_functions(node.body):
                add_function(child, qualified, None, None)

        for statement in tree.body:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                add_function(statement)
            elif isinstance(statement, ast.ClassDef):
                class_id = rel + "::" + statement.name
                nodes.append({
                    "id": class_id, "type": "class", "name": statement.name, "qualifiedName": statement.name,
                    "file": rel, "startLine": statement.lineno, "endLine": getattr(statement, "end_lineno", statement.lineno),
                    "docstring": ast.get_docstring(statement), "hash": hashes[rel],
                })
                symbols[module].setdefault(statement.name, []).append(class_id)
                edges.append({"source": file_ids[rel], "target": class_id, "type": "FILE_CONTAINS_CLASS", "resolution": "resolved", "sourceLine": statement.lineno})
                for base in statement.bases:
                    base_name = ast.unparse(base)
                    # Resolved after all module symbols are collected.
                    edges.append({"source": class_id, "target": "base::" + module + "::" + base_name, "type": "CLASS_INHERITS_CLASS", "resolution": "unresolved", "sourceLine": base.lineno})
                for child in statement.body:
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        add_function(child, statement.name, class_id, statement.name)

    def lookup(module, name):
        candidates = symbols.get(module, {}).get(name, [])
        return candidates[0] if len(candidates) == 1 else None

    for rel, (tree, module) in parsed.items():
        import_edges = set()
        external_imports = set()
        imported = import_maps.get(rel, {})
        for alias, value in imported.items():
            if value[0] == "module":
                target_module = value[1]
            else:
                target_module = value[1]
            target_id = module_ids.get(target_module)
            if target_id and target_id != module_ids[module]:
                import_edges.add(target_id)
            elif not target_id and target_module:
                external_imports.add(target_module)
        for target_id in sorted(import_edges):
            edges.append({"source": module_ids[module], "target": target_id, "type": "MODULE_IMPORTS_MODULE", "resolution": "resolved"})
        for target_module in sorted(external_imports):
            target_id = "external::" + target_module
            if not any(item["id"] == target_id for item in nodes):
                nodes.append({"id": target_id, "type": "module", "name": target_module.rsplit(".", 1)[-1], "qualifiedName": target_module})
            edges.append({"source": module_ids[module], "target": target_id, "type": "MODULE_IMPORTS_MODULE", "resolution": "unresolved"})

        # Resolve class inheritance after all symbols exist.
        for edge in edges:
            if edge["type"] == "CLASS_INHERITS_CLASS" and edge["source"].startswith(rel + "::"):
                base_name = edge["target"].split("::", 2)[-1]
                target = lookup(module, base_name)
                if target is None:
                    for alias, value in imported.items():
                        if value[0] == "symbol" and value[2] == base_name:
                            target = lookup(value[1], base_name)
                            if target:
                                break
                if target:
                    edge["target"], edge["resolution"] = target, "resolved"
                else:
                    unresolved_id = "unresolved:" + edge["target"]
                    if not any(item["id"] == unresolved_id for item in nodes):
                        nodes.append({"id": unresolved_id, "type": "unresolved", "name": base_name, "qualifiedName": base_name, "file": rel})
                    edge["target"] = unresolved_id

    for source, rel, expression, line, class_name, local_names, nested_function_names in calls:
        module = next((mod for path, (_, mod) in parsed.items() if path == rel), "")
        imported = import_maps.get(rel, {})
        target = None
        resolution = "resolved"
        parts = expression.split(".")
        if len(parts) == 1:
            scoped_target = source + "." + parts[0]
            if parts[0] in local_names:
                if parts[0] in nested_function_names and any(node["id"] == scoped_target for node in nodes):
                    target = scoped_target
            else:
                target = lookup(module, parts[0])
                if target is None and parts[0] in imported and imported[parts[0]][0] == "symbol":
                    target = lookup(imported[parts[0]][1], imported[parts[0]][2])
        elif parts[0] in ("self", "cls") and class_name:
            target = rel + "::" + class_name + "." + parts[1]
            resolution = "inferred"
            if not any(node["id"] == target for node in nodes):
                target = None
        elif parts[0] in imported and parts[0] not in local_names:
            binding = imported[parts[0]]
            if binding[0] == "module":
                resolution = "inferred"
                module_parts = binding[1].split(".")
                if parts[0] == module_parts[0]:
                    requested_module_path = parts[1:-1]
                    if requested_module_path == module_parts[1:]:
                        target = lookup(binding[1], parts[-1])
                    elif not requested_module_path:
                        target = lookup(module_parts[0], parts[-1])
                else:
                    target = lookup(binding[1], parts[-1])
            else:
                target = lookup(binding[1], binding[2])
        if not target:
            resolution = "unresolved"
            target = "unresolved:" + rel + "::" + expression
            if not any(node["id"] == target for node in nodes):
                nodes.append({"id": target, "type": "unresolved", "name": expression, "qualifiedName": expression, "file": rel, "startLine": line, "endLine": line})
        edges.append({"source": source, "target": target, "type": "FUNCTION_CALLS_FUNCTION", "resolution": resolution, "sourceLine": line})

    # Explicit __main__ blocks and conventional main functions are best-effort entry points.
    for rel, (tree, module) in parsed.items():
        for node in ast.walk(tree):
            if isinstance(node, ast.If) and isinstance(node.test, ast.Compare) and ast.unparse(node.test) in ("__name__ == '__main__'", "'__main__' == __name__"):
                for call in ast.walk(node):
                    if isinstance(call, ast.Call) and isinstance(call.func, ast.Name):
                        target = lookup(module, call.func.id)
                        if target:
                            edges.append({"source": module_ids[module], "target": target, "type": "ENTRYPOINT_INVOKES_FUNCTION", "resolution": "inferred", "sourceLine": call.lineno})

    return {
        "metadata": {"schemaVersion": 1, "workspaceId": digest(str(root).encode())[:16],
                     "indexedAt": "", "sourceHashes": hashes, "diagnostics": diagnostics},
        "nodes": nodes, "edges": edges,
    }


def resolve_import(current, import_name, level):
    if level == 0:
        return import_name
    parts = current.split(".")
    # Relative imports resolve from the current package (or parent for each extra dot).
    package = parts if current.endswith(".__init__") else parts[:-1]
    keep = max(0, len(package) - level + 1)
    prefix = package[:keep]
    suffix = import_name.lstrip(".")
    return ".".join(prefix + ([suffix] if suffix else []))


def main():
    if not hasattr(ast, "unparse"):
        print("CodeMapper requires Python 3.9 or newer (ast.unparse is unavailable).", file=sys.stderr)
        return 2
    request = json.load(sys.stdin)
    graph = analyze(request["root"], request.get("exclude", []))
    json.dump(graph, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
