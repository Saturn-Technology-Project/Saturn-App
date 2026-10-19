/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saturn. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import './media/saturn.css';

// Saturn IDE > Preferences > Saturn Settings, right below Settings: opens the Saturn app's Settings window
// (the `saturn.openAppSettings` command of the built-in Saturn extension) without the rest of the app.
MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
	command: {
		id: 'saturn.openAppSettings',
		title: localize({ key: 'miSaturnSettings', comment: ['&& denotes a mnemonic'] }, "Saturn &&Settings")
	},
	group: '2_configuration',
	order: 2.5
});
