import type { Request, Response } from 'express';
import { streamAuthentication } from '../auth.js';
import { SSE_HEARTBEAT_MS } from '../config.js';

// Starts a Server-Sent Events response and keeps it alive with comment
// heartbeats until the client disconnects. Returns the function that sends
// one `data:` event; callers still listen for req 'close' to drop their own
// subscription.
export function openSse(req: Request, res: Response): (data: unknown) => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Stops nginx-style proxies from buffering the stream into batches.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const auth = streamAuthentication(req, () => res.end());
  const authorized = () => {
    if (res.writableEnded || res.destroyed) return false;
    if (auth.valid()) return true;
    res.end();
    return false;
  };
  const heartbeat = setInterval(() => { if (authorized()) res.write(': heartbeat\n\n'); }, SSE_HEARTBEAT_MS);
  const dispose = () => { clearInterval(heartbeat); auth.dispose(); };
  res.on('close', dispose);
  req.on('close', dispose);
  return (data) => { if (authorized()) res.write(`data: ${JSON.stringify(data)}\n\n`); };
}
