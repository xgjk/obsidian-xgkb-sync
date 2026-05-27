import type { XgkbChangeItem, XgkbMetaItem, SyncStateRecord } from "./types";

/** 增量 / move 诊断（仅 console.debug，不改变同步行为） */
export function syncDiag(msg: string, data?: Record<string, unknown>): void {
	if (data !== undefined) {
		console.debug(`[XGKB Sync][diag] ${msg}`, data);
	} else {
		console.debug(`[XGKB Sync][diag] ${msg}`);
	}
}

export function syncDiagListChangesItems(items: XgkbChangeItem[]): void {
	syncDiag(`listChanges 原始条目 (${items.length} 条)`);
	for (const item of items) {
		syncDiag("listChanges item", {
			fileId: String(item.fileId),
			event: item.event,
			type: item.type,
			name: item.name,
			parentId: item.parentId != null ? String(item.parentId) : null,
			updateTime: item.updateTime,
		});
	}
}

/** openclaw tryIncrementalRemoteMap 同款：meta.parentId/name vs DB remoteFolderId/本地文件名 */
export function syncDiagKnownUpsert(
	fileId: string,
	record: SyncStateRecord,
	item: XgkbChangeItem,
	meta: XgkbMetaItem | undefined,
	folderIdToPath: Map<string, string>
): void {
	const itemParent = item.parentId != null ? String(item.parentId) : null;
	const metaParent = meta?.parentId != null ? String(meta.parentId) : null;
	const oldParentId = record.xgkbFolderId;
	const oldName = record.localPath.split("/").pop() ?? "";
	const itemName = item.name ?? null;
	const metaName = meta?.name ?? null;

	const newParentForOpenclaw = metaParent ?? "";
	const newNameForOpenclaw = metaName ?? "";
	const openclawWouldDetect =
		Boolean(newParentForOpenclaw && oldParentId) &&
		(newParentForOpenclaw !== oldParentId || newNameForOpenclaw !== oldName);
	const openclawFolderPath = newParentForOpenclaw
		? folderIdToPath.get(newParentForOpenclaw)
		: undefined;

	syncDiag("knownUpsert 数据源对比（openclaw 检测条件见 openclaw-xgkb-sync syncEngine.ts:876-903）", {
		fileId,
		recordLocalPath: record.localPath,
		recordXgkbFolderId: oldParentId,
		recordRemoteMtime: record.remoteMtime,
		listChanges: {
			parentId: itemParent,
			name: itemName,
			type: item.type,
			updateTime: item.updateTime,
		},
		batchGetMeta: meta
			? {
					parentId: metaParent,
					name: metaName,
					updateTime: meta.updateTime,
					deleted: meta.deleted,
				}
			: null,
		parentIdItemVsMeta: itemParent === metaParent ? "same" : "DIFF",
		parentIdItemVsRecord: itemParent === oldParentId ? "same" : "DIFF",
		parentIdMetaVsRecord: metaParent === oldParentId ? "same" : "DIFF",
		nameMetaVsRecord: metaName === oldName ? "same" : "DIFF",
		openclawWouldDetectMoveOrRename: openclawWouldDetect,
		openclawNewParentFolderPath: openclawFolderPath ?? null,
		openclawNewParentInFolderMap: openclawFolderPath !== undefined,
	});
}

export function syncDiagPathResolve(
	fileId: string,
	recordPath: string,
	remotePath: string,
	opts: {
		parentIdUsed: string;
		fileNameUsed: string;
		folderPathFromMap: string | undefined;
		usedFallback: boolean;
	}
): void {
	syncDiag("knownUpsert 路径重建结果", {
		fileId,
		recordPath,
		remotePath,
		pathsEqual: recordPath === remotePath,
		parentIdUsed: opts.parentIdUsed || null,
		fileNameUsed: opts.fileNameUsed,
		folderPathFromMap: opts.folderPathFromMap ?? null,
		usedFallback: opts.usedFallback,
	});
}

export function syncDiagFolderMapSnapshot(
	label: string,
	folderIdToPath: Map<string, string>,
	folderIds: Iterable<string>
): void {
	const snapshot: Record<string, string | null> = {};
	for (const id of folderIds) {
		const sid = String(id);
		if (!sid) continue;
		snapshot[sid] = folderIdToPath.get(sid) ?? null;
	}
	syncDiag(label, snapshot);
}

export function syncDiagHydrate(
	phase: string,
	data: Record<string, unknown>
): void {
	syncDiag(`hydrate ${phase}`, data);
}

/** listChanges 中 type=1 目录 upsert 的应用结果 */
export function syncDiagFolderUpsertApply(
	results: Array<{
		folderId: string;
		name: string;
		parentId: string;
		oldPath: string | null;
		newPath: string | null;
		status: "applied" | "skipped_parent_unknown" | "unchanged";
	}>
): void {
	syncDiag(`folderUpsert 应用结果 (${results.length} 条)`, {
		items: results,
		applied: results.filter((r) => r.status === "applied").length,
		skipped: results.filter((r) => r.status === "skipped_parent_unknown").length,
	});
}

export function syncDiagReconcile(
	kind: "plan" | "skip" | "match",
	fileId: string,
	detail: Record<string, unknown>
): void {
	syncDiag(`reconcile ${kind}`, { fileId, ...detail });
}
