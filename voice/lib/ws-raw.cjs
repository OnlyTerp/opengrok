#!/usr/bin/env node
'use strict';
const crypto = require('crypto');

class FrameDecoder {
  constructor(onFrame) { this.buf = Buffer.alloc(0); this.onFrame = onFrame; }
  push(data) { this.buf = Buffer.concat([this.buf, data]); this.parse(); }
  parse() {
    while (this.buf.length >= 2) {
      const opcode = this.buf[0] & 0x0f;
      const isMasked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const mkey = isMasked ? 4 : 0;
      if (this.buf.length < off + mkey + len) return;
      let payload = this.buf.slice(off + mkey, off + mkey + len);
      if (isMasked) {
        const mk = this.buf.slice(off, off + 4);
        const p = Buffer.from(payload);
        for (let i = 0; i < p.length; i++) p[i] ^= mk[i % 4];
        payload = p;
      }
      this.buf = this.buf.slice(off + mkey + len);
      this.onFrame(opcode, payload);
    }
  }
}

function maskFrame(opcode, buf) {
  const len = buf.length;
  let header;
  if (len < 126) header = Buffer.from([opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(buf);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function wsSendBinary(socket, buf) {
  if (!socket || !buf || !buf.length) return false;
  try { socket.write(maskFrame(0x82, buf)); return true; } catch (e) { return false; }
}

function wsSendText(socket, str) {
  if (!socket || str == null) return false;
  try { socket.write(maskFrame(0x81, Buffer.from(String(str), 'utf8'))); return true; } catch (e) { return false; }
}

function wsSendPing(socket, payload) {
  const body = payload || Buffer.alloc(0);
  if (!socket || body.length >= 126) return false;
  try { socket.write(maskFrame(0x89, body)); return true; } catch (e) { return false; }
}

function wsSendPong(socket, payload) {
  const body = payload || Buffer.alloc(0);
  if (!socket || body.length >= 126) return false;
  try { socket.write(maskFrame(0x8a, body)); return true; } catch (e) { return false; }
}

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function uiSendFrame(socket, data) {
  if (!socket) return;
  const payload = Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { socket.write(Buffer.concat([header, payload])); } catch (e) {}
}

// openai 900s, stt 900s: silence / rms 0 must not tear a live session.
// default 20s for anything else.
function idleMsFor(label) {
  if (label === 'openai' || label === 'stt') return 900000;
  return 20000;
}

function armSocketIdle(socket, label, onIdle, log) {
  let t = null;
  const idleMs = idleMsFor(label);
  function touch() {
    if (t) clearTimeout(t);
    t = setTimeout(function () {
      if (log) log(label, 'idle-timeout', idleMs);
      try { onIdle(); } catch (e) {}
    }, idleMs);
  }
  function clear() { if (t) { clearTimeout(t); t = null; } }
  if (!socket) return { touch: function () {}, clear: clear, idleMs: idleMs };
  socket.on('data', touch);
  socket.on('close', clear);
  socket.on('error', clear);
  touch();
  return { touch: touch, clear: clear, idleMs: idleMs };
}

module.exports = {
  FrameDecoder, maskFrame, wsSendBinary, wsSendText, wsSendPing, wsSendPong,
  wsAcceptKey, uiSendFrame, armSocketIdle, idleMsFor
};
