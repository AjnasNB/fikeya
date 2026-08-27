# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

from pathlib import Path
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class WorkspaceTrustAndComposerDefaultsTests(unittest.TestCase):
    def test_untrusted_folders_use_a_dialog_without_the_full_width_banner(self) -> None:
        source = (
            REPOSITORY_ROOT
            / "src/vs/workbench/contrib/workspace/browser/workspace.contribution.ts"
        ).read_text(encoding="utf-8")

        startup = source.index("[WORKSPACE_TRUST_STARTUP_PROMPT]")
        banner = source.index("[WORKSPACE_TRUST_BANNER]", startup)
        trust_defaults = source[startup : banner + 600]

        self.assertIn("default: 'once'", trust_defaults)
        self.assertIn("default: 'never'", trust_defaults)

    def test_shared_chat_composer_keeps_secondary_controls_in_one_menu(self) -> None:
        source = (
            REPOSITORY_ROOT / "extensions/fikeya-desktop/src/extension.ts"
        ).read_text(encoding="utf-8")

        surface = source[source.index("function renderAgentSurface(") :]

        self.assertIn('class="composer-menu-controls"', surface)
        self.assertIn("Configure models", surface)
        self.assertIn('data-agent-run type="submit"', surface)
        self.assertIn('aria-hidden="true">↑</span>', surface)
        self.assertNotIn('class="quiet composer-add-model"', surface)
        self.assertNotIn('class="run-controls"', surface)

    def test_desktop_opens_chat_as_the_primary_surface_and_extension_stays_beside(self) -> None:
        source = (
            REPOSITORY_ROOT / "extensions/fikeya-desktop/src/extension.ts"
        ).read_text(encoding="utf-8")

        activation = source[source.index("export function activate(") : source.index("class FikeyaWebviewViewProvider")]
        panel = source[source.index("public openWorkspacePanel(") : source.index("public async configureProvider(")]

        self.assertIn("provider.openWorkspacePanel('chat')", activation)
        self.assertIn("this.hostCapabilities.isFikeyaProduct", panel)
        self.assertIn("? vscode.ViewColumn.One", panel)
        self.assertIn(": vscode.ViewColumn.Beside", panel)
        self.assertNotIn("queueMicrotask", activation)

    def test_composer_accepts_ephemeral_images_without_persisting_data_urls(self) -> None:
        source = (
            REPOSITORY_ROOT / "extensions/fikeya-desktop/src/extension.ts"
        ).read_text(encoding="utf-8")
        conversation = (
            REPOSITORY_ROOT / "extensions/fikeya-desktop/src/conversation.ts"
        ).read_text(encoding="utf-8")

        self.assertIn("data-image-input", source)
        self.assertIn("clipboardData?.items", source)
        self.assertIn("images: imageAttachments", source)
        self.assertNotIn("dataUrl", conversation)
        self.assertIn("Content-free metadata only", conversation)


if __name__ == "__main__":
    unittest.main()
