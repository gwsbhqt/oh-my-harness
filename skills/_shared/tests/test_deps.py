"""agentkit/deps.py：配套技能源码、显式路径和安装包的加载契约。"""
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
        for name in [n for n in sys.modules if n.split(".")[0] in {"computer_use", "browser_use"}]:
            del sys.modules[name]

    def test_default_follows_real_path_through_symlink(self):
        link = self.root / "skills-link"
        link.symlink_to(SHARED, target_is_directory=True)
        spec = importlib.util.spec_from_file_location("deps_via_link", link / "agentkit" / "deps.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.SKILLS, SHARED.parent)
        for name in ("computer_use", "browser_use"):
            self.assertTrue((module.SKILLS / name.replace("_", "-") / "src" / name / "__init__.py").is_file())

    def test_computer_use_env_override_and_missing(self):
        package = self.root / "src" / "computer_use"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("WHERE = 'override'\n")
        with mock.patch.dict(os.environ, {"COMPUTER_USE_SKILL": str(self.root)}):
            self.assertEqual(deps.computer_use().WHERE, "override")
        with mock.patch.dict(os.environ, {"COMPUTER_USE_SKILL": str(self.root / "absent")}):
            with self.assertRaisesRegex(ImportError, "computer-use"):
                deps.computer_use()


    def test_browser_use_env_override_and_missing(self):
        package = self.root / "src" / "browser_use"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("WHERE = 'override'\n")
        with mock.patch.dict(os.environ, {"BROWSER_USE_SKILL": str(self.root)}):
            self.assertEqual(deps.browser_use().WHERE, "override")
        with mock.patch.dict(os.environ, {"BROWSER_USE_SKILL": str(self.root / "absent")}):
            with self.assertRaisesRegex(ImportError, "browser-use"):
                deps.browser_use()

    def test_browser_use_installed_import_and_missing_nested_dependency(self):
        with (mock.patch.object(deps, "SKILLS", self.root / "wheel-layout"),
              mock.patch.dict(os.environ, {}, clear=True),
              mock.patch.object(deps.importlib, "import_module", return_value="installed") as load):
            self.assertEqual(deps.browser_use(), "installed")
            load.assert_called_once_with("browser_use")
        for missing, expected in ((ModuleNotFoundError("missing", name="browser_use"), ImportError),
                                  (ModuleNotFoundError("missing", name="required_dependency"), ModuleNotFoundError)):
            with (self.subTest(dependency=missing.name),
                  mock.patch.object(deps, "SKILLS", self.root / "wheel-layout"),
                  mock.patch.dict(os.environ, {}, clear=True),
                  mock.patch.object(deps.importlib, "import_module", side_effect=missing)):
                with self.assertRaises(expected) as failure:
                    deps.browser_use()
                if expected is ModuleNotFoundError:
                    self.assertIs(failure.exception, missing)

    def test_installed_package_uses_the_same_canonical_import(self):
        with (mock.patch.object(deps, "SKILLS", self.root / "wheel-layout"),
              mock.patch.dict(os.environ, {}, clear=True),
              mock.patch.object(deps.importlib, "import_module", return_value="installed") as load):
            self.assertEqual(deps.computer_use(), "installed")
            load.assert_called_once_with("computer_use")

    def test_installed_package_does_not_hide_a_missing_nested_dependency(self):
        missing = ModuleNotFoundError("missing dependency", name="required_dependency")
        with (mock.patch.object(deps, "SKILLS", self.root / "wheel-layout"),
              mock.patch.dict(os.environ, {}, clear=True),
              mock.patch.object(deps.importlib, "import_module", side_effect=missing)):
            with self.assertRaises(ModuleNotFoundError) as failure:
                deps.computer_use()
            self.assertIs(failure.exception, missing)


if __name__ == "__main__":
    unittest.main()
