# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import zipfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from email import policy
from email.parser import Parser
from pathlib import Path, PurePosixPath
from typing import Any
from xml.etree import ElementTree


PUBLIC_VERSION_PATTERN = re.compile(r"^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$")
HEX_DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")
GIT_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
CHECKSUM_LINE_PATTERN = re.compile(r"^([0-9a-f]{64})  ([^/\\\r\n]+)$")
MANIFEST_NAME = "release-verification.json"
CHECKSUM_NAME = "SHA256SUMS.txt"
CLI_INSTALL_NAME = "FIKEYA-CLI-INSTALL.txt"
CLI_INSTALL_SCRIPT_NAME = "install-fikeya-cli.ps1"


class ReleaseVerificationError(ValueError):
    """Raised when a release artifact cannot be tied to the expected release identity."""


@dataclass(frozen=True)
class ReleaseIdentity:
    public_version: str
    extension_version: str
    python_version: str
    desktop_numeric_version: str
    platform: str = "win32-x64"

    @classmethod
    def create(
        cls, public_version: str, extension_version: str, platform: str = "win32-x64"
    ) -> ReleaseIdentity:
        match = PUBLIC_VERSION_PATTERN.fullmatch(public_version)
        if not match:
            raise ReleaseVerificationError(
                "Public version must use <major>.<minor>.<patch>-beta.<number>."
            )
        if extension_version != public_version:
            raise ReleaseVerificationError(
                "VSIX version must exactly match the public prerelease version."
            )
        if not re.fullmatch(r"(?:win32|darwin|linux)-(?:x64|arm64)", platform):
            raise ReleaseVerificationError(f"Unsupported release platform: {platform}")
        major, minor, patch, beta = match.groups()
        return cls(
            public_version=public_version,
            extension_version=extension_version,
            python_version=f"{major}.{minor}.{patch}b{beta}",
            desktop_numeric_version=f"{major}.{minor}.{patch}.{beta}",
            platform=platform,
        )


PYTHON_DISTRIBUTIONS = {
    "fikeya_agent_core": "fikeya-agent-core",
    "fikeya_runtime": "fikeya-runtime",
    "fikeya_interop": "fikeya-interop",
}


