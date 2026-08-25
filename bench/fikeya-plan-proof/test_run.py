# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Fikeya contributors

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fikeya_plan_proof", HERE / "run.py")
assert SPEC is not None and SPEC.loader is not None
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class PlanToProofEvaluationTests(unittest.TestCase):
    def test_real_local_fixture_reaches_verified_proof_without_a_model(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fikeya-plan-proof-test-") as temporary:
            report = RUNNER.evaluate(Path(temporary))

        RUNNER.validate_report(report)
        self.assertEqual(report["schemaVersion"], RUNNER.SCHEMA_VERSION)
        self.assertTrue(report["overallPassed"])
        self.assertEqual(report["modelExecution"]["providerCalls"], 0)
        self.assertEqual(report["context"]["requestedMaxChars"], 8_000)
        self.assertEqual(report["context"]["reportedMaxChars"], 8_000)
        self.assertLessEqual(report["context"]["usedChars"], 8_000)
        self.assertNotEqual(report["baseline"]["python"]["exitCode"], 0)
        self.assertNotEqual(report["baseline"]["javascript"]["exitCode"], 0)
        self.assertEqual(report["verification"]["final"]["python"]["exitCode"], 0)
        self.assertEqual(report["verification"]["final"]["javascript"]["exitCode"], 0)
        self.assertEqual(report["plan"]["stepCount"], 4)
        self.assertEqual(report["plan"]["approvalCount"], 4)


if __name__ == "__main__":
    unittest.main()
