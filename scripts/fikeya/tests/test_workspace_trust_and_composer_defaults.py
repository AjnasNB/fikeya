# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

from pathlib import Path
import json
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

    def test_desktop_opens_project_ui_and_extension_uses_the_secondary_sidebar(self) -> None:
        source = (
            REPOSITORY_ROOT / "extensions/fikeya-desktop/src/extension.ts"
        ).read_text(encoding="utf-8")
        manifest = json.loads(
            (REPOSITORY_ROOT / "extensions/fikeya-desktop/package.json").read_text(
                encoding="utf-8"
            )
        )

        activation = source[source.index("export function activate(") : source.index("class FikeyaWebviewViewProvider")]
        layouts = source[
            source.index("public async openDefaultLayout(") :
            source.index("public async configureProvider(")
        ]

        self.assertIn("provider.openDefaultLayout('chat')", activation)
        self.assertIn("this.hostCapabilities.isFikeyaProduct", layouts)
        self.assertIn("this.openWorkspacePanel(mode)", layouts)
        self.assertIn("this.openEditorLayout(mode)", layouts)
        self.assertIn("workbench.action.alignPanelCenter", layouts)
        self.assertIn("workbench.action.closeAuxiliaryBar", layouts)
        self.assertIn("`${FikeyaWebviewViewProvider.viewType}.focus`", layouts)
        self.assertIn("secondarySidebar", manifest["contributes"]["viewsContainers"])
        self.assertNotIn("activitybar", manifest["contributes"]["viewsContainers"])
        self.assertNotIn("queueMicrotask", activation)

    def test_chat_stays_anchored_and_saves_only_dirty_workspace_files(self) -> None:
        source = (
            REPOSITORY_ROOT / "extensions/fikeya-desktop/src/extension.ts"
        ).read_text(encoding="utf-8")
        manifest = json.loads(
            (REPOSITORY_ROOT / "extensions/fikeya-desktop/package.json").read_text(
                encoding="utf-8"
            )
        )

        save_method = source[
            source.index("private async saveWorkspaceEditsBeforeAgentRun(") :
            source.index("private async runMultiAgent(")
        ]

        self.assertIn("height: 100%", source)
        self.assertIn("grid-template-rows: minmax(0, 1fr) auto", source)
        self.assertIn("overflow: auto", source)
        self.assertIn(".composer-route-menu { position: absolute; right: -42px", source)
        self.assertIn("document.isDirty", save_method)
        self.assertIn("document.isUntitled", save_method)
        self.assertIn("document.uri.scheme !== 'file'", save_method)
        self.assertIn("pathFromRoot.startsWith('..')", save_method)
        self.assertIn("await document.save()", save_method)
        self.assertTrue(
            manifest["contributes"]["configuration"]["properties"]
            ["fikeya.agent.autoSaveWorkspaceEdits"]["default"]
        )

    def test_changed_file_results_open_from_the_chat(self) -> None:
        source = (
            REPOSITORY_ROOT / "extensions/fikeya-desktop/src/extension.ts"
        ).read_text(encoding="utf-8")

        outcome = source[
            source.index("function renderChatRunOutcome(") :
            source.index("function formatByteCount(")
        ]

        self.assertIn('data-open-file=', outcome)
        self.assertIn("files saved", outcome)
        self.assertIn("tests passed", outcome)

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
