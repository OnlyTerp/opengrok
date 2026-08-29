'use strict';
// In-memory consult registry. One pending consult at a time (voice line).
const crypto = require('crypto');

const OPEN = { queued: 1, in_progress: 1 };
const STATUSES = { queued: 1, in_progress: 1, completed: 1, failed: 1 };

function fingerprint(question, agentId) {
  const q = String(question || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const a = String(agentId || '').trim().toLowerCase();
  return crypto.createHash('sha1').update(a + '\n' + q).digest('hex').slice(0, 16);
}

function newId() {
  return 'c_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function createBus(log) {
  const byId = new Map();
  let openId = '';

  function snapshot(row) {
    if (!row) return null;
    const rtt = row.endedAt ? (row.endedAt - row.startedAt) : (Date.now() - row.startedAt);
    return {
      consult_id: row.id,
      status: row.status,
      agent: row.agent,
      agent_id: row.agentId,
      fingerprint: row.fp,
      question: row.question,
      started_at: row.startedAt,
      ended_at: row.endedAt || 0,
      rtt_ms: rtt,
      error: row.error || '',
      duplicate: !!row.duplicate
    };
  }

  function open() {
    if (!openId) return null;
    return byId.get(openId) || null;
  }

  function start(input) {
    const question = String((input && input.question) || '').trim();
    const agent = String((input && (input.agent || input.agent_name)) || 'assistant');
    const agentId = String((input && (input.agent_id || input.agentId)) || '');
    const fp = fingerprint(question, agentId);
    const cur = open();
    if (cur && OPEN[cur.status]) {
      const dup = cur.fp === fp || (!question && true);
      if (log) log('consult.bus skip-dup', cur.id, cur.status, fp);
      return Object.assign(snapshot(cur), { ok: true, duplicate: true, reason: 'already_pending' });
    }
    const id = String((input && (input.consult_id || input.id)) || newId());
    const row = {
      id: id,
      fp: fp,
      status: 'queued',
      agent: agent,
      agentId: agentId,
      question: question,
      startedAt: Date.now(),
      endedAt: 0,
      error: '',
      text: ''
    };
    byId.set(id, row);
    openId = id;
    if (log) log('consult.bus queued', id, agent, question.slice(0, 80));
    return Object.assign(snapshot(row), { ok: true, duplicate: false });
  }

  function ping(input) {
    const status = String((input && input.status) || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!STATUSES[status]) {
      return { ok: false, error: 'bad_status', allowed: Object.keys(STATUSES) };
    }
    let row = null;
    const id = String((input && (input.consult_id || input.id)) || '');
    if (id && byId.has(id)) row = byId.get(id);
    if (!row) row = open();
    if (!row && (status === 'queued' || status === 'in_progress')) {
      return start(Object.assign({}, input, { }));
    }
    if (!row) return { ok: false, error: 'no_open_consult' };

    if (status === 'queued' && OPEN[row.status]) {
      return Object.assign(snapshot(row), { ok: true, duplicate: true, reason: 'already_pending' });
    }
    if (status === 'in_progress') {
      if (row.status === 'completed' || row.status === 'failed') {
        return Object.assign(snapshot(row), { ok: true, duplicate: true, reason: 'already_terminal' });
      }
      row.status = 'in_progress';
      if (log) log('consult.bus in_progress', row.id);
      return Object.assign(snapshot(row), { ok: true, duplicate: false });
    }
    if (status === 'completed' || status === 'failed') {
      if (row.status === 'completed' || row.status === 'failed') {
        if (log) log('consult.bus dup-terminal', row.id, row.status);
        return Object.assign(snapshot(row), { ok: true, duplicate: true, reason: 'already_terminal' });
      }
      const text = String((input && (input.text || input.result || input.answer)) || '').trim();
      const err = String((input && input.error) || '').trim();
      if (status === 'completed' && !text) return { ok: false, error: 'missing_text', consult_id: row.id };
      row.status = status;
      row.text = text;
      row.error = err;
      row.endedAt = Date.now();
      if (openId === row.id) openId = '';
      const snap = snapshot(row);
      if (log) log('consult.bus', status, row.id, 'rtt_ms=' + snap.rtt_ms, (err || text).slice(0, 80));
      return Object.assign(snap, { ok: true, duplicate: false, text: text });
    }
    return Object.assign(snapshot(row), { ok: true });
  }

  return { start: start, ping: ping, open: function () { return snapshot(open()); }, get: function (id) { return snapshot(byId.get(id)); }, fingerprint: fingerprint, newId: newId };
}

module.exports = { createBus: createBus, fingerprint: fingerprint, newId: newId, OPEN: OPEN, STATUSES: STATUSES };