def verify_release_artifacts(
    artifact_directory: Path,
    identity: ReleaseIdentity,
    *,
    expected_commit: str | None = None,
    require_installer: bool = False,
    windows_metadata_reader: Callable[[Path], Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    artifact_directory = artifact_directory.resolve()
    if not artifact_directory.is_dir():
        raise ReleaseVerificationError(
            f"Artifact directory does not exist: {artifact_directory}"
        )
    if expected_commit is not None and not GIT_COMMIT_PATTERN.fullmatch(
        expected_commit
    ):
        raise ReleaseVerificationError(
            "Expected commit must be a 40- or 64-character lowercase Git object ID."
        )

    wheel_names = {
        package: f"{distribution}-{identity.python_version}-py3-none-any.whl"
        for distribution, package in PYTHON_DISTRIBUTIONS.items()
    }
    sdist_names = {
        package: f"{distribution}-{identity.python_version}.tar.gz"
        for distribution, package in PYTHON_DISTRIBUTIONS.items()
    }
    vsix_name = f"fikeya-desktop-{identity.extension_version}-{identity.platform}.vsix"
    cli_name = f"fikeya-cli-{identity.public_version}.zip"
    installer_name = f"FikeyaSetup-{identity.public_version}-{identity.platform}.exe"

    expected_names = {
        *wheel_names.values(),
        *sdist_names.values(),
        vsix_name,
        cli_name,
        CLI_INSTALL_NAME,
        CLI_INSTALL_SCRIPT_NAME,
        MANIFEST_NAME,
        CHECKSUM_NAME,
    }
    installer_path = artifact_directory / installer_name
    if require_installer or installer_path.is_file():
        expected_names.add(installer_name)

    actual_names = {
        path.name for path in artifact_directory.iterdir() if path.is_file()
    }
    missing = sorted(expected_names - actual_names)
    unexpected = sorted(actual_names - expected_names)
    if missing or unexpected:
        details = []
        if missing:
            details.append(f"missing: {', '.join(missing)}")
        if unexpected:
            details.append(f"unexpected: {', '.join(unexpected)}")
        raise ReleaseVerificationError(
            f"Release artifact set is not exact ({'; '.join(details)})."
        )

    for package, wheel_name in wheel_names.items():
        _verify_python_metadata(
            artifact_directory / wheel_name,
            package,
            identity.python_version,
            archive_kind="wheel",
        )
    for package, sdist_name in sdist_names.items():
        _verify_python_metadata(
            artifact_directory / sdist_name,
            package,
            identity.python_version,
            archive_kind="sdist",
        )

    _verify_vsix(artifact_directory / vsix_name, identity)
    _verify_cli_bundle(
        artifact_directory / cli_name,
        artifact_directory,
        set(wheel_names.values()),
        identity.public_version,
    )
    _verify_manifest(artifact_directory, identity, expected_names, expected_commit)
    _verify_checksums(artifact_directory, expected_names)

    installer_report: Mapping[str, Any] | None = None
    if installer_name in expected_names:
        reader = windows_metadata_reader or read_windows_installer_metadata
        installer_report = reader(installer_path)
        _verify_installer_metadata(installer_report, identity)
        _verify_installer_signature_manifest_coherence(
            artifact_directory / MANIFEST_NAME,
            installer_name,
            installer_report,
        )

    return {
        "ok": True,
        "publicVersion": identity.public_version,
        "pythonVersion": identity.python_version,
        "extensionVersion": identity.extension_version,
        "desktopNumericVersion": identity.desktop_numeric_version,
        "platform": identity.platform,
        "artifactCount": len(expected_names),
        "installerAuthenticodeStatus": (
            installer_report.get("authenticodeStatus")
            if installer_report is not None
            else "not-present"
        ),
    }


def _verify_python_metadata(
    archive_path: Path,
    expected_name: str,
    expected_version: str,
    *,
    archive_kind: str,
) -> None:
    if archive_kind == "wheel":
        with zipfile.ZipFile(archive_path) as archive:
            _validate_zip_members(archive, archive_path.name)
            metadata_names = [
                name
                for name in archive.namelist()
                if name.endswith(".dist-info/METADATA")
            ]
            if len(metadata_names) != 1:
                raise ReleaseVerificationError(
                    f"{archive_path.name} must contain exactly one wheel METADATA file."
                )
            metadata_bytes = archive.read(metadata_names[0])
    elif archive_kind == "sdist":
        with tarfile.open(archive_path, mode="r:gz") as archive:
            members = archive.getmembers()
            _validate_tar_members(members, archive_path.name)
            archive_root = archive_path.name.removesuffix(".tar.gz")
            root_metadata_name = f"{archive_root}/PKG-INFO"
            metadata_members = [
                member
                for member in members
                if member.isfile() and member.name == root_metadata_name
            ]
            if len(metadata_members) != 1:
                raise ReleaseVerificationError(
                    f"{archive_path.name} must contain exactly one root sdist PKG-INFO file."
                )
            metadata_file = archive.extractfile(metadata_members[0])
            if metadata_file is None:
                raise ReleaseVerificationError(
                    f"Could not read metadata from {archive_path.name}."
                )
            metadata_bytes = metadata_file.read(1_048_577)
    else:
        raise AssertionError(f"Unknown archive kind: {archive_kind}")
    if len(metadata_bytes) > 1_048_576:
        raise ReleaseVerificationError(
            f"Metadata in {archive_path.name} exceeds one MiB."
        )
    metadata = Parser(policy=policy.default).parsestr(metadata_bytes.decode("utf-8"))
    if _canonical_project_name(
        str(metadata.get("Name", ""))
    ) != _canonical_project_name(expected_name):
        raise ReleaseVerificationError(
            f"{archive_path.name} contains the wrong project name."
        )
    if str(metadata.get("Version", "")) != expected_version:
        raise ReleaseVerificationError(
            f"{archive_path.name} metadata version is {metadata.get('Version')!r}; expected {expected_version!r}."
        )


def _verify_vsix(vsix_path: Path, identity: ReleaseIdentity) -> None:
    with zipfile.ZipFile(vsix_path) as archive:
        _validate_zip_members(archive, vsix_path.name)
        required = {"extension/package.json", "extension.vsixmanifest"}
        if not required.issubset(archive.namelist()):
            raise ReleaseVerificationError(
                f"{vsix_path.name} is missing its package or VSIX manifest."
            )
        package = json.loads(archive.read("extension/package.json"))
        manifest_root = ElementTree.fromstring(archive.read("extension.vsixmanifest"))

    if package.get("name") != "fikeya-desktop" or package.get("publisher") != "fikeya":
        raise ReleaseVerificationError(
            f"{vsix_path.name} contains the wrong extension identity."
        )
    if package.get("version") != identity.extension_version:
        raise ReleaseVerificationError(
            f"{vsix_path.name} package.json contains the wrong version."
        )

    identities = [
        element
        for element in manifest_root.iter()
        if _xml_local_name(element.tag) == "Identity"
    ]
    if len(identities) != 1:
        raise ReleaseVerificationError(
            f"{vsix_path.name} must contain exactly one VSIX Identity."
        )
    vsix_identity = identities[0].attrib
    expected_identity = {
        "Id": "fikeya-desktop",
        "Publisher": "fikeya",
        "Version": identity.extension_version,
        "TargetPlatform": identity.platform,
    }
    for key, expected in expected_identity.items():
        if vsix_identity.get(key) != expected:
            raise ReleaseVerificationError(
                f"{vsix_path.name} VSIX Identity {key} is {vsix_identity.get(key)!r}; expected {expected!r}."
            )
    pre_release_values = [
        element.attrib.get("Value")
        for element in manifest_root.iter()
        if _xml_local_name(element.tag) == "Property"
        and element.attrib.get("Id") == "Microsoft.VisualStudio.Code.PreRelease"
    ]
    if pre_release_values != ["true"]:
        raise ReleaseVerificationError(
            f"{vsix_path.name} is not marked as exactly one VS Code pre-release."
        )


def _verify_cli_bundle(
    cli_path: Path,
    artifact_directory: Path,
    wheel_names: set[str],
    public_version: str,
) -> None:
    expected_entries = {*wheel_names, CLI_INSTALL_NAME, CLI_INSTALL_SCRIPT_NAME}
    with zipfile.ZipFile(cli_path) as archive:
        _validate_zip_members(archive, cli_path.name)
        entries = set(archive.namelist())
        if entries != expected_entries:
            raise ReleaseVerificationError(
                f"{cli_path.name} contents are not exact; expected {sorted(expected_entries)}, received {sorted(entries)}."
            )
        for entry in sorted(expected_entries):
            if archive.read(entry) != (artifact_directory / entry).read_bytes():
                raise ReleaseVerificationError(
                    f"{cli_path.name} contains bytes that differ from top-level {entry}."
                )
        install_text = archive.read(CLI_INSTALL_NAME).decode("utf-8-sig")
        installer_text = archive.read(CLI_INSTALL_SCRIPT_NAME).decode("utf-8-sig")
    if f"Fikeya CLI {public_version}" not in install_text:
        raise ReleaseVerificationError(
            f"{cli_path.name} install guide contains the wrong public version."
        )
    if CLI_INSTALL_SCRIPT_NAME not in install_text:
        raise ReleaseVerificationError(
            f"{cli_path.name} install guide does not reference its installer script."
        )
    for distribution in PYTHON_DISTRIBUTIONS:
        if f'Get-OneWheel "{distribution}-"' not in installer_text:
            raise ReleaseVerificationError(
                f"{cli_path.name} installer does not resolve the {distribution} wheel."
            )
    if (
        "fikeya-runtime[azure,browser]" not in installer_text
        or "import azure.identity" not in installer_text
        or "import playwright" not in installer_text
        or "playwright install chromium-headless-shell" not in installer_text
    ):
        raise ReleaseVerificationError(
            f"{cli_path.name} installer does not prove Azure and browser CLI support."
        )


def _verify_manifest(
    artifact_directory: Path,
    identity: ReleaseIdentity,
    expected_names: set[str],
    expected_commit: str | None,
) -> None:
    manifest_path = artifact_directory / MANIFEST_NAME
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ReleaseVerificationError(
            f"{MANIFEST_NAME} is invalid JSON: {error}"
        ) from error
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != 1
        or manifest.get("product") != "Fikeya"
    ):
        raise ReleaseVerificationError(
            f"{MANIFEST_NAME} contains the wrong schema or product identity."
        )
    if manifest.get("version") != identity.public_version:
        raise ReleaseVerificationError(
            f"{MANIFEST_NAME} contains the wrong public version."
        )
    commit = manifest.get("commit")
    if not isinstance(commit, str) or not GIT_COMMIT_PATTERN.fullmatch(commit):
        raise ReleaseVerificationError(
            f"{MANIFEST_NAME} commit is not a full Git object ID."
        )
    if expected_commit is not None and commit != expected_commit:
        raise ReleaseVerificationError(
            f"{MANIFEST_NAME} commit does not match the release commit."
        )

    records = manifest.get("artifacts")
    if not isinstance(records, list):
        raise ReleaseVerificationError(f"{MANIFEST_NAME} artifacts must be an array.")
    expected_payload_names = expected_names - {MANIFEST_NAME, CHECKSUM_NAME}
    records_by_name: dict[str, Mapping[str, Any]] = {}
    for record in records:
        if not isinstance(record, dict) or not _safe_basename(record.get("name")):
            raise ReleaseVerificationError(
                f"{MANIFEST_NAME} contains an unsafe artifact record."
            )
        name = str(record["name"])
        if name in records_by_name:
            raise ReleaseVerificationError(
                f"{MANIFEST_NAME} contains duplicate artifact {name}."
            )
        records_by_name[name] = record
    if set(records_by_name) != expected_payload_names:
        raise ReleaseVerificationError(
            f"{MANIFEST_NAME} artifact names do not match the release payload."
        )

    for name, record in records_by_name.items():
        path = artifact_directory / name
        if record.get("bytes") != path.stat().st_size:
            raise ReleaseVerificationError(
                f"{MANIFEST_NAME} records the wrong byte count for {name}."
            )
        if record.get("sha256") != _sha256(path):
            raise ReleaseVerificationError(
                f"{MANIFEST_NAME} records the wrong SHA-256 digest for {name}."
            )
        if path.suffix.lower() != ".exe":
            if (
                record.get("authenticodeStatus") != "not-applicable"
                or record.get("signer") is not None
                or record.get("timestampSigner") is not None
                or record.get("signatureScope", "not-applicable") != "not-applicable"
            ):
                raise ReleaseVerificationError(
                    f"{MANIFEST_NAME} makes an invalid signing claim for {name}."
                )


def _verify_checksums(artifact_directory: Path, expected_names: set[str]) -> None:
    checksum_path = artifact_directory / CHECKSUM_NAME
    try:
        lines = checksum_path.read_text(encoding="ascii").splitlines()
    except UnicodeDecodeError as error:
        raise ReleaseVerificationError(f"{CHECKSUM_NAME} must be ASCII.") from error
    checksums: dict[str, str] = {}
    for line in lines:
        match = CHECKSUM_LINE_PATTERN.fullmatch(line)
        if not match:
            raise ReleaseVerificationError(f"Malformed {CHECKSUM_NAME} line: {line!r}")
        digest, name = match.groups()
        if name in checksums:
            raise ReleaseVerificationError(
                f"{CHECKSUM_NAME} contains duplicate artifact {name}."
            )
        checksums[name] = digest
    expected_checksum_names = expected_names - {CHECKSUM_NAME}
    if set(checksums) != expected_checksum_names:
        raise ReleaseVerificationError(
            f"{CHECKSUM_NAME} does not cover the exact release payload."
        )
    for name, digest in checksums.items():
        if digest != _sha256(artifact_directory / name):
            raise ReleaseVerificationError(
                f"{CHECKSUM_NAME} contains the wrong digest for {name}."
            )


def read_windows_installer_metadata(installer_path: Path) -> Mapping[str, Any]:
    if os.name != "nt":
        raise ReleaseVerificationError(
            "A Windows host is required to inspect installer version resources."
        )
    powershell = shutil.which("pwsh") or shutil.which("powershell")
    if powershell is None:
        raise ReleaseVerificationError(
            "PowerShell is required to inspect installer version resources."
        )
    installer_environment_name = "FIKEYA_RELEASE_VERIFY_INSTALLER_PATH"
    script = r"""
$path = $env:FIKEYA_RELEASE_VERIFY_INSTALLER_PATH
if ([string]::IsNullOrWhiteSpace($path)) { throw 'Installer path was not provided.' }
$version = (Get-Item -LiteralPath $path).VersionInfo
$signature = Get-AuthenticodeSignature -LiteralPath $path
[ordered]@{
  fileVersion = $version.FileVersion.Trim()
  productVersion = $version.ProductVersion.Trim()
  fileVersionRaw = $version.FileVersionRaw.ToString()
  productVersionRaw = $version.ProductVersionRaw.ToString()
  authenticodeStatus = [string]$signature.Status
  signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
  timestampSigner = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null }
} | ConvertTo-Json -Compress
"""
    environment = os.environ.copy()
    environment[installer_environment_name] = str(installer_path)
    try:
        completed = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=environment,
            timeout=120,
        )
    except subprocess.TimeoutExpired as error:
        raise ReleaseVerificationError(
            f"Timed out while inspecting {installer_path.name}."
        ) from error
    if completed.returncode != 0:
        raise ReleaseVerificationError(
            f"Could not inspect {installer_path.name}: {(completed.stderr or completed.stdout).strip()[:1000]}"
        )
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise ReleaseVerificationError(
            f"PowerShell returned invalid installer metadata: {error}"
        ) from error
    if not isinstance(result, dict):
        raise ReleaseVerificationError(
            "PowerShell returned an invalid installer metadata object."
        )
    return result


