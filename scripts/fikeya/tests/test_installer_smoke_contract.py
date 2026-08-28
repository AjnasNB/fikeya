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


if __name__ == "__main__":
    unittest.main()
