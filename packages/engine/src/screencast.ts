import type { Page } from 'playwright';

export interface ScreencastOptions {
  /** Frames per second sent on; the browser may produce more. */
  fps?: number;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * Streams a page's screen as JPEG frames (base64) through Chromium's screencast.
 * Frames are throttled so a remote viewer gets a steady, cheap feed.
 * Returns a function that stops the stream; it also stops when the page closes.
 */
export async function startScreencast(page: Page, onFrame: (jpegBase64: string) => void, opts: ScreencastOptions = {}): Promise<() => Promise<void>> {
  const minGap = 1000 / (opts.fps ?? 5);
  const cdp = await page.context().newCDPSession(page);
  let last = 0;
  let stopped = false;
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    const now = Date.now();
    if (now - last < minGap) return;
    last = now;
    onFrame(f.data);
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: opts.quality ?? 50,
    maxWidth: opts.maxWidth ?? 960,
    maxHeight: opts.maxHeight ?? 600,
    everyNthFrame: 1,
  });
  return async () => {
    if (stopped) return;
    stopped = true;
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  };
}