def _verify_installer_metadata(
    metadata: Mapping[str, Any], identity: ReleaseIdentity
) -> None:
    expected_versions = {
        "fileVersion": identity.desktop_numeric_version,
        "productVersion": identity.public_version,
        "fileVersionRaw": identity.desktop_numeric_version,
        "productVersionRaw": identity.desktop_numeric_version,
    }
    for field, expected_version in expected_versions.items():
        if metadata.get(field) != expected_version:
            raise ReleaseVerificationError(
                f"Installer {field} is {metadata.get(field)!r}; expected {expected_version!r}."
            )
    status = metadata.get("authenticodeStatus")
    if status not in {"NotSigned", "Valid"}:
        raise ReleaseVerificationError(
            f"Installer Authenticode status is not releasable: {status!r}."
        )
    if status == "NotSigned" and (
        metadata.get("signer") is not None
        or metadata.get("timestampSigner") is not None
    ):
        raise ReleaseVerificationError(
            "Unsigned installer metadata unexpectedly names a signer."
        )
    if status == "Valid" and not metadata.get("signer"):
        raise ReleaseVerificationError(
            "Signed installer metadata does not name its signer."
        )
    if status == "Valid" and not metadata.get("timestampSigner"):
        raise ReleaseVerificationError(
            "Signed installer metadata does not name its timestamp signer."
        )


