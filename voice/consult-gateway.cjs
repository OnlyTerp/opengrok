#!/usr/bin/env node
'use strict';
// Consult completion gateway. Live now on 18795 so 18793 does not need a mid-call restart.
// On completed/failed, pushes to captain via existing POST /consult.result (no poll).
const http = require('http');
const { createBus } = require('./lib/consult-bus.cjs');
const { log } = require('./lib/shared.cjs');

const PORT = Number(process.env.CONSULT_GW_PORT || 18795);
const CAPTAIN_POST = process.env.CONSULT_CAPTAIN_POST || 'http://127.0.0.1:18793/consult.result';

const bus = createBus(function () { log.apply(null, ['consult.gw'].concat(Array.from(arguments))); });

function readJson(req, cb) {
  const chunks = [];
  req.on('data', function (d) { chunks.push(d); if (Buffer.concat(chunks).length > 120000) req.destroy(); });
  req.on('end', function () {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch (e) { cb(e); }
  });
  req.on('error', cb);
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}

function pushCaptain(payload, cb) {
  const url = new URL(CAPTAIN_POST);
  const body = JSON.stringify(payload);
  const req = http.request({
    hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
  }, function (r) {
    const chunks = [];
    r.on('data', function (d) { chunks.push(d); });
    r.on('end', function () { cb(null, r.statusCode, Buffer.concat(chunks).toString('utf8')); });
  });
  req.on('error', function (e) { cb(e); });
  req.setTimeout(4000, function () { try { req.destroy(); } catch (e) {} cb(new Error('captain_timeout')); });
  req.end(body);
}

const server = http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' }); res.end(); return; }
  if (req.url === '/health') {
    const o = bus.open();
    return json(res, 200, { ok: true, service: 'consult-gateway', port: PORT, open: o });
  }
  if (req.method === 'GET' && (req.url === '/consult' || req.url === '/consult/open' || req.url.indexOf('/consult/status') === 0)) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const id = u.searchParams.get('id') || u.searchParams.get('consult_id');
    if (id) return json(res, 200, { ok: true, consult: bus.get(id) });
    return json(res, 200, { ok: true, consult: bus.open() });
  }
  if (req.method === 'POST' && (req.url === '/consult' || req.url === '/consult/start')) {
    return readJson(req, function (err, body) {
      if (err) return json(res, 400, { ok: false, error: 'bad_json' });
      return json(res, 200, bus.start(body || {}));
    });
  }
  if (req.method === 'POST' && (req.url === '/consult/ping' || req.url === '/consult/complete' || req.url === '/consult.result' || req.url === '/consult-result')) {
    return readJson(req, function (err, body) {
      if (err) return json(res, 400, { ok: false, error: 'bad_json' });
      body = body || {};
      if (req.url === '/consult/complete' && !body.status) body.status = 'completed';
      if ((req.url === '/consult.result' || req.url === '/consult-result') && !body.status) body.status = 'completed';
      const out = bus.ping(body);
      if (!out.ok) return json(res, 400, out);
      const terminal = (out.status === 'completed' || out.status === 'failed') && !out.duplicate;
      if (!terminal) return json(res, 200, out);
      const envelope = {
        text: out.status === 'failed'
          ? JSON.stringify({ consult_id: out.consult_id, status: 'failed', error: out.error || 'failed', rtt_ms: out.rtt_ms })
          : JSON.stringify({ consult_id: out.consult_id, status: 'completed', answer: body.text || body.answer || body.result || '', rtt_ms: out.rtt_ms }),
        consult_id: out.consult_id,
        status: out.status,
        answer: body.text || body.answer || body.result || '',
        error: out.error || ''
      };
      pushCaptain(envelope, function (e, code) {
        if (e) {
          log('consult.gw', 'push.fail', e.message, 'rtt_ms=' + out.rtt_ms);
          out.pushed = false;
          out.push_error = e.message;
          return json(res, 200, out);
        }
        log('consult.gw', 'push.ok', code, 'rtt_ms=' + out.rtt_ms, out.consult_id);
        out.pushed = code === 200;
        out.push_status = code;
        return json(res, 200, out);
      });
    });
  }
  json(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', function () {
  log('consult.gw', 'listening', PORT, 'push', CAPTAIN_POST);
  console.log('consult-gateway ' + PORT);
});
