# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

from pathlib import Path
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class InstallerSmokeContractTests(unittest.TestCase):
    def test_smoke_install_never_silently_closes_a_running_user_app(self) -> None:
        script = (
            REPOSITORY_ROOT / "scripts/fikeya/verify-installer-smoke.ps1"
        ).read_text(encoding="utf-8")

        self.assertIn('"/NOCLOSEAPPLICATIONS"', script)
        self.assertIn('"/LOG=`"$installLog`""', script)

    def test_failed_install_reports_a_bounded_installer_log(self) -> None:
        script = (
            REPOSITORY_ROOT / "scripts/fikeya/verify-installer-smoke.ps1"
        ).read_text(encoding="utf-8")

        self.assertIn("Get-Content -LiteralPath $installLog -Tail 24", script)
        self.assertIn("Remove-Item -LiteralPath $installLog -Force", script)

    def test_installed_qarinah_bundle_is_verified_and_executed(self) -> None:
        smoke = (
            REPOSITORY_ROOT / "scripts/fikeya/verify-installer-smoke.ps1"
        ).read_text(encoding="utf-8")
        release = (
            REPOSITORY_ROOT / "scripts/fikeya/package-release.ps1"
        ).read_text(encoding="utf-8")

        self.assertIn('"sidecar\\qarinah-memory-view.mjs"', smoke)
        self.assertIn('"sidecar\\qarinah-runtime.json"', smoke)
        self.assertIn('$qarinahProcessInfo.Environment["ELECTRON_RUN_AS_NODE"] = "1"', smoke)
        self.assertIn('"qarinah.workspace-initialization.v1"', smoke)
        self.assertIn('Copy-Item -LiteralPath $stagedSidecar', release)
        self.assertIn('Copy-Item -LiteralPath $stagedSidecarReceipt', release)


if __name__ == "__main__":
    unittest.main()