def _verify_installer_signature_manifest_coherence(
    manifest_path: Path,
    installer_name: str,
    metadata: Mapping[str, Any],
) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    record = next(
        (item for item in manifest["artifacts"] if item.get("name") == installer_name),
        None,
    )
    if record is None:
        raise ReleaseVerificationError(
            f"{MANIFEST_NAME} does not record {installer_name}."
        )
    if record.get("authenticodeStatus") != metadata.get("authenticodeStatus"):
        raise ReleaseVerificationError(
            f"{MANIFEST_NAME} Authenticode status does not match the installer."
        )
    if record.get("signer") != metadata.get("signer"):
        raise ReleaseVerificationError(
            f"{MANIFEST_NAME} signer does not match the installer."
        )
    if record.get("timestampSigner") != metadata.get("timestampSigner"):
        raise ReleaseVerificationError(
            f"{MANIFEST_NAME} timestamp signer does not match the installer."
        )


def _validate_zip_members(archive: zipfile.ZipFile, archive_name: str) -> None:
    names = archive.namelist()
    if len(names) != len(set(names)):
        raise ReleaseVerificationError(
            f"{archive_name} contains duplicate archive members."
        )
    for name in names:
        if not _safe_archive_member(name):
            raise ReleaseVerificationError(
                f"{archive_name} contains unsafe archive member {name!r}."
            )


