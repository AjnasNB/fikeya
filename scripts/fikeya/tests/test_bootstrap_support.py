# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPT_DIRECTORY))

import bootstrap_support  # noqa: E402


class VersionTests(unittest.TestCase):
    def test_parses_common_tool_output(self) -> None:
        results = {
            value: bootstrap_support.parse_version(value)
            for value in ("v24.15.0", "Python 3.10.18", "npm 11.12.1")
        }

        self.assertEqual(
            results,
            {
                "v24.15.0": (24, 15, 0),
                "Python 3.10.18": (3, 10, 18),
                "npm 11.12.1": (11, 12, 1),
            },
        )

    def test_rejects_incomplete_version(self) -> None:
        with self.assertRaisesRegex(bootstrap_support.BootstrapError, "could not parse"):
            bootstrap_support.parse_version("Node 24")

    def test_enforces_node_release_lines(self) -> None:
        requirements = {
            "allowedMajors": [22, 24, 26],
            "minimumByMajor": {"22": "22.13.0"},
        }
        results = {
            "22.12": self._node_result("v22.12.0", requirements),
            "22.13": self._node_result("v22.13.0", requirements),
            "23": self._node_result("v23.11.1", requirements),
            "24": self._node_result("v24.0.0", requirements),
        }

        self.assertEqual(
            results,
            {
                "22.12": "Node 22.12.0 is too old; Node 22.13.0 or newer is required",
                "22.13": "22.13.0",
                "23": "Node 23.11.1 is unsupported; use a maintained Fikeya line: 22, 24, 26",
                "24": "24.0.0",
            },
        )

    def test_enforces_python_range(self) -> None:
        requirements = {"minimum": "3.10.0", "maximumExclusive": "4.0.0"}
        results = {
            value: self._python_result(value, requirements)
            for value in ("Python 3.9.19", "Python 3.10.0", "Python 3.14.2", "Python 4.0.0")
        }

        self.assertEqual(
            results,
            {
                "Python 3.9.19": "Python 3.9.19 is unsupported; use Python >=3.10.0 and <4.0.0",
                "Python 3.10.0": "3.10.0",
                "Python 3.14.2": "3.14.2",
                "Python 4.0.0": "Python 4.0.0 is unsupported; use Python >=3.10.0 and <4.0.0",
            },
        )

    @staticmethod
    def _node_result(value: str, requirements: dict[str, object]) -> str:
        try:
            return bootstrap_support.validate_node_version(value, requirements)
        except bootstrap_support.BootstrapError as error:
            return str(error)

    @staticmethod
    def _python_result(value: str, requirements: dict[str, str]) -> str:
        try:
            return bootstrap_support.validate_python_version(value, requirements)
        except bootstrap_support.BootstrapError as error:
            return str(error)


class PathTests(unittest.TestCase):
    def test_resolves_complete_checkout_and_stable_cache_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = self._create_checkout(Path(temporary) / "checkout")
            cache_base = Path(temporary) / "cache base"

            resolved = bootstrap_support.resolve_project_root(root)
            first = bootstrap_support.resolve_cache_path(resolved, str(cache_base))
            second = bootstrap_support.resolve_cache_path(resolved, str(cache_base))

            self.assertEqual(
                {
                    "root": resolved,
                    "stable": first == second,
                    "parent": first.parent,
                    "created": first.exists(),
                },
                {
                    "root": root.resolve(),
                    "stable": True,
                    "parent": cache_base.resolve() / "public-beta",
                    "created": False,
                },
            )

    def test_rejects_incomplete_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "checkout"
            root.mkdir()

            with self.assertRaisesRegex(bootstrap_support.BootstrapError, "missing"):
                bootstrap_support.resolve_project_root(root)

    def test_rejects_filesystem_root_as_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = self._create_checkout(Path(temporary) / "checkout")
            filesystem_root = Path(root.anchor)

            with self.assertRaisesRegex(bootstrap_support.BootstrapError, "filesystem root"):
                bootstrap_support.resolve_cache_path(root.resolve(), str(filesystem_root))

    def test_validate_command_is_read_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = self._create_checkout(Path(temporary) / "checkout")
            cache_base = Path(temporary) / "cache-does-not-exist"
            output = io.StringIO()

            with contextlib.redirect_stdout(output):
                result = bootstrap_support.main(
                    [
                        "validate",
                        "--root",
                        str(root),
                        "--cache-root",
                        str(cache_base),
                        "--node-version",
                        "v24.15.0",
                        "--npm-version",
                        "11.12.1",
                        "--python-version",
                        "Python 3.10.18",
                    ]
                )

            self.assertEqual(
                {
                    "result": result,
                    "cacheCreated": cache_base.exists(),
                    "lastLine": output.getvalue().splitlines()[-1],
                },
                {
                    "result": 0,
                    "cacheCreated": False,
                    "lastLine": "[check] isolated cache target: ok",
                },
            )

    @staticmethod
    def _create_checkout(root: Path) -> Path:
        (root / "fikeya-agent-core").mkdir(parents=True)
        (root / "fikeya-runtime").mkdir(parents=True)
        (root / "packages" / "fikeya-protocol").mkdir(parents=True)
        (root / "integrations" / "qarinah-sidecar").mkdir(parents=True)
        (root / "scripts" / "fikeya").mkdir(parents=True)
        (root / "product.json").write_text("{}\n", encoding="utf-8")
        (root / "fikeya-agent-core" / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        (root / "fikeya-runtime" / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        (root / "packages" / "fikeya-protocol" / "package-lock.json").write_text(
            "{}\n", encoding="utf-8"
        )
        (root / "integrations" / "qarinah-sidecar" / "package-lock.json").write_text(
            "{}\n", encoding="utf-8"
        )
        (root / "scripts" / "fikeya" / "runtime-constraints.txt").write_text(
            "keyring==25.7.0\n", encoding="utf-8"
        )
        manifest = {
            "schemaVersion": 1,
            "channel": "public-beta",
            "requirements": {
                "node": {"allowedMajors": [22, 24, 26], "minimumByMajor": {"22": "22.13.0"}},
                "python": {"minimum": "3.10.0", "maximumExclusive": "4.0.0"},
            },
            "components": [
                {
                    "id": "runtime",
                    "kind": "python",
                    "path": "fikeya-runtime",
                    "version": "0.1.0b8",
                    "constraints": "scripts/fikeya/runtime-constraints.txt",
                }
            ],
        }
        (root / "scripts" / "fikeya" / "components.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )
        return root


if __name__ == "__main__":
    unittest.main()
