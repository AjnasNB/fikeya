# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FAILURES: list[str] = []


def read_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def read_json(relative_path: str) -> dict[str, object]:
    value = json.loads(read_text(relative_path))
    if not isinstance(value, dict):
        raise ValueError(f"{relative_path} must contain a JSON object")
    return value


def expect(condition: bool, message: str) -> None:
    if not condition:
        FAILURES.append(message)


def expect_equal(actual: object, expected: object, label: str) -> None:
    expect(actual == expected, f"{label} must be {expected!r}; received {actual!r}.")


product = read_json("product.json")
root_package = read_json("package.json")
readme = read_text("README.md")
root_license = read_text("LICENSE.txt")

expected_identity = {
    "nameShort": "Fikeya",
    "nameLong": "Fikeya",
    "applicationName": "fikeya",
    "dataFolderName": ".fikeya",
    "sharedDataFolderName": ".fikeya-shared",
    "serverApplicationName": "fikeya-server",
    "serverDataFolderName": ".fikeya-server",
    "tunnelApplicationName": "fikeya-tunnel",
    "urlProtocol": "fikeya",
    "win32DirName": "Fikeya",
    "win32NameVersion": "Fikeya",
    "win32RegValueName": "Fikeya",
    "win32AppUserModelId": "Fikeya.Desktop",
    "darwinBundleIdentifier": "com.fikeya.desktop",
}
for key, expected in expected_identity.items():
    expect_equal(product.get(key), expected, f"product.json {key}")

expect_equal(
    product.get("reportIssueUrl"),
    "https://github.com/AjnasNB/fikeya/issues/new",
    "product.json reportIssueUrl",
)
expect_equal(product.get("licenseName"), "MIT", "Code OSS foundation license name")
expect_equal(product.get("licenseFileName"), "LICENSE.txt", "Code OSS foundation license file")
expect_equal(
    product.get("licenseUrl"),
    "https://github.com/AjnasNB/fikeya/blob/main/LICENSE.txt",
    "Code OSS foundation license URL",
)
expect_equal(product.get("serverLicenseUrl"), product.get("licenseUrl"), "server license URL")
expect("extensionsGallery" not in product, "product.json must not silently enable a proprietary extension gallery.")
expect(
    "defaultChatAgent" not in product,
    "product.json must not hard-wire a provider-specific default chat agent.",
)
expect(
    "trustedExtensionAuthAccess" not in product,
    "product.json must not grant provider-specific extensions privileged authentication access.",
)
app_id_keys = (
    "win32x64AppId",
    "win32arm64AppId",
    "win32x64UserAppId",
    "win32arm64UserAppId",
)
app_ids = [product.get(key) for key in app_id_keys]
app_id_pattern = re.compile(r"^\{\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$")
for key, app_id in zip(app_id_keys, app_ids, strict=True):
    expect(isinstance(app_id, str) and bool(app_id_pattern.fullmatch(app_id)), f"product.json {key} is not a valid Inno Setup application identifier.")
expect(len(set(app_ids)) == len(app_ids), "Windows application identifiers must be unique.")

expect_equal(root_package.get("name"), "code-oss-dev", "upstream source-package identity")
expect(root_package.get("private") is True, "The upstream source package must remain private and must never be published to npm.")
expect_equal(root_package.get("main"), "./out/main.js", "desktop entry point")
expect(root_license.startswith("MIT License"), "The Code OSS foundation license must retain its MIT notice.")
expect("built on [Code OSS]" in readme, "README must disclose the Code OSS foundation.")
expect(
    "proprietary services, and Marketplace access are not part of Fikeya" in readme,
    "README must disclose the proprietary-service boundary.",
)

component_licenses = (
    ("fikeya-runtime/pyproject.toml", 'license = "AGPL-3.0-or-later"'),
    ("fikeya-agent-core/pyproject.toml", 'license = "AGPL-3.0-or-later"'),
    ("extensions/fikeya-desktop/package.json", '"license": "AGPL-3.0-or-later"'),
    ("integrations/tool-presets/package.json", '"license": "AGPL-3.0-or-later"'),
    ("integrations/fikeya-interop/pyproject.toml", 'license = "AGPL-3.0-or-later"'),
    ("packages/fikeya-protocol/package.json", '"license": "Apache-2.0"'),
    ("integrations/qarinah-sidecar/package.json", '"license": "Apache-2.0"'),
)
for relative_path, marker in component_licenses:
    expect(marker in read_text(relative_path), f"{relative_path} must retain the declared license marker {marker}.")

for relative_path, label in (
    ("resources/win32/code.ico", "Windows application icon source"),
    ("resources/darwin/code.icns", "macOS application icon source"),
    ("resources/linux/code.png", "Linux application icon source"),
):
    expect((ROOT / relative_path).is_file(), f"{label} is missing: {relative_path}.")

required_major = int(read_text(".nvmrc").split(".", maxsplit=1)[0])
expect(required_major == 24, f"The current Fikeya desktop build contract requires Node 24; .nvmrc selects {required_major}.")

if FAILURES:
    for failure in FAILURES:
        print(f"ERROR: {failure}", file=sys.stderr)
    raise SystemExit(1)

print("Fikeya desktop foundation verified.")
print("Verified product identifiers, source-package safety, service boundary, license contracts, and packaging asset inputs.")
