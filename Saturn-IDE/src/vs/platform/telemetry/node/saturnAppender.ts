/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saturn. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IRequestService, NO_FETCH_TELEMETRY } from '../../request/common/request.js';
import { ITelemetryAppender } from '../common/telemetryUtils.js';
import { ITelemetryData } from '../common/telemetry.js';

/** Flush when this many events are queued, or after the idle delay below, whichever comes first. */
const BATCH_SIZE = 30;
const FLUSH_DELAY = 5000;

/**
 * Sends Saturn IDE's built-in telemetry to the local Saturn runtime instead of to Microsoft. Events are
 * batched and POSTed to the runtime's `/telemetry/vscode`, with the runtime session token so the (authenticated)
 * runtime accepts them. Nothing leaves this machine: the runtime is on 127.0.0.1 and records events locally.
 */
export class SaturnTelemetryAppender implements ITelemetryAppender {

	private _batch: { name: string; data: ITelemetryData; ts: string }[] = [];
	private _timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _endpoint: string,
		private readonly _requestService: IRequestService,
	) { }

	/** The runtime session token, from the 0600 token file; empty when the runtime has not written it yet. */
	private _token(): string {
		try {
			return readFileSync(`${process.env['SATURN_DATA_DIR'] || `${homedir()}/.saturn-app`}/runtime-token`, 'utf8').trim();
		} catch {
			return '';
		}
	}

	log(eventName: string, data: ITelemetryData): void {
		this._batch.push({ name: eventName, data: data ?? {}, ts: new Date().toISOString() });
		if (this._batch.length >= BATCH_SIZE) {
			void this.flush();
		} else if (!this._timer) {
			this._timer = setTimeout(() => void this.flush(), FLUSH_DELAY);
		}
	}

	async flush(): Promise<void> {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
		if (this._batch.length === 0) {
			return;
		}
		const events = this._batch;
		this._batch = [];
		const token = this._token();
		try {
			await this._requestService.request({
				type: 'POST',
				url: this._endpoint,
				headers: {
					'Content-Type': 'application/json',
					...(token ? { 'Authorization': `Bearer ${token}` } : {}),
				},
				data: JSON.stringify({ events }),
				callSite: NO_FETCH_TELEMETRY, // sending telemetry must not itself be telemetered
			}, CancellationToken.None);
		} catch {
			// The local runtime may be starting or stopped; drop this batch rather than retry forever.
		}
	}
}
