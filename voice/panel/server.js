#!/usr/bin/env node
'use strict';
// Static server for the voice panel + /api/health proxy to the voice gateway.
// Serves voice/panel/index.html at http://127.0.0.1:8094
const http = require('http');
const fs = require('fs');
const path = require('path');

const PANEL_PORT = Number(process.env.VOICE_PANEL_PORT || 8094);
const GW_URL = process.env.VOICE_GW_URL || 'http://127.0.0.1:18793';
const PANEL_DIR = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function proxyHealth(cb) {
  const req = http.get(GW_URL + '/health', function (r) {
    const chunks = [];
    r.on('data', function (d) { chunks.push(d); });
    r.on('end', function () {
      try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { cb(e); }
    });
  });
  req.on('error', function (e) { cb(e); });
  req.setTimeout(2500, function () { try { req.destroy(); } catch (e) {} cb(new Error('gateway timeout')); });
}

const server = http.createServer(function (req, res) {
  if (req.url === '/api/health') {
    return proxyHealth(function (err, h) {
      if (err) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ gateway: false, error: err.message }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(h));
    });
  }
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PANEL_DIR, urlPath));
  if (!file.startsWith(PANEL_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PANEL_PORT, '127.0.0.1', function () {
  console.log('voice panel  http://127.0.0.1:' + PANEL_PORT);
});
