/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IConfig {
	// The client ID of the GitHub OAuth app
	gitHubClientId: string;
	gitHubClientSecret?: string;
}

// For easy access to mixin client ID and secret
//
// NOTE: GitHub client secrets cannot be secured when running in a native client so in other words, the client secret is
// not really a secret... so we allow the client secret in code. It is brought in before we publish VS Code. Reference:
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app#client-secrets
//
// Saturn: Saturn IDE signs in with its own GitHub OAuth app ("Saturn IDE"), so GitHub's consent page names Saturn
// rather than Visual Studio Code. It ships no client secret, which leaves the device code flow (and personal access
// tokens): the browser flows need a secret or Microsoft's vscode.dev code exchange, which only serves VS Code's app.
export const Config: IConfig = {
	gitHubClientId: 'Ov23liE7LVSI7L5ho0JH'
};
