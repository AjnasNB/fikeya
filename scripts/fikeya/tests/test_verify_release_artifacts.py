# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.fikeya.package_qarinah_sidecar import package_sidecar
from scripts.fikeya.verify_release_artifacts import (
    CHECKSUM_NAME,
    CLI_INSTALL_NAME,
    CLI_INSTALL_SCRIPT_NAME,
    MANIFEST_NAME,
    PYTHON_DISTRIBUTIONS,
    ReleaseIdentity,
    ReleaseVerificationError,
    verify_release_artifacts,
)

PUBLIC_VERSION = "0.1.0-beta.8"
EXTENSION_VERSION = "0.1.0-beta.8"
EXPECTED_COMMIT = "a" * 40


class ReleaseArtifactVerificationTests(unittest.TestCase):
    def test_final_signing_sparse_checkout_can_import_direct_verifier(self) -> None:
        repository_root = Path(__file__).resolve().parents[3]
        workflow = (
            repository_root / ".github" / "workflows" / "fikeya-release.yml"
        ).read_text(encoding="utf-8")
        for required in (
            "scripts/fikeya/verify_release_artifacts.py",
            "scripts/fikeya/package_qarinah_sidecar.py",
            "fikeya-runtime/src/fikeya_runtime/**",
        ):
            self.assertIn(required, workflow)

        with tempfile.TemporaryDirectory() as temporary_directory:
            sparse_root = Path(temporary_directory)
            for relative in (
                Path("scripts/fikeya/verify_release_artifacts.py"),
                Path("scripts/fikeya/package_qarinah_sidecar.py"),
            ):
                destination = sparse_root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(repository_root / relative, destination)
            shutil.copytree(
                repository_root / "fikeya-runtime" / "src" / "fikeya_runtime",
                sparse_root / "fikeya-runtime" / "src" / "fikeya_runtime",
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    str(sparse_root / "scripts/fikeya/verify_release_artifacts.py"),
                    "--help",
                ],
                cwd=sparse_root,
                capture_output=True,
                check=False,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn(
                "Verify the complete Fikeya release artifact set", completed.stdout
            )

    def test_accepts_exact_unsigned_beta_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            identity = _build_release(root, include_installer=True)

            report = verify_release_artifacts(
                root,
                identity,
                expected_commit=EXPECTED_COMMIT,
                require_installer=True,
                windows_metadata_reader=lambda _: _installer_metadata(identity),
            )

            self.assertTrue(report["ok"])
            self.assertEqual(report["installerAuthenticodeStatus"], "NotSigned")
            self.assertEqual(report["artifactCount"], 14)

    def test_accepts_artifact_set_without_optional_installer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            identity = _build_release(root, include_installer=False)

            report = verify_release_artifacts(
                root, identity, expected_commit=EXPECTED_COMMIT
            )

            self.assertEqual(report["installerAuthenticodeStatus"], "not-present")

    def test_rejects_wrong_wheel_metadata_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            identity = _build_release(root)
            wheel = root / f"fikeya_runtime-{identity.python_version}-py3-none-any.whl"
            _write_wheel(wheel, "fikeya-runtime", "9.9.9")

            with self.assertRaisesRegex(ReleaseVerificationError, "metadata version"):
                verify_release_artifacts(
                    root, identity, expected_commit=EXPECTED_COMMIT
                )

    def test_rejects_vsix_without_pre_release_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            identity = _build_release(root)
            vsix = (
                root
                / f"fikeya-desktop-{identity.extension_version}-{identity.platform}.vsix"
            )
            _write_vsix(vsix, identity, pre_release=False)

            with self.assertRaisesRegex(ReleaseVerificationError, "not marked"):
                verify_release_artifacts(
                    root, identity, expected_commit=EXPECTED_COMMIT
                )

    def test_rejects_cli_wheel_that_differs_from_top_level_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            identity = _build_release(root)
            wheel = root / f"fikeya_runtime-{identity.python_version}-py3-none-any.whl"
            wheel.write_bytes(wheel.read_bytes() + b"changed")

            with self.assertRaisesRegex(ReleaseVerificationError, "bytes that differ"):
                verify_release_artifacts(
                    root, identity, expected_commit=EXPECTED_COMMIT
                )

    def test_rejects_manifest_digest_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            identity = _build_release(root)
            manifest_path = root / MANIFEST_NAME
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["artifacts"][0]["sha256"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            with self.assertRaisesRegex(ReleaseVerificationError, "wrong SHA-256"):
                verify_release_artifacts(
                    root, identity, expected_commit=EXPECTED_COMMIT
                )

    def test_rejects_checksum_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            identity = _build_release(root)
            checksum_path = root / CHECKSUM_NAME
            lines = checksum_path.read_text(encoding="ascii").splitlines()
            digest, name = lines[0].split("  ", 1)
            lines[0] = f"{'0' * len(digest)}  {name}"
            checksum_path.write_text("\n".join(lines) + "\n", encoding="ascii")

            with self.assertRaisesRegex(ReleaseVerificationError, "wrong digest"):
                verify_release_artifacts(
                    root, identity, expected_commit=EXPECTED_COMMIT
                )

    def test_rejects_wrong_installer_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            identity = _build_release(root, include_installer=True)
            metadata = dict(_installer_metadata(identity))
            metadata["productVersionRaw"] = "1.136.0.0"

            with self.assertRaisesRegex(ReleaseVerificationError, "productVersionRaw"):
                verify_release_artifacts(
                    root,
                    identity,
                    expected_commit=EXPECTED_COMMIT,
                    require_installer=True,
                    windows_metadata_reader=lambda _: metadata,
                )

    def test_rejects_signed_installer_without_timestamp_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            identity = _build_release(root, include_installer=True)
            metadata = dict(_installer_metadata(identity))
            metadata["authenticodeStatus"] = "Valid"
            metadata["signer"] = "CN=Fikeya Test Signer"
            manifest_path = root / MANIFEST_NAME
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            installer_record = next(
                record
                for record in manifest["artifacts"]
                if record["name"].endswith(".exe")
            )
            installer_record["authenticodeStatus"] = "Valid"
            installer_record["signer"] = "CN=Fikeya Test Signer"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            _rewrite_checksums(root)

            with self.assertRaisesRegex(ReleaseVerificationError, "timestamp signer"):
                verify_release_artifacts(
                    root,
                    identity,
                    expected_commit=EXPECTED_COMMIT,
                    require_installer=True,
                    windows_metadata_reader=lambda _: metadata,
                )

    def test_rejects_signing_claim_on_non_executable_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            identity = _build_release(root)
            manifest_path = root / MANIFEST_NAME
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["artifacts"][0]["timestampSigner"] = "CN=False Claim"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            _rewrite_checksums(root)

            with self.assertRaisesRegex(ReleaseVerificationError, "signing claim"):
                verify_release_artifacts(
                    root, identity, expected_commit=EXPECTED_COMMIT
                )

    def test_rejects_extra_release_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            identity = _build_release(root)
            (root / "stale-beta.1.zip").write_bytes(b"stale")

            with self.assertRaisesRegex(
                ReleaseVerificationError, "unexpected: stale-beta.1.zip"
            ):
                verify_release_artifacts(
                    root, identity, expected_commit=EXPECTED_COMMIT
                )


def _build_release(root: Path, *, include_installer: bool = False) -> ReleaseIdentity:
    identity = ReleaseIdentity.create(PUBLIC_VERSION, EXTENSION_VERSION)
    wheel_names: list[str] = []
    for distribution, project in PYTHON_DISTRIBUTIONS.items():
        wheel_name = f"{distribution}-{identity.python_version}-py3-none-any.whl"
        wheel_names.append(wheel_name)
        _write_wheel(root / wheel_name, project, identity.python_version)
        _write_sdist(
            root / f"{distribution}-{identity.python_version}.tar.gz",
            project,
            identity.python_version,
        )

    install_text = (
        f"Fikeya CLI {identity.public_version}\n\n"
        + f"Run {CLI_INSTALL_SCRIPT_NAME} from the extracted bundle.\n"
        + "\n".join(f"python -m pip install {name}" for name in sorted(wheel_names))
        + "\n"
    )
    (root / CLI_INSTALL_NAME).write_text(install_text, encoding="utf-8")
    installer_script = "\n".join(
        [
            "$ErrorActionPreference = 'Stop'",
            '$agentCore = Get-OneWheel "fikeya_agent_core-"',
            '$runtime = Get-OneWheel "fikeya_runtime-"',
            '$interop = Get-OneWheel "fikeya_interop-"',
            '$runtimeRequirement = "fikeya-runtime[azure,browser]"',
            "& python -m playwright install chromium-headless-shell",
            '& python -c "import azure.identity; import playwright"',
            "",
        ]
    )
    (root / CLI_INSTALL_SCRIPT_NAME).write_text(installer_script, encoding="utf-8")
    sidecar_name = f"fikeya-qarinah-sidecar-{identity.public_version}.zip"
    _write_sidecar_bundle(root, identity)
    (root / CLI_INSTALL_NAME).write_text(
        (root / CLI_INSTALL_NAME).read_text(encoding="utf-8")
        + f"Extract {sidecar_name} for managed Qarinah memory.\n",
        encoding="utf-8",
    )
    with zipfile.ZipFile(
        root / f"fikeya-cli-{identity.public_version}.zip", "w", zipfile.ZIP_DEFLATED
    ) as archive:
        archive.write(root / CLI_INSTALL_NAME, CLI_INSTALL_NAME)
        archive.write(root / CLI_INSTALL_SCRIPT_NAME, CLI_INSTALL_SCRIPT_NAME)
        for wheel_name in wheel_names:
            archive.write(root / wheel_name, wheel_name)
        archive.write(root / sidecar_name, sidecar_name)

    _write_vsix(
        root / f"fikeya-desktop-{identity.extension_version}-{identity.platform}.vsix",
        identity,
    )
    if include_installer:
        (
            root / f"FikeyaSetup-{identity.public_version}-{identity.platform}.exe"
        ).write_bytes(b"fixture installer")
    _seal_release(root)
    return identity


def _write_sidecar_bundle(root: Path, identity: ReleaseIdentity) -> None:
    source = root / "_sidecar-source"
    (source / "src").mkdir(parents=True)
    (source / "node_modules" / "qarinah").mkdir(parents=True)
    package = {
        "dependencies": {"qarinah": "0.4.0"},
        "engines": {"node": "^22.13.0 || ^24.0.0 || ^26.0.0"},
        "name": "@fikeya/qarinah-sidecar",
        "version": "0.1.0",
    }
    lock = {
        "lockfileVersion": 3,
        "name": "@fikeya/qarinah-sidecar",
        "packages": {
            "": {
                "dependencies": {"qarinah": "0.4.0"},
                "version": "0.1.0",
            },
            "node_modules/qarinah": {"version": "0.4.0"},
        },
        "requires": True,
        "version": "0.1.0",
    }
    (source / "LICENSE").write_text("fixture license\n", encoding="utf-8")
    (source / "README.md").write_text("fixture sidecar\n", encoding="utf-8")
    (source / "package.json").write_text(json.dumps(package), encoding="utf-8")
    (source / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
    (source / "src" / "sidecar.mjs").write_text(
        "// fixture sidecar\n", encoding="utf-8"
    )
    (source / "node_modules" / "qarinah" / "package.json").write_text(
        json.dumps({"name": "qarinah", "version": "0.4.0"}), encoding="utf-8"
    )
    package_sidecar(
        source,
        root,
        identity.public_version,
        run_smoke=False,
    )


def _write_wheel(path: Path, project: str, version: str) -> None:
    dist_info = f"{project.replace('-', '_')}-{version}.dist-info"
    metadata = f"Metadata-Version: 2.4\nName: {project}\nVersion: {version}\n\n"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"{dist_info}/METADATA", metadata)
        archive.writestr(
            f"{dist_info}/WHEEL", "Wheel-Version: 1.0\nTag: py3-none-any\n"
        )


def _write_sdist(path: Path, project: str, version: str) -> None:
    metadata = (
        f"Metadata-Version: 2.4\nName: {project}\nVersion: {version}\n\n".encode()
    )
    archive_root = path.name.removesuffix(".tar.gz")
    root_info = tarfile.TarInfo(f"{archive_root}/PKG-INFO")
    root_info.size = len(metadata)
    generated_info = tarfile.TarInfo(
        f"{archive_root}/src/{project.replace('-', '_')}.egg-info/PKG-INFO"
    )
    generated_info.size = len(metadata)
    with tarfile.open(path, "w:gz") as archive:
        archive.addfile(root_info, io.BytesIO(metadata))
        archive.addfile(generated_info, io.BytesIO(metadata))


def _write_vsix(
    path: Path, identity: ReleaseIdentity, *, pre_release: bool = True
) -> None:
    pre_release_property = (
        '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />'
        if pre_release
        else ""
    )
    manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" Version="2.0.0">
  <Metadata>
    <Identity Id="fikeya-desktop" Version="{identity.extension_version}" Publisher="fikeya" TargetPlatform="{identity.platform}" />
    <Properties>{pre_release_property}</Properties>
  </Metadata>
</PackageManifest>
"""
    package = {
        "name": "fikeya-desktop",
        "publisher": "fikeya",
        "version": identity.extension_version,
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("extension/package.json", json.dumps(package))
        archive.writestr("extension.vsixmanifest", manifest)


def _seal_release(root: Path) -> None:
    payloads = sorted(path for path in root.iterdir() if path.is_file())
    records = []
    for path in payloads:
        is_installer = path.suffix.lower() == ".exe"
        records.append(
            {
                "name": path.name,
                "bytes": path.stat().st_size,
                "sha256": _sha256(path),
                "authenticodeStatus": "NotSigned" if is_installer else "not-applicable",
                "signer": None,
            }
        )
    manifest = {
        "schemaVersion": 1,
        "product": "Fikeya",
        "version": PUBLIC_VERSION,
        "commit": EXPECTED_COMMIT,
        "generatedAt": "2026-08-26T00:00:00Z",
        "artifacts": records,
    }
    (root / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    _rewrite_checksums(root)


def _rewrite_checksums(root: Path) -> None:
    checksum_paths = sorted(
        path for path in root.iterdir() if path.is_file() and path.name != CHECKSUM_NAME
    )
    checksum_text = "".join(
        f"{_sha256(path)}  {path.name}\n" for path in checksum_paths
    )
    (root / CHECKSUM_NAME).write_text(checksum_text, encoding="ascii")


def _installer_metadata(identity: ReleaseIdentity) -> dict[str, str | None]:
    return {
        "fileVersion": identity.desktop_numeric_version,
        "productVersion": identity.public_version,
        "fileVersionRaw": identity.desktop_numeric_version,
        "productVersionRaw": identity.desktop_numeric_version,
        "authenticodeStatus": "NotSigned",
        "signer": None,
        "timestampSigner": None,
    }


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    unittest.main()
