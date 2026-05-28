import { Notice } from "obsidian";

/** 同步过程复用同一 Notice，避免自动同步时堆叠多个弹窗 */
export class SyncProgressNotice {
	private notice: Notice | null = null;
	private hideTimer: number | undefined;

	update(message: string): void {
		const text = message.startsWith("XGKB Sync")
			? message
			: `XGKB Sync: ${message}`;
		this.clearHideTimer();
		if (this.notice) {
			this.notice.setMessage(text);
		} else {
			// timeout=0：同步进行中保持显示，结束时再 hide 或设自动消失
			this.notice = new Notice(text, 0);
		}
	}

	/** 同步结束：更新文案并在 timeoutMs 后收起 */
	finish(message: string, timeoutMs: number): void {
		const text = message.startsWith("XGKB Sync")
			? message
			: `XGKB Sync ${message}`;
		this.clearHideTimer();
		if (this.notice) {
			this.notice.setMessage(text);
		} else {
			this.notice = new Notice(text, 0);
		}
		if (timeoutMs > 0) {
			this.hideTimer = window.setTimeout(() => this.dismiss(), timeoutMs);
		}
	}

	dismiss(): void {
		this.clearHideTimer();
		this.notice?.hide();
		this.notice = null;
	}

	private clearHideTimer(): void {
		if (this.hideTimer !== undefined) {
			window.clearTimeout(this.hideTimer);
			this.hideTimer = undefined;
		}
	}
}
