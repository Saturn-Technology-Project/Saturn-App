import { readFile } from 'node:fs';

const DEFAULTS = { host: 'localhost', port: 8080, debug: false };

/**
 * Reads a JSON config file and fills in defaults. With a callback it calls back with (error, config); without
 * one it returns a promise of the config.
 */
export function readConfig(file, callback) {
  if (typeof callback !== 'function') {
    return new Promise((resolve, reject) => readConfig(file, (error, config) => (error ? reject(error) : resolve(config))));
  }
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
