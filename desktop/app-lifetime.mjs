export const INDEPENDENT_APP_ENV = 'EXOMINA_WINDOWS_INDEPENDENT';

/**
 * Start normally through Windows. Do not recreate this process through a
 * PowerShell/CreateProcess suspended-job-breakaway relay. Process lifetime
 * belongs to the caller: launch the installed shortcut from the Windows shell.
 * Keep this small compatibility entry point for startup journal consumers.
 */
export async function ensureWindowsAppIndependence({env = process.env} = {}) {
  delete env[INDEPENDENT_APP_ENV];
  return {handedOff: false, status: 'not-required'};
}
