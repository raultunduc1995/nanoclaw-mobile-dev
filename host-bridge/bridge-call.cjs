#!/usr/bin/env node
/**
 * bridge-call.js — CLI helper for calling the NanoClaw host bridge.
 *
 * Usage:
 *   node bridge-call.js <host> <payload-json>
 *   node bridge-call.js work '{"type":"shell","command":"whoami"}'
 *   node bridge-call.js work '{"type":"read","path":"~/Desktop/notes.txt"}'
 *   node bridge-call.js work '{"type":"ls","path":"~/Documents"}'
 *   node bridge-call.js work '{"type":"write","path":"~/test.txt","content":"hello"}'
 *   node bridge-call.js work '{"type":"system","action":"uptime"}'
 *
 * Host can be a name from mac-hosts.json or a raw IP:port like 192.168.1.176:3737.
 * BRIDGE_SECRET is read from the .env file in the nanoclaw root.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load .env from nanoclaw root
const envPath = path.join(__dirname, '..', '.env');
const env = fs.readFileSync(envPath, 'utf8');
const SECRET = env.match(/BRIDGE_SECRET=(.+)/)?.[1]?.trim();
if (!SECRET) { console.error('BRIDGE_SECRET not found in .env'); process.exit(1); }

// Load mac-hosts.json
const hostsPath = path.join(__dirname, 'mac-hosts.json');
const { hosts } = JSON.parse(fs.readFileSync(hostsPath, 'utf8'));

function resolveHost(name) {
  // Try named host first
  const found = hosts.find(h => h.name === name);
  if (found) return { ip: found.ip, port: found.port };
  // Try raw ip:port
  const match = name.match(/^(.+):(\d+)$/);
  if (match) return { ip: match[1], port: parseInt(match[2]) };
  // Try raw ip with default port
  return { ip: name, port: 3737 };
}

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function call(ip, port, payload) {
  return new Promise((resolve, reject) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const sig = sign(body);
    const req = http.request({
      hostname: ip, port, path: '/run', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-signature': sig },
      timeout: 35000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, stderr: 'Invalid JSON response: ' + data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  const [,, hostArg, payloadArg] = process.argv;
  if (!hostArg || !payloadArg) {
    console.error('Usage: node bridge-call.js <host> <payload-json>');
    console.error('Hosts:', hosts.map(h => `${h.name} (${h.ip}:${h.port})`).join(', '));
    process.exit(1);
  }

  const { ip, port } = resolveHost(hostArg);
  let payload;
  try { payload = JSON.parse(payloadArg); }
  catch { console.error('Invalid JSON payload'); process.exit(1); }

  try {
    const result = await call(ip, port, payload);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
