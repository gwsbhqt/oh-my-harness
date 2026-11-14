"""仅打包共享 Python 源码，源码发布包携带同一份私有实现。"""
from pathlib import Path
from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        shared = Path(self.root).parent / "_shared" / "agentkit"
        if shared.is_dir():
            prefix = "src/" if self.target_name == "sdist" else ""
            for source in shared.rglob("*.py"):
                destination = prefix + "computer_use/_shared/agentkit/" + source.relative_to(shared).as_posix()
                build_data["force_include"][str(source)] = destination
