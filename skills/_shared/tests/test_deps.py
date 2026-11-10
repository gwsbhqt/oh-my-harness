"""agentkit/deps.py：找 computer-control 技能目录的规则和缺失时的报错。"""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

SHARED = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SHARED))
from agentkit import deps  # noqa: E402


class Deps(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        # 隔离 sys.path 和已加载模块，让测试里加载的假包不影响真实的同名包。
        modules = mock.patch.dict(sys.modules)
        path = mock.patch.object(sys, "path", list(sys.path))
        modules.start()
        path.start()
        self.addCleanup(modules.stop)
        self.addCleanup(path.stop)
        for name in [n for n in sys.modules if n.split(".")[0] == "computer_control"]:
            del sys.modules[name]

    def test_default_follows_real_path_through_symlink(self):
        link = self.root / "skills-link"
        link.symlink_to(SHARED, target_is_directory=True)
        spec = importlib.util.spec_from_file_location("deps_via_link", link / "agentkit" / "deps.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.SKILLS, SHARED.parent)
        self.assertTrue((module.SKILLS / "computer-control" / "src" / "computer_control" / "__init__.py").is_file())

    def test_computer_control_env_override_and_missing(self):
        package = self.root / "src" / "computer_control"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("WHERE = 'override'\n")
        with mock.patch.dict(os.environ, {"COMPUTER_CONTROL_SKILL": str(self.root)}):
            self.assertEqual(deps.computer_control().WHERE, "override")
        with mock.patch.dict(os.environ, {"COMPUTER_CONTROL_SKILL": str(self.root / "absent")}):
            with self.assertRaisesRegex(ImportError, "computer-control"):
                deps.computer_control()


    def test_installed_package_uses_the_same_canonical_import(self):
        with (mock.patch.object(deps, "SKILLS", self.root / "wheel-layout"),
              mock.patch.dict(os.environ, {}, clear=True),
              mock.patch.object(deps.importlib, "import_module", return_value="installed") as load):
            self.assertEqual(deps.computer_control(), "installed")
            load.assert_called_once_with("computer_control")

    def test_installed_package_does_not_hide_a_missing_nested_dependency(self):
        missing = ModuleNotFoundError("missing dependency", name="required_dependency")
        with (mock.patch.object(deps, "SKILLS", self.root / "wheel-layout"),
              mock.patch.dict(os.environ, {}, clear=True),
              mock.patch.object(deps.importlib, "import_module", side_effect=missing)):
            with self.assertRaises(ModuleNotFoundError) as failure:
                deps.computer_control()
            self.assertIs(failure.exception, missing)


if __name__ == "__main__":
    unittest.main()
