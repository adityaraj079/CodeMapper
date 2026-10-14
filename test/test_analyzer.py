import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ANALYZER = ROOT / "analyzers" / "python" / "analyze.py"
FIXTURE = ROOT / "src" / "test" / "fixtures" / "python"
SPEC = importlib.util.spec_from_file_location("codemapper_analyzer", ANALYZER)
analyzer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(analyzer)


class PythonAnalyzerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.graph = analyzer.analyze(FIXTURE, [])
        cls.nodes = {node["id"]: node for node in cls.graph["nodes"]}
        cls.edges = cls.graph["edges"]

    def test_extracts_classes_functions_async_methods_and_parameters(self):
        functions = [node for node in self.graph["nodes"] if node["type"] in ("function", "method")]
        names = {node["qualifiedName"] for node in functions}
        self.assertIn("entry", names)
        self.assertIn("async_entry", names)
        self.assertIn("Runner.run", names)
        self.assertIn("Runner.outer.nested", names)
        async_function = next(node for node in functions if node["qualifiedName"] == "async_entry")
        self.assertTrue(async_function["isAsync"])
        entry = next(node for node in functions if node["qualifiedName"] == "helper")
        self.assertEqual("value", entry["parameters"][0]["name"])
        self.assertEqual("str", entry["returnAnnotation"])
        decorated = next(node for node in functions if node["qualifiedName"] == "entry")
        self.assertEqual(["traced"], decorated["decorators"])
        self.assertEqual("function", self.nodes["pkg/app.py::entry"]["type"])

    def test_resolves_imported_and_module_aliased_calls(self):
        graph_edges = [edge for edge in self.edges if edge["type"] == "FUNCTION_CALLS_FUNCTION"]
        targets = {edge["target"] for edge in graph_edges if edge["resolution"] != "unresolved"}
        self.assertIn("pkg/service.py::helper", targets)
        self.assertIn("pkg/service.py::utility", targets)
        self.assertTrue(any(edge["target"] == "pkg/service.py::utility" and edge["resolution"] == "inferred" for edge in graph_edges))

    def test_resolves_relative_imports(self):
        edge = next(edge for edge in self.edges if edge["source"] == "pkg/relative.py::relative_call")
        self.assertEqual("pkg/service.py::helper", edge["target"])
        self.assertEqual("resolved", edge["resolution"])

    def test_calls_through_self_are_resolved(self):
        edge = next(edge for edge in self.edges if edge["source"] == "pkg/app.py::Runner.run")
        self.assertEqual("pkg/app.py::Runner.finish", edge["target"])
        self.assertEqual("inferred", edge["resolution"])

    def test_nested_function_calls_resolve_in_lexical_scope(self):
        edge = next(edge for edge in self.edges if edge["source"] == "pkg/app.py::Runner.outer" and edge["target"].endswith("Runner.outer.nested"))
        self.assertEqual("resolved", edge["resolution"])

    def test_unresolved_dynamic_calls_are_explicit(self):
        edge = next(edge for edge in self.edges if edge["source"] == "pkg/app.py::entry" and "runtime_target" in edge["target"])
        self.assertEqual("unresolved", edge["resolution"])
        self.assertEqual("unresolved:pkg/app.py::runtime_target", edge["target"])
        self.assertEqual("unresolved", self.nodes[edge["target"]]["type"])

    def test_local_parameter_shadowing_does_not_resolve_imported_function(self):
        edge = next(edge for edge in self.edges if edge["source"] == "pkg/app.py::shadowed")
        self.assertEqual("unresolved", edge["resolution"])
        self.assertIn("helper", edge["target"])

    def test_records_imports_and_circular_dependency(self):
        module_edges = [edge for edge in self.edges if edge["type"] == "MODULE_IMPORTS_MODULE"]
        pairs = {(edge["source"], edge["target"]) for edge in module_edges}
        self.assertIn(("pkg/app.py::<module>", "pkg/service.py::<module>"), pairs)
        self.assertIn(("pkg/service.py::<module>", "pkg/app.py::<module>"), pairs)
        self.assertIn(("pkg/app.py::<module>", "external::os"), pairs)

    def test_syntax_error_does_not_fail_other_files(self):
        diagnostic = next(item for item in self.graph["metadata"]["diagnostics"] if item["file"] == "pkg/broken.py")
        self.assertTrue(diagnostic["message"])
        self.assertIn("pkg/service.py::helper", self.nodes)

    def test_graph_serializes_with_canonical_metadata(self):
        decoded = json.loads(json.dumps(self.graph))
        self.assertEqual(1, decoded["metadata"]["schemaVersion"])
        self.assertIn("pkg/app.py", decoded["metadata"]["sourceHashes"])
        self.assertTrue(decoded["metadata"]["workspaceId"])
        self.assertTrue(decoded["edges"])

    def test_entry_point_is_detected(self):
        edges = [edge for edge in self.edges if edge["type"] == "ENTRYPOINT_INVOKES_FUNCTION"]
        self.assertTrue(any(edge["target"] == "pkg/app.py::entry" for edge in edges))

    def test_modified_file_changes_its_hash_and_facts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            shutil.copytree(FIXTURE, root)
            before = analyzer.analyze(root, [])
            target = root / "pkg" / "service.py"
            target.write_text(target.read_text() + "\n\ndef added():\n    return 3\n", encoding="utf-8")
            after = analyzer.analyze(root, [])
            self.assertNotEqual(before["metadata"]["sourceHashes"]["pkg/service.py"], after["metadata"]["sourceHashes"]["pkg/service.py"])
            self.assertIn("pkg/service.py::added", {node["id"] for node in after["nodes"]})

    def test_deleted_file_relationships_are_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            shutil.copytree(FIXTURE, root)
            (root / "pkg" / "service.py").unlink()
            graph = analyzer.analyze(root, [])
            self.assertFalse(any("pkg/service.py" in node["id"] for node in graph["nodes"]))
            self.assertFalse(any("pkg/service.py" in edge["source"] or "pkg/service.py" in edge["target"] for edge in graph["edges"]))

    def test_unchanged_input_produces_stable_graph(self):
        first = analyzer.analyze(FIXTURE, [])
        second = analyzer.analyze(FIXTURE, [])
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
