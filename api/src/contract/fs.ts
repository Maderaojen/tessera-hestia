/** Filesystem browsing DTOs; only directories are selectable project paths. */
export type DirEntry = { name: string; path: string };
export type DirListing = { path: string; parent: string | null; entries: DirEntry[] };
export type DirSearchEntry = DirEntry & { relativePath: string };
export type SearchIncompleteReason = 'timeout' | 'limit' | 'unreadable' | 'symlink';
/** complete only proves uniqueness when the entire descendant scope was read. */
export type DirSearch = { path: string; entries: DirSearchEntry[]; complete: boolean; incompleteReasons: SearchIncompleteReason[] };
