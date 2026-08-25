/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IRecordingService, RecordingState } from '../../issue/browser/recordingService.js';
import { IScreenshotService } from '../../issue/browser/screenshotService.js';

const FIKEYA_CATEGORY = localize2('fikeya.category', "Fikeya");

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

registerAction2(class CaptureFikeyaScreenshotAction extends Action2 {
	constructor() {
		super({
			id: 'fikeya.captureScreenshot',
			category: FIKEYA_CATEGORY,
			title: localize2('fikeya.captureScreenshot', "Capture Fikeya Screenshot..."),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const screenshotService = accessor.get(IScreenshotService);
		const fileDialogService = accessor.get(IFileDialogService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);
		try {
			const dataUrl = await screenshotService.captureScreenshot();
			const commaIndex = dataUrl?.indexOf(',') ?? -1;
			if (!dataUrl || commaIndex < 0) {
				notificationService.warn(localize('fikeya.screenshotUnavailable', "Screenshot capture is unavailable on this device."));
				return;
			}
			const target = await fileDialogService.showSaveDialog({
				defaultUri: joinPath(await fileDialogService.defaultFilePath(), `fikeya-${timestamp()}.jpg`),
				filters: [{ name: localize('fikeya.jpegImage', "JPEG image"), extensions: ['jpg', 'jpeg'] }]
			});
			if (!target) {
				return;
			}
			await fileService.writeFile(target, decodeBase64(dataUrl.substring(commaIndex + 1)));
			notificationService.info(localize('fikeya.screenshotSaved', "Fikeya screenshot saved to {0}.", target.fsPath));
		} catch (error) {
			notificationService.notify({
				severity: Severity.Error,
				message: localize('fikeya.screenshotFailed', "Fikeya could not save the screenshot: {0}", error instanceof Error ? error.message : String(error))
			});
		}
	}
});

registerAction2(class ToggleFikeyaRecordingAction extends Action2 {
	constructor() {
		super({
			id: 'fikeya.toggleScreenRecording',
			category: FIKEYA_CATEGORY,
			title: localize2('fikeya.toggleScreenRecording', "Start or Stop Fikeya Screen Recording"),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const recordingService = accessor.get(IRecordingService);
		const fileDialogService = accessor.get(IFileDialogService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);
		if (!recordingService.isSupported) {
			notificationService.warn(localize('fikeya.recordingUnavailable', "Screen recording is unavailable on this device."));
			return;
		}
		try {
			if (recordingService.state !== RecordingState.Recording) {
				const permission = await recordingService.getScreenCapturePermissionStatus();
				if (permission === 'denied' || permission === 'restricted') {
					recordingService.openScreenCapturePermissionSettings();
					notificationService.warn(localize('fikeya.recordingPermission', "Allow Fikeya to record the screen, then run the command again."));
					return;
				}
				const format = recordingService.getSupportedFormats()[0];
				await recordingService.startRecording(format?.mimeType);
				notificationService.info(localize('fikeya.recordingStarted', "Fikeya screen recording started. Run the command again to stop and save."));
				return;
			}
			const data = await recordingService.stopRecording();
			if (!data) {
				return;
			}
			const extension = data.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
			const target = await fileDialogService.showSaveDialog({
				defaultUri: joinPath(await fileDialogService.defaultFilePath(), `fikeya-${timestamp()}.${extension}`),
				filters: [{ name: localize('fikeya.videoRecording', "Video recording"), extensions: [extension] }]
			});
			if (!target) {
				return;
			}
			await fileService.writeFile(target, VSBuffer.wrap(new Uint8Array(await data.blob.arrayBuffer())));
			notificationService.info(localize('fikeya.recordingSaved', "Fikeya recording saved to {0}.", target.fsPath));
		} catch (error) {
			notificationService.notify({
				severity: Severity.Error,
				message: localize('fikeya.recordingFailed', "Fikeya could not record the screen: {0}", error instanceof Error ? error.message : String(error))
			});
		}
	}
});
