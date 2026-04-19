#!/usr/bin/env node
/**
 * NanoClaw Host Bridge
 * Runs on each Mac you want to control. Accepts signed HTTP requests from
 * the container agent and executes shell commands, AppleScript, or system
 * actions on the host.
 *
 * Security: requests must be signed with BRIDGE_SECRET (HMAC-SHA256).
 * Listens on 0.0.0.0 so it's reachable from Docker containers and other
 * Macs on the same LAN. Do NOT expose this port to the internet.
 *
 * Installed as a launchd service via install.sh.
 */
const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');

const PORT = parseInt(process.env.BRIDGE_PORT || '3737', 10);
const SECRET = process.env.BRIDGE_SECRET;

if (!SECRET) {
  console.error('BRIDGE_SECRET environment variable is required');
  process.exit(1);
}

function verifySignature(body, signature) {
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

async function handleRequest(req, res) {
  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const signature = req.headers['x-bridge-signature'];
  if (!signature || !verifySignature(body, signature)) {
    res.writeHead(401); res.end(JSON.stringify({ error: 'Invalid signature' })); return;
  }
  let payload;
  try { payload = JSON.parse(body); }
  catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

  const { type, command, script, action, path: filePath, content, encoding } = payload;
  try {
    let stdout = '';
    if (type === 'read') {
      if (!filePath) throw new Error('path is required for type=read');
      const resolved = filePath.replace(/^~/, os.homedir());
      const data = fs.readFileSync(resolved, { encoding: encoding || 'utf8' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, content: data, stderr: '' }));
      return;
    } else if (type === 'write') {
      if (!filePath) throw new Error('path is required for type=write');
      if (content === undefined) throw new Error('content is required for type=write');
      const resolved = filePath.replace(/^~/, os.homedir());
      fs.mkdirSync(require('path').dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, { encoding: encoding || 'utf8' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stdout: `Written ${content.length} bytes to ${resolved}`, stderr: '' }));
      return;
    } else if (type === 'ls') {
      if (!filePath) throw new Error('path is required for type=ls');
      const resolved = filePath.replace(/^~/, os.homedir());
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const result = entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entries: result, stderr: '' }));
      return;
    } else if (type === 'shell') {
      if (!command) throw new Error('command is required for type=shell');
      stdout = execSync(command, { encoding: 'utf8', timeout: 30000, shell: '/bin/zsh',
        env: { ...process.env, HOME: os.homedir() }, stdio: ['ignore', 'pipe', 'pipe'] }) || '';
    } else if (type === 'applescript') {
      if (!script) throw new Error('script is required for type=applescript');
      stdout = execSync(`osascript -e ${JSON.stringify(script)}`, { encoding: 'utf8', timeout: 30000 });
    } else if (type === 'system') {
      const actions = {
        restart: `osascript -e 'tell app "System Events" to restart'`,
        shutdown: `osascript -e 'tell app "System Events" to shut down'`,
        sleep: 'pmset sleepnow',
        lock: '/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend',
        hostname: `echo "${os.hostname()}"`,
        whoami: 'whoami',
        uptime: 'uptime',
      };
      if (!action || !actions[action])
        throw new Error(`Unknown system action: ${action}. Valid: ${Object.keys(actions).join(', ')}`);
      stdout = execSync(actions[action], { encoding: 'utf8', timeout: 10000 });
    } else {
      throw new Error(`Unknown type: ${type}. Valid: shell, applescript, system, read, write, ls`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stdout: stdout.trim(), stderr: '' }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, stdout: (err.stdout||'').trim(), stderr: (err.stderr||err.message||String(err)).trim() }));
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  handleRequest(req, res).catch(err => { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NanoClaw host bridge listening on 0.0.0.0:${PORT}`);
  console.log(`Hostname: ${os.hostname()}`);
});
