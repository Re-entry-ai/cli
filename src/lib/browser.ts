import { spawn } from 'child_process';

/**
 * Cross-platform browser opener. Throws if the platform isn't supported or
 * the spawn fails (caller decides whether to print a fallback message).
 *
 * macOS  →  `open <url>`
 * Linux  →  `xdg-open <url>`
 * Win32  →  `cmd /c start "" <url>`     (the empty string is the window title;
 *                                        without it, start treats a quoted URL
 *                                        as the title)
 */
export function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Defense-in-depth: refuse anything that isn't an http/https URL before
    // passing it to a subprocess. `spawn` with shell:false already prevents
    // shell injection; this guards against an unexpected backend response
    // (or env-var FRONTEND_URL misconfiguration) accidentally flowing a
    // path/flag-like value to `cmd /c start` on Windows.
    if (!/^https?:\/\//i.test(url)) {
      reject(new Error(`Refusing to open non-http(s) URL: ${url.slice(0, 64)}`));
      return;
    }

    const command =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'cmd'
          : 'xdg-open';

    const args =
      process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];

    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });

    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
