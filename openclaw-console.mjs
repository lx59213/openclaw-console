#!/usr/bin/env node

/* ════════════════════════════════════════════════════
 *  OpenClaw 控制台 — 自包含单文件
 *  双击 openclaw-models.command 即可使用
 *
 *  API:
 *    GET  /api/config           读取 openclaw.json
 *    POST /api/config           写入 openclaw.json
 *    POST /api/fetch-models     代理拉取渠道模型列表
 *    GET  /api/sessions         列出所有会话 + 模型绑定
 *    POST /api/sessions/reset   清除所有会话的模型锁定
 *    POST /api/run              执行 openclaw CLI 命令
 *    GET  /api/logs             读取最近日志
 *    GET  /api/status           当前运行状态摘要
 * ════════════════════════════════════════════════════ */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execSync } from 'child_process';

const PORT = 9831;
const HOME = os.homedir();
const OC = path.join(HOME, '.openclaw');
const CONFIG = path.join(OC, 'openclaw.json');
const SESSIONS = path.join(OC, 'agents', 'main', 'sessions', 'sessions.json');
const LOG = path.join(OC, 'logs', 'gateway.log');
const ERR_LOG = path.join(OC, 'logs', 'gateway.err.log');

/* ═══════ 工具 ═══════ */

const readBody = (req) => new Promise((ok, fail) => {
  const c = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString())); req.on('error', fail);
});
const J = (res, data, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const httpReq = (url, headers = {}) => new Promise((ok, fail) => {
  const u = new URL(url); const mod = u.protocol === 'https:' ? https : http;
  const r = mod.request(u, { method: 'GET', headers }, res => {
    const c = []; res.on('data', d => c.push(d));
    res.on('end', () => { const body = Buffer.concat(c).toString(); res.statusCode >= 400 ? fail(new Error(`${res.statusCode}: ${body.slice(0, 300)}`)) : ok(body); });
  });
  r.on('error', fail); r.setTimeout(15000, () => { r.destroy(); fail(new Error('超时')); }); r.end();
});
const tail = (file, n = 50) => { try { const lines = fs.readFileSync(file, 'utf-8').split('\n'); return lines.slice(-n).join('\n'); } catch { return ''; } };

/* ═══════ 模型拉取 ═══════ */

async function fetchAnthropic(baseUrl, apiKey) {
  const all = []; let after = null;
  for (let i = 0; i < 5; i++) {
    const u = new URL(baseUrl.replace(/\/+$/, '') + '/v1/models');
    u.searchParams.set('limit', '100');
    if (after) u.searchParams.set('after_id', after);
    const raw = await httpReq(u.toString(), { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
    const d = JSON.parse(raw); const items = d.data || [];
    if (!items.length) break;
    for (const m of items) {
      const id = m.id;
      const thinking = !!(m.capabilities?.thinking) || /opus|sonnet-4|3-7/.test(id);
      const isOpus = /opus/i.test(id);
      all.push({ id, name: prettyName(id), reasoning: thinking, ctx: 200000, max: isOpus ? 32000 : thinking ? 16000 : 8192, created: m.created_at || '' });
    }
    if (!d.has_more) break; after = items[items.length - 1].id;
  }
  all.sort((a, b) => sortKey(b.id) - sortKey(a.id)); return all;
}
async function fetchOpenAI(baseUrl, apiKey) {
  const raw = await httpReq(baseUrl.replace(/\/+$/, '') + '/v1/models', { 'Authorization': 'Bearer ' + apiKey });
  return (JSON.parse(raw).data || []).map(m => ({
    id: m.id, name: m.id, reasoning: /^(o[1-9]|.*reason)/i.test(m.id), ctx: 128000, max: 8192,
    created: m.created ? new Date(m.created * 1000).toISOString() : ''
  })).sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}
function sortKey(id) { const v = id.match(/(\d+)[\.-](\d+)/); if (v) return parseInt(v[1]) * 100 + parseInt(v[2]); const s = id.match(/(\d+)/); return s ? parseInt(s[1]) * 100 : 0; }
function prettyName(s) {
  let m;
  if ((m = s.match(/^claude-(\w+)-(\d+)-(\d)(?:-(\d{8}))?$/))) return `Claude ${cap(m[1])} ${m[2]}.${m[3]}${m[4] ? ` (${m[4]})` : ''}`;
  if ((m = s.match(/^claude-(\d+)-(\d+)-(\w+)(?:-(\d{8}))?$/))) return `Claude ${m[1]}.${m[2]} ${cap(m[3])}${m[4] ? ` (${m[4]})` : ''}`;
  if ((m = s.match(/^claude-(\w+)-(\d+)-(\d{8})$/))) return `Claude ${cap(m[1])} ${m[2]} (${m[3]})`;
  return s.replace(/^claude-/, 'Claude ').replace(/-/g, ' ');
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/* ═══════ API 路由 ═══════ */

async function api(req, res) {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  if (u.pathname === '/api/config' && req.method === 'GET') {
    try { J(res, { ok: true, config: JSON.parse(fs.readFileSync(CONFIG, 'utf-8')), path: CONFIG }); }
    catch (e) { J(res, { ok: false, error: e.message }, 500); } return;
  }
  if (u.pathname === '/api/config' && req.method === 'POST') {
    try { fs.writeFileSync(CONFIG, JSON.stringify(JSON.parse(await readBody(req)), null, 2) + '\n'); J(res, { ok: true }); }
    catch (e) { J(res, { ok: false, error: e.message }, 500); } return;
  }
  if (u.pathname === '/api/fetch-models' && req.method === 'POST') {
    try {
      const { baseUrl, apiKey, apiType } = JSON.parse(await readBody(req));
      const models = apiType === 'anthropic-messages' ? await fetchAnthropic(baseUrl, apiKey) : await fetchOpenAI(baseUrl, apiKey);
      J(res, { ok: true, models });
    } catch (e) { J(res, { ok: false, error: e.message }, 500); } return;
  }

  // 会话列表
  if (u.pathname === '/api/sessions' && req.method === 'GET') {
    try {
      const d = JSON.parse(fs.readFileSync(SESSIONS, 'utf-8'));
      const list = Object.entries(d).map(([k, v]) => ({
        key: k,
        model: v.model ? `${v.modelProvider || '?'}/${v.model}` : null,
        fallback: v.fallbackNoticeReason || null,
        channel: k.includes('feishu') ? 'feishu' : k.includes('main:main') ? 'webchat' : k.includes('cron') ? 'cron' : 'other'
      }));
      J(res, { ok: true, sessions: list });
    } catch (e) { J(res, { ok: false, error: e.message }, 500); } return;
  }

  // 清除所有会话的模型锁定
  if (u.pathname === '/api/sessions/reset' && req.method === 'POST') {
    try {
      const d = JSON.parse(fs.readFileSync(SESSIONS, 'utf-8'));
      let count = 0;
      for (const [, v] of Object.entries(d)) {
        let touched = false;
        for (const f of ['modelProvider', 'model', 'fallbackNoticeSelectedModel', 'fallbackNoticeActiveModel', 'fallbackNoticeReason']) {
          if (f in v) { delete v[f]; touched = true; }
        }
        if (touched) count++;
      }
      fs.writeFileSync(SESSIONS, JSON.stringify(d));
      J(res, { ok: true, cleared: count });
    } catch (e) { J(res, { ok: false, error: e.message }, 500); } return;
  }

  // 执行 CLI 命令
  if (u.pathname === '/api/run' && req.method === 'POST') {
    try {
      const { cmd } = JSON.parse(await readBody(req));
      if (!cmd || !cmd.startsWith('openclaw ')) throw new Error('只允许 openclaw 命令');
      const output = execSync(cmd, { timeout: 30000, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
      J(res, { ok: true, output });
    } catch (e) { J(res, { ok: false, error: e.stderr || e.stdout || e.message }, 500); } return;
  }

  // 日志
  if (u.pathname === '/api/logs' && req.method === 'GET') {
    const n = parseInt(u.searchParams.get('n') || '30');
    const type = u.searchParams.get('type') || 'all';
    J(res, { ok: true, log: type !== 'error' ? tail(LOG, n) : '', errLog: type !== 'normal' ? tail(ERR_LOG, n) : '' });
    return;
  }

  // 运行状态摘要
  if (u.pathname === '/api/status' && req.method === 'GET') {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf-8'));
      const primary = cfg.agents?.defaults?.model?.primary || '未设置';
      const providers = Object.keys(cfg.models?.providers || {});
      const models = providers.flatMap(p => (cfg.models.providers[p].models || []).map(m => `${p}/${m.id}`));
      const lastLog = tail(LOG, 3);
      const lastErr = tail(ERR_LOG, 3);
      J(res, { ok: true, primary, providers, models, lastLog, lastErr });
    } catch (e) { J(res, { ok: false, error: e.message }, 500); } return;
  }

  J(res, { error: 'not found' }, 404);
}

/* ═══════ HTML ═══════ */

const HTML = /*html*/`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenClaw 控制台</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Sans+SC:wght@300;400;500;700&display=swap');
:root{--bg:#f5f3ef;--sf:#fff;--sf2:#f0ede8;--bd:#d8d4cc;--bdf:#b0a998;--tx:#1a1816;--tx2:#5c5650;--tx3:#8a847c;--ac:#d35400;--acl:#fef0e6;--ach:#b84800;--dg:#c0392b;--dgb:#fdf2f0;--ok:#1a8a5c;--okb:#eef8f3;--bl:#2563eb;--blb:#eff4ff;--mono:'IBM Plex Mono',monospace;--sans:'Noto Sans SC',system-ui,sans-serif;--r:10px;--sh:0 1px 3px rgba(0,0,0,.06);--shl:0 4px 12px rgba(0,0,0,.08)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--sans);background:var(--bg);color:var(--tx);min-height:100vh;line-height:1.6}
.hd{padding:12px 32px;background:var(--sf);border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;box-shadow:var(--sh);position:sticky;top:0;z-index:50}
.hd h1{font-family:var(--mono);font-size:15px;font-weight:600}.hd h1 span{color:var(--tx3);font-weight:400}
.hr{display:flex;gap:8px;align-items:center}

/* ═══ 标签导航 ═══ */
.tabs{display:flex;gap:0;background:var(--sf);border-bottom:1px solid var(--bd);padding:0 32px;position:sticky;top:48px;z-index:40}
.tab{font-family:var(--mono);font-size:12px;font-weight:500;padding:10px 20px;cursor:pointer;color:var(--tx3);border-bottom:2px solid transparent;transition:all .15s}
.tab:hover{color:var(--tx)}.tab.active{color:var(--ac);border-bottom-color:var(--ac);font-weight:600}

.page{display:none;max-width:1320px;margin:0 auto;padding:24px 32px}
.page.active{display:block}

/* ═══ 通用 ═══ */
.cd{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:16px 18px;box-shadow:var(--sh);margin-bottom:16px}
.ct-t{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:var(--tx3);margin-bottom:10px;display:flex;align-items:center;gap:8px}
.ct-t .sub{font-weight:400;text-transform:none;letter-spacing:0}
.fr{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}.fr:last-child{margin-bottom:0}.fu{grid-column:1/-1}
.fd{display:flex;flex-direction:column;gap:4px}.fl{font-size:11px;font-weight:500;color:var(--tx2)}
input,select{font-family:var(--mono);font-size:12px;color:var(--tx);background:var(--sf2);border:1px solid var(--bd);border-radius:6px;padding:8px 10px;outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:var(--ac);box-shadow:0 0 0 2px var(--acl)}input::placeholder{color:var(--tx3)}select{cursor:pointer}
.bt{font-family:var(--mono);font-size:12px;font-weight:600;border:none;border-radius:6px;padding:9px 18px;cursor:pointer;transition:all .12s}
.bp{background:var(--ac);color:#fff}.bp:hover{background:var(--ach)}.bp:disabled{opacity:.35;cursor:not-allowed}
.bo{background:var(--sf);color:var(--tx2);border:1px solid var(--bd)}.bo:hover{border-color:var(--bdf);color:var(--tx)}
.bf{background:var(--ok);color:#fff}.bf:hover{background:#158050}.bf:disabled{opacity:.4;cursor:not-allowed}
.bb{background:var(--bl);color:#fff}.bb:hover{background:#1d4ed8}
.bs{font-size:11px;padding:6px 14px}
.ck{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--tx2);cursor:pointer}.ck input{width:15px;height:15px;accent-color:var(--ac);cursor:pointer}

/* ═══ 模型管理布局 ═══ */
.model-layout{display:grid;grid-template-columns:280px 1fr;gap:20px}
.sidebar{display:flex;flex-direction:column;gap:8px}
.sl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:var(--tx3);margin-bottom:4px}

/* Provider 卡片 */
.pc{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:10px 12px;box-shadow:var(--sh);transition:border-color .15s}
.pc:hover{border-color:var(--bdf)}.pc.ed{border-color:var(--ac);box-shadow:0 0 0 2px var(--acl)}
.ph{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.pn{font-family:var(--mono);font-size:12px;font-weight:600}
.pa{font-family:var(--mono);font-size:9px;color:var(--ac);background:var(--acl);padding:2px 6px;border-radius:4px}
.pu{font-family:var(--mono);font-size:9px;color:var(--tx3);word-break:break-all;margin-bottom:4px}
.pmr{display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:10px;padding:3px 6px;background:var(--sf2);border-radius:4px;color:var(--tx2);margin-bottom:2px}
.mc{font-size:9px;color:var(--tx3)}.mp{font-size:8px;color:var(--ok);background:var(--okb);padding:1px 4px;border-radius:3px;margin-left:3px}
.pb{display:flex;gap:4px;margin-top:6px}
.pb button{font-family:var(--mono);font-size:9px;font-weight:500;border:1px solid var(--bd);border-radius:4px;padding:2px 7px;cursor:pointer;background:var(--sf);color:var(--tx2);transition:all .12s}
.pb button:hover{border-color:var(--bdf);color:var(--tx)}
.pb .d{color:var(--dg);border-color:#e8c4bf}.pb .d:hover{background:var(--dgb)}

/* 模型选择器 */
.fb{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.sb2{position:relative;margin-bottom:6px}.sb2 input{width:100%;padding-left:26px}
.sb2::before{content:'\\2315';position:absolute;left:9px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--tx3);pointer-events:none}
.mg{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:5px;max-height:280px;overflow-y:auto;padding:2px}
.me{text-align:center;padding:28px;font-size:11px;color:var(--tx3);grid-column:1/-1}
.mo{font-family:var(--mono);padding:8px 10px;border:1px solid var(--bd);border-radius:6px;cursor:pointer;transition:all .12s;background:var(--sf);display:flex;flex-direction:column;gap:1px}
.mo:hover{border-color:var(--bdf);background:var(--sf2)}.mo.se{border-color:var(--ac);background:var(--acl)}
.mo .n{font-size:11px;font-weight:600}.mo .i{font-size:9px;color:var(--tx3)}
.mo .m{display:flex;gap:5px;margin-top:1px;flex-wrap:wrap}.mo .m span{font-size:8px;color:var(--tx3);background:var(--sf2);padding:1px 4px;border-radius:3px}
.mo.se .m span{background:#fde0cc}

/* ═══ 会话 & 操作 ═══ */
.sess-card{font-family:var(--mono);padding:10px 14px;border:1px solid var(--bd);border-radius:8px;background:var(--sf);margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;font-size:11px}
.sess-card .ch{font-weight:600;font-size:12px}.sess-card .mdl{color:var(--tx3);font-size:10px}
.sess-card .fb-reason{color:var(--dg);font-size:9px}
.sess-card .no-lock{color:var(--ok);font-size:10px}
.cmd-card{background:var(--sf);border:1px solid var(--bd);border-radius:8px;padding:14px 16px;margin-bottom:8px;cursor:pointer;transition:border-color .15s}
.cmd-card:hover{border-color:var(--bdf)}
.cmd-card .cmd-title{font-size:12px;font-weight:600;margin-bottom:2px}
.cmd-card .cmd-desc{font-size:11px;color:var(--tx3);margin-bottom:6px}
.cmd-card .cmd-code{font-family:var(--mono);font-size:11px;background:var(--sf2);padding:6px 10px;border-radius:5px;color:var(--tx2);display:flex;justify-content:space-between;align-items:center}
.cmd-card .cmd-code .copy-hint{font-size:9px;color:var(--tx3)}

/* ═══ 日志 ═══ */
.log-box{font-family:var(--mono);font-size:10px;background:var(--sf2);border:1px solid var(--bd);border-radius:6px;padding:10px;max-height:300px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;line-height:1.5;color:var(--tx2)}
.log-box .err{color:var(--dg)}.log-box .ok{color:var(--ok)}

/* ═══ Status bar ═══ */
.status-bar{font-family:var(--mono);font-size:10px;color:var(--ok);background:var(--okb);padding:4px 10px;border-radius:5px;border:1px solid #b8dfcc}
.status-bar.warn{color:var(--dg);background:var(--dgb);border-color:#e8c4bf}

.jp{background:var(--sf2);border:1px solid var(--bd);border-radius:6px;padding:10px;font-family:var(--mono);font-size:10px;color:var(--tx2);max-height:200px;overflow-y:auto;white-space:pre;line-height:1.5;display:none}.jp.v{display:block}
.to{position:fixed;bottom:20px;right:20px;font-family:var(--mono);font-size:12px;padding:10px 18px;border-radius:7px;transform:translateY(80px);opacity:0;transition:all .25s;z-index:200;box-shadow:var(--shl)}
.to.sh{transform:translateY(0);opacity:1}.to.ok{background:var(--okb);color:var(--ok);border:1px solid #b8dfcc}.to.er{background:var(--dgb);color:var(--dg);border:1px solid #e8c4bf}
.ld{display:flex;align-items:center;justify-content:center;min-height:60vh;font-family:var(--mono);font-size:13px;color:var(--tx3)}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--bd);border-radius:3px}
</style>
</head>
<body>

<div class="hd">
  <h1>openclaw <span>/ 控制台</span></h1>
  <div class="hr">
    <span class="status-bar" id="stBar">加载中...</span>
    <button class="bt bs bp" id="svB">保存配置</button>
  </div>
</div>

<div class="tabs">
  <div class="tab active" data-p="models">模型管理</div>
  <div class="tab" data-p="sessions">会话 & 切换</div>
  <div class="tab" data-p="ops">常用操作</div>
  <div class="tab" data-p="logs">日志</div>
</div>

<!-- ═══════════════ 模型管理 ═══════════════ -->
<div class="page active" id="pg-models">
  <div class="ld" id="ld">正在读取配置...</div>
  <div class="model-layout" id="ml" style="display:none">
    <div class="sidebar">
      <div class="sl">已注册 Providers</div>
      <div id="pL"></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="cd"><div class="ct-t">渠道信息</div>
        <div class="fr"><div class="fd"><span class="fl">Provider ID</span><input id="pId" placeholder="如 claude-aws"></div><div class="fd"><span class="fl">API 协议</span><select id="aT"><option value="anthropic-messages">anthropic-messages</option><option value="openai-completions">openai-completions</option></select></div></div>
        <div class="fr"><div class="fd fu"><span class="fl">Base URL</span><input id="bU" placeholder="https://..."></div></div>
        <div class="fr"><div class="fd fu"><span class="fl">API Key</span><input id="aK" placeholder="sk-..."></div></div>
      </div>
      <div class="cd"><div class="ct-t">选择模型 <span class="sub">— 从渠道 API 实时拉取</span></div>
        <div class="fb"><button class="bt bs bf" id="fB">拉取模型</button><span style="font-size:10px;color:var(--tx3)" id="fS"></span></div>
        <div class="sb2"><input id="mS" placeholder="搜索模型..."></div>
        <div class="mg" id="mG"><div class="me">填写渠道信息后点击「拉取模型」</div></div>
      </div>
      <div class="cd"><div class="ct-t">模型参数</div>
        <div class="fr"><div class="fd"><span class="fl">Model ID</span><input id="mId" placeholder="选择或手填"></div><div class="fd"><span class="fl">显示名称</span><input id="mN" placeholder="显示名称"></div></div>
        <div class="fr"><div class="fd"><span class="fl">Context Window</span><input type="number" id="cW" value="200000"></div><div class="fd"><span class="fl">Max Tokens</span><input type="number" id="mT" value="8192"></div></div>
        <div class="fr"><div class="fd"><label class="ck"><input type="checkbox" id="rE"> extended thinking</label></div><div class="fd"><label class="ck"><input type="checkbox" id="sP"> 设为默认</label></div></div>
      </div>
      <div class="jp" id="pv"></div>
      <div style="display:flex;gap:8px"><button class="bt bp" id="aB">写入配置</button><button class="bt bo" id="pvB">预览 JSON</button></div>
    </div>
  </div>
</div>

<!-- ═══════════════ 会话 & 切换 ═══════════════ -->
<div class="page" id="pg-sessions">
  <div class="cd">
    <div class="ct-t">当前默认模型</div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <span style="font-family:var(--mono);font-size:14px;font-weight:600" id="curModel">—</span>
      <button class="bt bs bb" id="refreshSess">刷新</button>
    </div>
  </div>
  <div class="cd">
    <div class="ct-t">活跃会话 <span class="sub">— 每个渠道可能锁定在旧模型上</span></div>
    <div id="sessList"></div>
    <div style="margin-top:12px">
      <button class="bt bp" id="resetAllSess">一键清除所有会话的模型锁定</button>
      <span style="font-size:10px;color:var(--tx3);margin-left:8px">清除后所有渠道自动使用默认模型</span>
    </div>
  </div>
  <div class="cd">
    <div class="ct-t">快速切换默认模型</div>
    <div style="font-size:11px;color:var(--tx3);margin-bottom:8px">点击下方模型，一键切换全局默认 + 清除所有会话锁定 + 保存</div>
    <div id="quickSwitch"></div>
  </div>
</div>

<!-- ═══════════════ 常用操作 ═══════════════ -->
<div class="page" id="pg-ops">
  <div class="cd"><div class="ct-t">模型操作</div><div id="opsCmdsModel"></div></div>
  <div class="cd"><div class="ct-t">Gateway 操作</div><div id="opsCmdsGw"></div></div>
  <div class="cd"><div class="ct-t">诊断</div><div id="opsCmdsDiag"></div></div>
  <div class="cd">
    <div class="ct-t">命令输出</div>
    <div class="log-box" id="cmdOutput" style="min-height:80px">点击上方命令卡片执行，输出显示在这里</div>
  </div>
</div>

<!-- ═══════════════ 日志 ═══════════════ -->
<div class="page" id="pg-logs">
  <div style="display:flex;gap:8px;margin-bottom:12px">
    <button class="bt bs bb" id="refreshLogs">刷新日志</button>
    <button class="bt bs bo" id="toggleErr">切换: 错误日志</button>
  </div>
  <div class="cd"><div class="ct-t" id="logTitle">Gateway 日志 (最近 40 行)</div><div class="log-box" id="logBox" style="max-height:500px">加载中...</div></div>
</div>

<div class="to" id="to"></div>

<script>
let C=null,FM=[],SM=null,EP=null;
const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);

/* ═══ Tab 切换 ═══ */
$$('.tab').forEach(t=>t.onclick=()=>{$$('.tab').forEach(x=>x.classList.remove('active'));t.classList.add('active');$$('.page').forEach(p=>p.classList.remove('active'));$('#pg-'+t.dataset.p).classList.add('active');
if(t.dataset.p==='sessions')loadSessions();if(t.dataset.p==='logs')loadLogs();if(t.dataset.p==='ops')initOps()});

/* ═══ Init ═══ */
async function init(){
try{const r=await(await fetch('/api/config')).json();if(!r.ok)throw new Error(r.error);C=r.config;
$('#ld').style.display='none';$('#ml').style.display='grid';
const pr=C.agents?.defaults?.model?.primary||'未设置';$('#stBar').textContent='默认: '+pr;
if(pr.includes('billing')||pr==='未设置')$('#stBar').classList.add('warn');
rP()}catch(e){$('#ld').textContent='加载失败: '+e.message}}
init();

/* ═══ 保存 ═══ */
$('#svB').onclick=async()=>{if(!C)return;try{const r=await(await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(C)})).json();r.ok?T('已保存到 openclaw.json'):T('失败: '+r.error,'er')}catch(e){T('保存失败','er')}};

/* ═══ Provider 列表 ═══ */
function rP(){const l=$('#pL');l.innerHTML='';const pr=C.agents?.defaults?.model?.primary||'';
Object.entries(C.models.providers).forEach(([id,p])=>{const c=document.createElement('div');c.className='pc'+(EP===id?' ed':'');
const rs=(p.models||[]).map(m=>{const ip=id+'/'+m.id===pr;return '<div class="pmr"><span>'+m.id+'</span><span><span class="mc">'+(m.contextWindow/1000|0)+'k</span>'+(ip?'<span class="mp">默认</span>':'')+'</span></div>'}).join('');
c.innerHTML='<div class="ph"><span class="pn">'+id+'</span><span class="pa">'+(p.api||'-')+'</span></div><div class="pu">'+(p.baseUrl||'-')+'</div>'+rs+'<div class="pb"><button class="e" data-i="'+id+'">编辑</button><button class="d" data-i="'+id+'">删除</button></div>';
l.appendChild(c)});
l.querySelectorAll('.d').forEach(b=>b.onclick=e=>{e.stopPropagation();dP(b.dataset.i)});
l.querySelectorAll('.e').forEach(b=>b.onclick=e=>{e.stopPropagation();eP(b.dataset.i)});
$('#stBar').textContent='默认: '+pr;$('#stBar').className='status-bar'+(pr==='未设置'?' warn':'')}

function dP(id){if(!confirm('删除 "'+id+'"？'))return;delete C.models.providers[id];const m=C.agents?.defaults?.models;if(m)Object.keys(m).forEach(k=>{if(k.startsWith(id+'/'))delete m[k]});if(C.agents?.defaults?.model?.primary?.startsWith(id+'/'))C.agents.defaults.model.primary='';if(EP===id){EP=null;cF()}rP();T('已删除 '+id)}
function eP(id){const p=C.models.providers[id];if(!p)return;EP=id;$('#pId').value=id;$('#aT').value=p.api||'anthropic-messages';$('#bU').value=p.baseUrl||'';$('#aK').value=p.apiKey||'';
if(p.models?.length){const m=p.models[0];$('#mId').value=m.id;$('#mN').value=m.name;$('#cW').value=m.contextWindow||200000;$('#mT').value=m.maxTokens||8192;$('#rE').checked=!!m.reasoning;$('#sP').checked=(C.agents?.defaults?.model?.primary||'')===id+'/'+m.id;SM=m.id;rMG()}rP()}

/* ═══ 模型拉取 ═══ */
$('#fB').onclick=async()=>{const bU=$('#bU').value.trim(),aK=$('#aK').value.trim(),aT=$('#aT').value;
if(!bU){T('请先填 Base URL','er');return}if(!aK){T('请先填 API Key','er');return}
$('#fB').disabled=true;$('#fS').textContent='请求中...';$('#mG').innerHTML='<div class="me" style="color:var(--ac)">正在拉取...</div>';
try{const r=await(await fetch('/api/fetch-models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseUrl:bU,apiKey:aK,apiType:aT})})).json();
if(!r.ok)throw new Error(r.error);FM=r.models;$('#fS').textContent=r.models.length+' 个模型';rMG()}
catch(e){$('#fS').textContent='失败';$('#mG').innerHTML='<div class="me" style="color:var(--dg)">拉取失败: '+e.message+'</div>';FM=[]}
finally{$('#fB').disabled=false}};
$('#mS').oninput=rMG;
function rMG(){const g=$('#mG'),q=($('#mS').value||'').toLowerCase();
const ls=FM.filter(m=>!q||m.name.toLowerCase().includes(q)||m.id.toLowerCase().includes(q));
if(!ls.length){g.innerHTML='<div class="me">'+(FM.length?'无匹配':'填写渠道信息后点击「拉取模型」')+'</div>';return}
g.innerHTML=ls.map(m=>'<div class="mo'+(SM===m.id?' se':'')+'" data-i="'+m.id+'"><span class="n">'+m.name+'</span><span class="i">'+m.id+'</span><div class="m"><span>'+(m.ctx/1000|0)+'k ctx</span><span>'+(m.max/1000|0)+'k out</span>'+(m.reasoning?'<span>thinking</span>':'')+'</div></div>').join('');
g.querySelectorAll('.mo').forEach(el=>el.onclick=()=>{const m=FM.find(x=>x.id===el.dataset.i);if(!m)return;SM=m.id;$('#mId').value=m.id;$('#mN').value=m.name;$('#cW').value=m.ctx;$('#mT').value=m.max;$('#rE').checked=m.reasoning;rMG()})}

/* ═══ 写入配置 ═══ */
$('#aB').onclick=()=>{const pId=$('#pId').value.trim(),aT=$('#aT').value,bU=$('#bU').value.trim(),aK=$('#aK').value.trim(),mId=$('#mId').value.trim(),mN=$('#mN').value.trim(),cW=parseInt($('#cW').value)||200000,mT=parseInt($('#mT').value)||8192,rE=$('#rE').checked,sP=$('#sP').checked;
if(!pId||!bU||!mId||!mN){T('必填项不能为空','er');return}
const ent={id:mId,name:mN,reasoning:rE,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:cW,maxTokens:mT};
const ps=C.models.providers;
if(EP&&ps[EP]){if(EP!==pId){ps[pId]=ps[EP];delete ps[EP];const am=C.agents?.defaults?.models;if(am)Object.keys(am).forEach(k=>{if(k.startsWith(EP+'/')){am[k.replace(EP,pId)]=am[k];delete am[k]}})}
const p=ps[pId];p.baseUrl=bU;p.api=aT;if(aK)p.apiKey=aK;const i=p.models.findIndex(x=>x.id===mId);if(i>=0)p.models[i]=ent;else p.models=[ent]}
else if(ps[pId]){const i=ps[pId].models.findIndex(x=>x.id===mId);if(i>=0)ps[pId].models[i]=ent;else ps[pId].models.push(ent);if(aK)ps[pId].apiKey=aK}
else{const pv={baseUrl:bU,api:aT,models:[ent]};if(aK)pv.apiKey=aK;ps[pId]=pv}
if(!C.agents)C.agents={defaults:{models:{}}};if(!C.agents.defaults)C.agents.defaults={models:{}};if(!C.agents.defaults.models)C.agents.defaults.models={};
const k=pId+'/'+mId;C.agents.defaults.models[k]={alias:mN};
if(sP){if(!C.agents.defaults.model)C.agents.defaults.model={};C.agents.defaults.model.primary=k}
EP=null;rP();T(k+' 已写入，点保存');cF()};

function cF(){EP=null;SM=null;['#pId','#bU','#aK','#mId','#mN'].forEach(s=>$(s).value='');$('#cW').value='200000';$('#mT').value='8192';$('#rE').checked=false;$('#sP').checked=false;$('#pv').classList.remove('v');rMG();rP()}
$('#pvB').onclick=()=>{const e=$('#pv');if(e.classList.contains('v')){e.classList.remove('v');return}e.textContent=JSON.stringify(C,null,2);e.classList.add('v')};

/* ═══════════ 会话 & 切换 ═══════════ */
async function loadSessions(){
const pr=C?.agents?.defaults?.model?.primary||'未设置';$('#curModel').textContent=pr;
try{const r=await(await fetch('/api/sessions')).json();if(!r.ok)throw new Error(r.error);
const el=$('#sessList');el.innerHTML='';
const chName={feishu:'飞书',webchat:'本地对话',cron:'定时任务',other:'其他'};
r.sessions.forEach(s=>{const d=document.createElement('div');d.className='sess-card';
d.innerHTML='<div><span class="ch">'+chName[s.channel]+'</span><br><span style="font-size:9px;color:var(--tx3)">'+s.key+'</span></div>'
+(s.model?'<div style="text-align:right"><span class="mdl">锁定: '+s.model+'</span>'+(s.fallback?'<br><span class="fb-reason">'+s.fallback+'</span>':'')+'</div>':'<span class="no-lock">跟随默认</span>');
el.appendChild(d)});

// 快速切换
const qs=$('#quickSwitch');qs.innerHTML='';
const allModels=[];Object.entries(C.models.providers).forEach(([pid,pv])=>(pv.models||[]).forEach(m=>allModels.push({key:pid+'/'+m.id,name:m.name||m.id})));
allModels.forEach(m=>{const b=document.createElement('button');b.className='bt bs '+(m.key===pr?'bp':'bo');b.textContent=m.name;b.style.margin='3px';
b.onclick=async()=>{C.agents.defaults.model.primary=m.key;
await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(C)});
await fetch('/api/sessions/reset',{method:'POST'});
T(m.key+' 已设为默认，所有会话已重置');loadSessions();rP()};qs.appendChild(b)})}catch(e){$('#sessList').innerHTML='<div style="color:var(--dg)">'+e.message+'</div>'}}
$('#refreshSess').onclick=loadSessions;
$('#resetAllSess').onclick=async()=>{try{const r=await(await fetch('/api/sessions/reset',{method:'POST'})).json();T('已清除 '+r.cleared+' 个会话的模型锁定');loadSessions()}catch(e){T('失败: '+e.message,'er')}};

/* ═══════════ 常用操作 ═══════════ */
function initOps(){
const cmds={model:[
{t:'查看已配置模型',d:'列出所有可用模型及状态',c:'openclaw models list'},
{t:'查看当前默认',d:'显示当前使用的模型',c:'openclaw models status'},
{t:'设为默认: Claude Sonnet 4.6',d:'切换默认模型',c:'openclaw models set claude-aws/claude-sonnet-4-6'},
],gw:[
{t:'启动 Gateway',d:'启动本地 Gateway 服务',c:'openclaw gateway'},
{t:'强制重启 Gateway',d:'杀掉占用端口的进程后启动',c:'openclaw gateway --force'},
{t:'查看 Gateway 状态',d:'检查当前运行状态',c:'openclaw status'},
],diag:[
{t:'查看通道健康状况',d:'检查飞书等渠道连接',c:'openclaw channels status'},
{t:'查看版本',d:'当前 OpenClaw 版本',c:'openclaw --version'},
{t:'检查更新',d:'查看是否有新版本',c:'openclaw update status'},
]};
const render=(arr,el)=>{el.innerHTML='';arr.forEach(c=>{const d=document.createElement('div');d.className='cmd-card';
d.innerHTML='<div class="cmd-title">'+c.t+'</div><div class="cmd-desc">'+c.d+'</div><div class="cmd-code"><span>'+c.c+'</span><span class="copy-hint">点击执行</span></div>';
d.onclick=()=>runCmd(c.c);el.appendChild(d)})};
render(cmds.model,$('#opsCmdsModel'));render(cmds.gw,$('#opsCmdsGw'));render(cmds.diag,$('#opsCmdsDiag'))}

async function runCmd(cmd){$('#cmdOutput').textContent='执行中: '+cmd+'\\n';
try{const r=await(await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd})})).json();
$('#cmdOutput').textContent=r.ok?r.output:'错误: '+r.error}catch(e){$('#cmdOutput').textContent='请求失败: '+e.message}}

/* ═══════════ 日志 ═══════════ */
let logType='all';
async function loadLogs(){try{const r=await(await fetch('/api/logs?n=40&type='+logType)).json();
const box=$('#logBox');box.innerHTML='';
if(r.log){const s=document.createElement('span');s.textContent=r.log;box.appendChild(s)}
if(r.errLog){const s=document.createElement('span');s.className='err';s.textContent='\\n--- ERROR LOG ---\\n'+r.errLog;box.appendChild(s)}
box.scrollTop=box.scrollHeight}catch(e){$('#logBox').textContent='加载失败: '+e.message}}
$('#refreshLogs').onclick=loadLogs;
$('#toggleErr').onclick=()=>{logType=logType==='all'?'error':logType==='error'?'normal':'all';$('#logTitle').textContent={all:'全部日志',error:'错误日志',normal:'普通日志'}[logType]+' (最近 40 行)';loadLogs()};

/* ═══ Toast ═══ */
function T(m,t='ok'){const e=$('#to');e.textContent=m;e.className='to '+t+' sh';clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('sh'),3000)}
</script>
</body>
</html>`;

/* ═══════ 服务器 ═══════ */

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

function start() {
  server.listen(PORT, () => {
    console.log(`\n  OpenClaw 控制台`);
    console.log(`  http://localhost:${PORT}\n`);
    exec(`open http://localhost:${PORT}`);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`  端口 ${PORT} 被占用，正在释放...`);
      exec(`lsof -ti :${PORT} | xargs kill -9`, () => setTimeout(start, 500));
    }
  });
}
start();
