import {readFileSync} from 'node:fs';
import built from './app-version.json' with { type: 'json' };

// Desktop modules can be loaded from app.asar.unpacked by native helpers.
// A build-generated copy travels with those modules; source uses its manifest.
let version=built.version;
try { version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version; } catch { /* Unpacked runtime: use its own build metadata. */ }
export const APP_VERSION = version;
