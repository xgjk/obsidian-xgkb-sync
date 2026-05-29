import { XgkbApi } from "./xgkbApi";
import type { Result } from "./types";
import {
	UPLOAD_CHUNK_SIZE,
	VERSION_REMARK,
} from "./constants";
import { md5Hex } from "./md5";

export interface FileUploadCreateParams {
	content: string;
	fileName: string;
	fileSuffix?: string;
	folderName: string;
	projectId: string;
}

export interface FileUploadCreateResult {
	fileId: string;
	folderId: string;
}

export interface FileUploadUpdateParams {
	content: string;
	fileName: string;
	fileSuffix?: string;
	updateFileId: string;
	projectId: string;
}

/**
 * 物理文件上传：分片 → resourceId → saveFileByPath / updateFileVersion
 */
export class FileUploader {
	constructor(private api: XgkbApi) {}

	async create(params: FileUploadCreateParams): Promise<Result<FileUploadCreateResult>> {
		const bytes = new TextEncoder().encode(params.content);
		const suffix = params.fileSuffix || extractSuffix(params.fileName) || "md";

		const resourceResult = await this.uploadToResource(bytes, params.fileName, suffix);
		if (!resourceResult.ok) return resourceResult;

		const saveResult = await this.api.saveFileByPath({
			projectId: params.projectId,
			path:
				params.folderName === ""
					? ""
					: params.folderName || undefined,
			name: params.fileName,
			fileType: "file",
			suffix,
			size: bytes.length,
			resourceId: resourceResult.value,
			nameConflictStrategy: 1,
		});
		if (!saveResult.ok) return { ok: false, error: `saveFileByPath 失败: ${saveResult.error}` };

		const fileId = String(saveResult.value);
		const metaResult = await this.api.batchGetMeta([fileId], params.projectId);
		let folderId = "";
		if (metaResult.ok && metaResult.value.length > 0) {
			const parent = metaResult.value[0].parentId;
			folderId = parent != null ? String(parent) : "";
		}

		return { ok: true, value: { fileId, folderId } };
	}

	async update(params: FileUploadUpdateParams): Promise<Result<string>> {
		const bytes = new TextEncoder().encode(params.content);
		const suffix = params.fileSuffix || extractSuffix(params.fileName) || "md";

		const resourceResult = await this.uploadToResource(bytes, params.fileName, suffix);
		if (!resourceResult.ok) return resourceResult;

		const versionResult = await this.api.updateFileVersion({
			id: params.updateFileId,
			projectId: params.projectId,
			resourceId: resourceResult.value,
			name: params.fileName,
			suffix,
			size: bytes.length,
			versionRemark: VERSION_REMARK,
		});
		if (!versionResult.ok) {
			return { ok: false, error: `updateFileVersion 失败: ${versionResult.error}` };
		}
		return { ok: true, value: String(versionResult.value) };
	}

	private async uploadToResource(
		bytes: Uint8Array,
		fileName: string,
		suffix: string
	): Promise<Result<number>> {
		const sliceIds: number[] = [];
		const totalSize = bytes.length;
		const chunkCount = Math.max(1, Math.ceil(totalSize / UPLOAD_CHUNK_SIZE));

		for (let i = 0; i < chunkCount; i++) {
			const start = i * UPLOAD_CHUNK_SIZE;
			const end = Math.min(start + UPLOAD_CHUNK_SIZE, totalSize);
			const chunk = bytes.subarray(start, end);
			const chunkMd5 = md5Hex(chunk);
			const chunkSize = chunk.length;

			const checkResult = await this.api.getSliceIdByMd5V2(chunkMd5, chunkSize, suffix);
			if (!checkResult.ok) {
				return {
					ok: false,
					error: `getSliceIdByMd5V2 失败 (${i + 1}/${chunkCount}): ${checkResult.error}`,
				};
			}

			const sliceData = checkResult.value;
			if (sliceData.sliceId) {
				sliceIds.push(sliceData.sliceId);
				continue;
			}

			if (!sliceData.uploadUrl) {
				return {
					ok: false,
					error: `分片 ${i + 1}/${chunkCount} 无 uploadUrl 且无 sliceId`,
				};
			}

			const putResult = await this.putToMinIO(sliceData.uploadUrl, chunk);
			if (!putResult.ok) {
				return { ok: false, error: `MinIO PUT 失败 (${i + 1}/${chunkCount}): ${putResult.error}` };
			}

			const registerResult = await this.api.uploadFileSliceV2({
				filePath: sliceData.fullPath!,
				md5: chunkMd5,
				size: chunkSize,
				storageType: sliceData.storageType || "MINIO",
			});
			if (!registerResult.ok) {
				return {
					ok: false,
					error: `uploadFileSliceV2 失败 (${i + 1}/${chunkCount}): ${registerResult.error}`,
				};
			}
			sliceIds.push(registerResult.value);
		}

		const mergeResult = await this.api.saveResource({
			name: fileName,
			sliceIds,
			suffix,
			size: totalSize,
		});
		if (!mergeResult.ok) {
			return { ok: false, error: `saveResource 失败: ${mergeResult.error}` };
		}
		return { ok: true, value: mergeResult.value };
	}

	private async putToMinIO(url: string, data: Uint8Array): Promise<Result<void>> {
		try {
			const resp = await fetch(url, { method: "PUT", body: data as BodyInit });
			if (!resp.ok) {
				const text = await resp.text().catch(() => "");
				return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
			}
			return { ok: true, value: undefined };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}
}

function extractSuffix(fileName: string): string | undefined {
	const dot = fileName.lastIndexOf(".");
	if (dot <= 0 || dot === fileName.length - 1) return undefined;
	return fileName.slice(dot + 1).toLowerCase();
}