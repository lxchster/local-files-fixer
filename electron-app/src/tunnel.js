'use strict';
// Optional "over the internet" link, using Cloudflare's free quick tunnel (cloudflared, no account needed).
// The program is downloaded once, on request, from Cloudflare's official GitHub release and checked against
// its published SHA-256 before it is ever run.
const { spawn, execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '2026.11.0';
const BASE = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/`;
const ASSETS = {
  'win32': { file: 'cloudflared-windows-amd64.exe', sha: 'd5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a', bin: 'cloudflared.exe', tgz: false, mb: 53 },
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', sha: '8a59d51120cebbe902f0a8d6e1b7a7fd4f9a5bb4dcb3e0f05872483e75e7db6b', bin: 'cloudflared', tgz: true, mb: 21 },
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha: '8c2f90277ef06a6080bb40b964d33f09f1188102f8798f2e344174b6cf41accf', bin: 'cloudflared', tgz: true, mb: 19 },
};
const assetKey = () => (process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin-' + (process.arch === 'arm64' ? 'arm64' : 'x64') : null);
const asset = () => ASSETS[assetKey()] || null;
const dirFor = (tools) => path.join(tools, 'cloudflared-' + VERSION);
const binPath = (tools) => { const a = asset(); return a ? path.join(dirFor(tools), a.bin) : null; };
const installed = (tools) => { const b = binPath(tools); return !!b && fs.existsSync(b); };

function fetchTo(url, dest, expectedSha, onProgress, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error('Too many redirects while downloading.'));
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Error('Refusing a non-HTTPS download.'));
    https.get(u, { headers: { 'User-Agent': 'local-files-toolkit' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return fetchTo(new URL(res.headers.location, u).toString(), dest, expectedSha, onProgress, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Download failed (HTTP ' + res.statusCode + ').')); }
      const total = Number(res.headers['content-length']) || 0, hash = crypto.createHash('sha256'), out = fs.createWriteStream(dest);
      let done = 0;
      res.on('data', (c) => { hash.update(c); done += c.length; if (onProgress) onProgress(done, total); });
      res.pipe(out);
      out.on('finish', () => {
        if (hash.digest('hex') !== expectedSha) { fs.rm(dest, { force: true }, () => {}); return reject(new Error('The download did not match its official checksum, so it was discarded.')); }
        resolve();
      });
      out.on('error', reject); res.on('error', reject);
    }).on('error', reject);
  });
}

async function download(tools, onProgress) {
  const a = asset(); if (!a) throw new Error('The internet option is not available on this system.');
  const dir = dirFor(tools); fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, a.file + '.download');
  await fetchTo(BASE + a.file, tmp, a.sha, onProgress);
  if (a.tgz) {
    await new Promise((resolve, reject) => execFile('tar', ['-xzf', tmp, '-C', dir], (e) => (e ? reject(new Error('Could not unpack the download.')) : resolve())));
    fs.rmSync(tmp, { force: true }); fs.chmodSync(path.join(dir, a.bin), 0o755);
  } else {
    fs.renameSync(tmp, path.join(dir, a.bin));
  }
}

let proc = null, publicUrl = null;

// Starts a tunnel to http://127.0.0.1:<port>. Resolves with the public host name (xxxx.trycloudflare.com).
function start(tools, port, onExit) {
  stop();
  const bin = binPath(tools);
  if (!bin || !fs.existsSync(bin)) return Promise.reject(new Error('The tunnel program is not installed.'));
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + port], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p; let settled = false, buf = '';
    const finish = (err, host) => { if (settled) return; settled = true; clearTimeout(timer); if (err) { try { p.kill(); } catch {} if (proc === p) proc = null; reject(err); } else resolve(host); };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the internet link. A firewall or filter may be blocking it.')), 40000);
    const onData = (d) => {
      buf = (buf + d).slice(-4000);
      const m = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i.exec(buf);
      if (m) { publicUrl = 'https://' + m[1]; finish(null, m[1]); }
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('error', (e) => finish(new Error('Could not start the tunnel program: ' + e.message)));
    p.on('exit', () => {
      if (proc === p) { proc = null; publicUrl = null; }
      if (!settled) finish(new Error('The tunnel program stopped before it connected.'));
      else if (onExit) onExit();
    });
  });
}

function stop() {
  const p = proc; proc = null; publicUrl = null;
  if (p) { try { p.kill(); } catch {} }
}

module.exports = { asset, installed, download, start, stop, current: () => publicUrl };