def _validate_tar_members(members: list[tarfile.TarInfo], archive_name: str) -> None:
    names = [member.name for member in members]
    if len(names) != len(set(names)):
        raise ReleaseVerificationError(
            f"{archive_name} contains duplicate archive members."
        )
    for member in members:
        if not _safe_archive_member(member.name) or member.issym() or member.islnk():
            raise ReleaseVerificationError(
                f"{archive_name} contains unsafe archive member {member.name!r}."
            )


def _safe_archive_member(name: str) -> bool:
    path = PurePosixPath(name)
    return (
        bool(name)
        and "\\" not in name
        and not path.is_absolute()
        and ".." not in path.parts
    )


def _safe_basename(value: Any) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and value == Path(value).name
        and "/" not in value
        and "\\" not in value
    )


def _canonical_project_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _xml_local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify the complete Fikeya release artifact set."
    )
    parser.add_argument("--artifact-directory", type=Path, required=True)
    parser.add_argument("--public-version", required=True)
    parser.add_argument("--extension-version", required=True)
    parser.add_argument("--platform", default="win32-x64")
    parser.add_argument("--expected-commit")
    parser.add_argument("--require-installer", action="store_true")
    arguments = parser.parse_args()
    try:
        report = verify_release_artifacts(
            arguments.artifact_directory,
            ReleaseIdentity.create(
                arguments.public_version,
                arguments.extension_version,
                arguments.platform,
            ),
            expected_commit=arguments.expected_commit,
            require_installer=arguments.require_installer,
        )
    except (
        ElementTree.ParseError,
        json.JSONDecodeError,
        OSError,
        ReleaseVerificationError,
        tarfile.TarError,
        UnicodeDecodeError,
        zipfile.BadZipFile,
    ) as error:
        parser.exit(1, f"ERROR: {error}\n")
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
