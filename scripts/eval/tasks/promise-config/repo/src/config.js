import { readFile } from 'node:fs';

const DEFAULTS = { host: 'localhost', port: 8080, debug: false };

/** Reads a JSON config file and fills in defaults; calls back with (error, config). */
export function readConfig(file, callback) {
  readFile(file, 'utf8', (error, text) => {
    if (error) return callback(error);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      return callback(parseError);
    }
    callback(null, { ...DEFAULTS, ...parsed });
  });
}
