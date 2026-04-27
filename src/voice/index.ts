import http from 'http';
import { logger } from '../core/utils/logger.js';

const VOICE_PORT = 3739;

export function startVoiceServer(onVoiceInput: (text: string) => void): void {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/voice') {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body) as { text: string };
        if (!text?.trim()) {
          res.writeHead(400).end(JSON.stringify({ error: 'text is required' }));
          return;
        }
        logger.info({ text }, 'Voice input received');
        onVoiceInput(text.trim());
        res.writeHead(202).end(JSON.stringify({ status: 'accepted' }));
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
  });

  server.listen(VOICE_PORT, () => {
    logger.info(`Voice server listening on port ${VOICE_PORT}`);
  });
}
