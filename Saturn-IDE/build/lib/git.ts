/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import fs from 'fs';

/**
 * Returns the sha1 commit version of a repository or undefined in case of failure.
 */
export function getVersion(repo: string): string | undefined {
	const found = findGitDir(repo);
	if (!found) {
		return undefined;
	}
	const { git, common } = found;
	const headPath = path.join(git, 'HEAD');
	let head: string;

	try {
		head = fs.readFileSync(headPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	if (/^[0-9a-f]{40}$/i.test(head)) {
		return head;
	}

	const refMatch = /^ref: (.*)$/.exec(head);

	if (!refMatch) {
		return undefined;
	}

	const ref = refMatch[1];
	const refPath = path.join(common, ref);

	try {
		return fs.readFileSync(refPath, 'utf8').trim();
	} catch (e) {
		// noop
	}

	const packedRefsPath = path.join(common, 'packed-refs');
	let refsRaw: string;

	try {
		refsRaw = fs.readFileSync(packedRefsPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	const refsRegex = /^([0-9a-f]{40})\s+(.+)$/gm;
	let refsMatch: RegExpExecArray | null;
	const refs: { [ref: string]: string } = {};

	while (refsMatch = refsRegex.exec(refsRaw)) {
		refs[refsMatch[2]] = refsMatch[1];
	}

	return refs[ref];
}

/**
 * Saturn: the git directory for `repo`, or for the nearest repository above it. Saturn IDE lives in the Saturn-App
 * repository's `Saturn-IDE/` folder, which has no `.git` of its own; without this the build found no commit, so
 * product.json had none and the built app treated itself as a dev build (loading node_modules instead of
 * node_modules.asar, which left the terminal without xterm). A `.git` file (a linked worktree) is followed to its
 * git directory, whose refs live in the shared common directory.
 */
function findGitDir(repo: string): { git: string; common: string } | undefined {
	let dir = path.resolve(repo);
	for (;;) {
		const candidate = path.join(dir, '.git');
		try {
			const stat = fs.statSync(candidate);
			if (stat.isDirectory()) {
				return { git: candidate, common: candidate };
			}
			const pointer = /^gitdir: (.*)$/m.exec(fs.readFileSync(candidate, 'utf8'));
			if (pointer) {
				const git = path.resolve(dir, pointer[1].trim());
				let common = git;
				try {
					common = path.resolve(git, fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim());
				} catch (e) {
					// not a linked worktree
				}
				return { git, common };
			}
		} catch (e) {
			// no .git here; keep looking upward
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}
