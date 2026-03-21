---
name: mac-control
description: Control Macs on the local network — run shell commands, AppleScript, or system actions (restart, sleep, lock) on personal or work MacBook. Use when the user asks to do something on a specific Mac.
allowed-tools: Bash
---

# Mac Control

You can control Macs on the local network via the host bridge.

## Available Macs

Read `/workspace/project/host-bridge/mac-hosts.json` to see available Macs and their IPs.

Typical names: `personal`, `work`

## How to send a command

Use a Node heredoc to avoid shell quoting issues.

```bash
node - <<'NODESCRIPT'
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

const SECRET = process.env.BRIDGE_SECRET;
const hosts = JSON.parse(fs.readFileSync('/workspace/project/host-bridge/mac-hosts.json', 'utf8')).hosts;

async function macControl(name, payload) {
  const host = hosts.find(h => h.name === name);
  if (!host) throw new Error(`Host not found: ${name}. Available: ${hosts.map(h=>h.name).join(', ')}`);

  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host.ip,
      port: host.port || 3737,
      path: '/run',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Signature': sig,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---- YOUR COMMAND HERE ----
macControl('personal', { type: 'system', action: 'hostname' })
  .then(r => console.log(JSON.stringify(r, null, 2)))
  .catch(e => console.error('Error:', e.message));
NODESCRIPT
```

## Command types

### Shell command
```js
macControl('personal', { type: 'shell', command: 'ls ~/Desktop' })
```

### AppleScript
```js
macControl('work', { type: 'applescript', script: 'display notification "Hello from Nano" with title "Nano"' })
```

### System actions
```js
macControl('personal', { type: 'system', action: 'restart' })   // restart
macControl('personal', { type: 'system', action: 'sleep' })     // sleep
macControl('personal', { type: 'system', action: 'lock' })      // lock screen
macControl('personal', { type: 'system', action: 'uptime' })    // get uptime
macControl('personal', { type: 'system', action: 'hostname' })  // get hostname
```

## Response format

```json
{ "ok": true, "stdout": "output here", "stderr": "" }
{ "ok": false, "stdout": "", "stderr": "error message" }
```

## Full example — list Desktop files on personal Mac

```bash
node - <<'EOF'
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const SECRET = process.env.BRIDGE_SECRET;
const hosts = JSON.parse(fs.readFileSync('/workspace/project/host-bridge/mac-hosts.json','utf8')).hosts;
function macControl(name, payload) {
  const host = hosts.find(h=>h.name===name);
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256',SECRET).update(body).digest('hex');
  return new Promise((resolve,reject)=>{
    const req = http.request({hostname:host.ip,port:host.port||3737,path:'/run',method:'POST',
      headers:{'Content-Type':'application/json','X-Bridge-Signature':sig,'Content-Length':Buffer.byteLength(body)}},
      res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});
    req.on('error',reject);req.write(body);req.end();
  });
}
macControl('personal',{type:'shell',command:'ls ~/Desktop'})
  .then(r=>console.log(r.stdout||r.stderr))
  .catch(e=>console.error(e.message));
EOF
```

## Notes

- This skill only works in the **main group** (which mounts the project at `/workspace/project`). Non-main groups do not have access to `mac-hosts.json`.
- All Macs must be on the same WiFi network for cross-Mac commands
- Always use LAN IPs in mac-hosts.json — never 127.0.0.1 (inside Docker it points to the container, not the host)
- Commands run as the user who installed the bridge
- BRIDGE_SECRET is injected automatically into every container
