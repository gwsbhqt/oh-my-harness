"""Bundle the shared CLI adapter; source archives carry the same implementation."""
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        shared = Path(self.root).parent / "_shared/agentkit/cli.py"
        if shared.is_file():
            prefix = "src/" if self.target_name == "sdist" else ""
            build_data["force_include"][str(shared)] = prefix + "shot_sheet/_cli_adapter.py"
        elif not (Path(self.root) / "src/shot_sheet/_cli_adapter.py").is_file():
            raise RuntimeError("Build from the checkout with skills/_shared, or from the complete source archive")
