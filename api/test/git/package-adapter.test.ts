import {expect,it} from 'vitest';
import * as shared from '@maderaojen/git-parse';
import * as status from '../../src/git/status-parse.js';
import * as log from '../../src/git/log-parse.js';
import * as diff from '../../src/git/diff-parse.js';
import type {RepoBranchState,RepoFileChange,RepoCommitSummary,RepoDiff} from '../../src/contract/repo.js';
it('keeps existing module entry points on the package implementation',()=>{
 expect(status.parsePorcelainV2).toBe(shared.parsePorcelainV2);
 expect(status.relativeToRoot).toBe(shared.relativeToRoot);
 expect(log.parseLogSummaries).toBe(shared.parseLogSummaries);
 expect(log.parseDiffTreeFiles).toBe(shared.parseDiffTreeFiles);
 expect(diff.parseUnifiedDiff).toBe(shared.parseUnifiedDiff);
});
it('keeps parser output structurally compatible with host API DTOs',()=>{
 const parsedStatus:{branch:RepoBranchState;files:RepoFileChange[]}=shared.parsePorcelainV2('# branch.head main\0? app/new.ts\0','app/');
 const parsedLog:RepoCommitSummary[]=shared.parseLogSummaries('sha\x1f\x1fA\x1fa@x\x1f1\x1fSubject\0');
 const parsedDiff:Pick<RepoDiff,'status'|'binary'|'truncated'|'hunks'>=shared.parseUnifiedDiff('@@ -0,0 +1 @@\n+Hello\n');
 expect(parsedStatus.files[0]?.path).toBe('new.ts');expect(parsedLog[0]?.subject).toBe('Subject');expect(parsedDiff.hunks[0]?.lines[0]?.text).toBe('Hello');
});
