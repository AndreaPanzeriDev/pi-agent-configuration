#!/usr/bin/env node
// Shared, dependency-free runtime for learn-plan, learn-study and learn-quiz.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.resolve(HERE, '../assets/map.html');
const DATA = 'percorso.json';
const STATES = ['not_started', 'in_progress', 'completed', 'review'];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NOTE = /^(lezioni|esercizi|quiz|diario)\/.+\.md$/;
const now = () => new Date().toISOString();

function check(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
function string(value, label) {
  check(typeof value === 'string' && value.trim().length > 0, `${label}: testo obbligatorio`);
}
function unique(values, label) {
  check(new Set(values).size === values.length, `${label}: valori duplicati`);
}
function notePath(value) {
  check(typeof value === 'string' && NOTE.test(value) && !value.includes('\\') &&
    !value.split('/').some(p => p === '..' || p === '.' || p === ''), 'Percorso nota non valido');
}
function date(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  'Data di ripasso non valida: usare YYYY-MM-DD');
}

export function validatePlan(plan) {
  check(plan && typeof plan === 'object', 'Piano mancante');
  for (const key of ['id', 'title', 'description', 'goal']) string(plan[key], key);
  check(ID.test(plan.id), 'ID percorso non valido');
  if (plan.weekly_hours !== undefined) check(Number.isFinite(plan.weekly_hours) && plan.weekly_hours > 0, 'weekly_hours non valido');
  check(Array.isArray(plan.modules) && plan.modules.length > 0, 'Servono uno o più moduli');
  check(Array.isArray(plan.nodes) && plan.nodes.length > 0, 'Servono uno o più nodi');
  for (const module of plan.modules) {
    check(ID.test(module.id), 'ID modulo non valido');
    string(module.title, 'Titolo modulo');
  }
  unique(plan.modules.map(m => m.id), 'Moduli');
  const modules = new Set(plan.modules.map(m => m.id));
  const ids = new Set(plan.nodes.map(n => n.id));
  unique(plan.nodes.map(n => n.id), 'Nodi');
  for (const node of plan.nodes) {
    check(ID.test(node.id), 'ID nodo non valido');
    check(modules.has(node.module), `Modulo sconosciuto per ${node.id}`);
    string(node.title, 'Titolo nodo');
    string(node.summary, 'Introduzione nodo');
    for (const key of ['objectives', 'prerequisites', 'notes']) {
      check(Array.isArray(node[key]), `${node.id}.${key}: serve una lista`);
      unique(node[key], `${node.id}.${key}`);
    }
    check(node.objectives.length > 0, `${node.id}: servono obiettivi`);
    node.objectives.forEach(x => string(x, 'Obiettivo'));
    node.notes.forEach(notePath);
    check(node.declared_known === undefined || typeof node.declared_known === 'boolean', 'declared_known deve essere booleano');
    for (const id of node.prerequisites) check(ids.has(id) && id !== node.id, `Prerequisito non valido: ${id}`);
  }
  const byId = new Map(plan.nodes.map(n => [n.id, n]));
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    check(!visiting.has(id), 'Il grafo dei prerequisiti contiene un ciclo');
    if (visited.has(id)) return;
    visiting.add(id);
    byId.get(id).prerequisites.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  plan.nodes.forEach(n => visit(n.id));
  return plan;
}

export function validateCourse(course) {
  check(course?.schema_version === 1, 'Versione dati non supportata');
  check(Number.isInteger(course.revision) && course.revision >= 0, 'Revisione non valida');
  validatePlan(course.plan);
  check(course.progress && Array.isArray(course.events), 'Progressi o cronologia mancanti');
  unique(course.events.map(e => e.id), 'Eventi');
  const ids = course.plan.nodes.map(n => n.id);
  check(Object.keys(course.progress).length === ids.length, 'Progressi e nodi non corrispondono');
  for (const id of ids) {
    const p = course.progress[id];
    check(p && STATES.includes(p.state), `Stato non valido: ${id}`);
    check(typeof p.declared === 'boolean', `Conoscenza dichiarata non valida: ${id}`);
    check(['unverified', 'passed', 'needs_work'].includes(p.verification), `Verifica non valida: ${id}`);
    if (p.review_on !== null) date(p.review_on);
  }
  return course;
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
export function loadCourse(dir) {
  return validateCourse(readJson(path.join(dir, DATA)));
}
function atomicWrite(filename, text) {
  const tmp = `${filename}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, filename);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
function saveCourse(dir, course) {
  validateCourse(course);
  atomicWrite(path.join(dir, DATA), JSON.stringify(course, null, 2) + '\n');
}
function lock(dir, fn) {
  const filename = path.join(dir, '.learn.lock');
  let acquired = false;
  try {
    try { fs.mkdirSync(filename); acquired = true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      throw Object.assign(new Error('Percorso occupato. Riprova; se un processo è terminato bruscamente, rimuovi .learn.lock solo dopo aver controllato che non sia in uso.'), { status: 409 });
    }
    fs.writeFileSync(path.join(filename, 'owner.json'), JSON.stringify({ pid: process.pid, at: now() }));
    return fn();
  } finally {
    if (acquired) fs.rmSync(filename, { recursive: true });
  }
}
function initialProgress(node) {
  return { state: node.declared_known ? 'completed' : 'not_started', declared: !!node.declared_known,
    verification: 'unverified', review_on: null, updated_at: now() };
}

export function initialize(dir, plan) {
  validatePlan(plan);
  fs.mkdirSync(dir, { recursive: true });
  return lock(dir, () => {
    check(!fs.existsSync(path.join(dir, DATA)), 'Il percorso esiste già: usa plan per rivederlo', 409);
    for (const folder of ['lezioni', 'esercizi', 'quiz', 'diario', 'allegati']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
    const course = { schema_version: 1, revision: 0, created_at: now(), updated_at: now(), plan,
      progress: Object.fromEntries(plan.nodes.map(n => [n.id, initialProgress(n)])), events: [] };
    saveCourse(dir, course);
    render(dir, course);
    return course;
  });
}

function mutate(dir, expected, fn) {
  return lock(dir, () => {
    const course = loadCourse(dir);
    if (expected !== undefined) check(course.revision === expected, 'Dati aggiornati da un’altra sessione. Ricarica e ripeti la modifica.', 409);
    fn(course);
    course.revision += 1;
    course.updated_at = now();
    saveCourse(dir, course);
    // Derived views can always be rebuilt from the committed JSON.
    try { writeView(dir, course); }
    catch (e) { console.error(`Dati salvati; eseguire render per aggiornare le viste: ${e.message}`); }
    return course;
  });
}

export function updateProgress(dir, id, patch, expected) {
  return mutate(dir, expected, course => {
    check(Object.hasOwn(course.progress, id), 'Nodo sconosciuto', 404);
    const current = course.progress[id];
    check(patch && typeof patch === 'object' && !Array.isArray(patch), 'Modifica non valida');
    check(Object.keys(patch).length > 0 && Object.keys(patch).every(k => ['state', 'declared', 'review_on'].includes(k)), 'Sono modificabili solo state, declared e review_on');
    if ('state' in patch) check(STATES.includes(patch.state), 'Stato non valido');
    if ('declared' in patch) check(typeof patch.declared === 'boolean', 'declared deve essere booleano');
    if (patch.review_on !== undefined && patch.review_on !== null) date(patch.review_on);
    course.events.push({ id: randomBytes(12).toString('hex'), type: 'manual', at: now(), node_id: id,
      before: { ...current }, patch });
    Object.assign(current, patch, { updated_at: now() });
  });
}

function existingNote(dir, relative) {
  notePath(relative);
  const root = fs.realpathSync(dir);
  const file = fs.realpathSync(path.join(root, relative));
  check(file.startsWith(root + path.sep), 'La nota esce dalla cartella del percorso');
  check(fs.statSync(file).isFile(), 'Nota non trovata');
  return file;
}

export function recordEvent(dir, event, expected) {
  return mutate(dir, expected, course => {
    check(event && ['study', 'quiz', 'assessment'].includes(event.type), 'Tipo evento non valido');
    string(event.id, 'ID evento');
    check(!course.events.some(e => e.id === event.id), 'Evento già registrato: non ripetere la registrazione', 409);
    string(event.summary, 'Riepilogo evento');
    check(Array.isArray(event.results) && event.results.length > 0, 'Servono risultati per uno o più nodi');
    unique(event.results.map(r => r.node_id), 'Risultati');
    for (const result of event.results) {
      const current = course.progress[result.node_id];
      const node = course.plan.nodes.find(n => n.id === result.node_id);
      check(current && node, 'Nodo sconosciuto');
      check(['studied', 'passed', 'needs_work', 'inconclusive'].includes(result.outcome), 'Esito non valido');
      if (event.type === 'study') check(result.outcome === 'studied', 'Una lezione non costituisce una verifica');
      else check(result.outcome !== 'studied', 'Una verifica richiede un esito');
      string(result.evidence, 'Evidenza o difficoltà osservata');
      if (result.score !== undefined) check(Number.isFinite(result.score) && result.score >= 0 && result.score <= 1, 'score deve essere tra 0 e 1');
      existingNote(dir, result.note);
      if (!node.notes.includes(result.note)) node.notes.push(result.note);
      if (result.review_on !== undefined && result.review_on !== null) date(result.review_on);
      if (result.outcome === 'passed') {
        current.verification = 'passed'; current.state = 'completed'; current.review_on = result.review_on ?? null;
      } else if (result.outcome === 'needs_work') {
        current.verification = 'needs_work'; current.state = 'review'; current.review_on = result.review_on ?? null;
      } else if (result.outcome === 'studied' && current.state === 'not_started') current.state = 'in_progress';
      if (result.review_on !== undefined) current.review_on = result.review_on;
      current.updated_at = now();
    }
    course.events.push({ ...event, at: now() });
  });
}

export function replacePlan(dir, plan, expected) {
  validatePlan(plan);
  return mutate(dir, expected, course => {
    check(plan.id === course.plan.id, 'Non cambiare l’ID del percorso');
    const ids = new Set(plan.nodes.map(n => n.id));
    check(course.plan.nodes.every(n => ids.has(n.id)), 'Mantieni gli ID dei nodi esistenti per preservare progressi e cronologia');
    for (const node of plan.nodes) {
      const old = course.plan.nodes.find(n => n.id === node.id);
      if (old) node.notes = [...new Set([...old.notes, ...node.notes])];
      else course.progress[node.id] = initialProgress(node);
    }
    course.events.push({ id: randomBytes(12).toString('hex'), type: 'plan', at: now(), previous_plan: course.plan });
    course.plan = plan;
  });
}

export function snapshot(dir, course = loadCourse(dir)) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return { ...course, course_dir: path.resolve(dir),
    serve_command: `node ${quote(fileURLToPath(import.meta.url))} serve ${quote(path.resolve(dir))}` };
}
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function writeView(dir, course) {
  const data = JSON.stringify(snapshot(dir, course)).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const html = fs.readFileSync(TEMPLATE, 'utf8').replace('<!--COURSE_DATA-->', () => data)
    .replace('<!--COURSE_TITLE-->', () => escapeHtml(course.plan.title));
  atomicWrite(path.join(dir, 'mappa.html'), html);
  const start = '<!-- learn:index:start -->', end = '<!-- learn:index:end -->';
  const indexFile = path.join(dir, 'indice.md');
  const body = [start, `# ${course.plan.title}`, '', course.plan.description, '', `Obiettivo: ${course.plan.goal}`, '',
    ...course.plan.modules.flatMap(module => [`## ${module.title}`, '', ...course.plan.nodes.filter(n => n.module === module.id).flatMap(n => [
      `- **${n.title}** — ${course.progress[n.id].state}`, ...n.notes.map(note => `  - [[${note.slice(0, -3)}]]`)
    ]), '']), end].join('\n');
  const previous = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  const a = previous.indexOf(start), b = previous.indexOf(end);
  const text = a >= 0 && b > a ? previous.slice(0, a) + body + previous.slice(b + end.length)
    : body + '\n\n' + previous;
  atomicWrite(indexFile, text);
}
export function render(dir, course) {
  // Rendering from disk always holds the same lock as mutations.
  if (course) writeView(dir, course);
  else lock(dir, () => writeView(dir, loadCourse(dir)));
}

export function createServer(dir, { port = 0 } = {}) {
  loadCourse(dir);
  const token = randomBytes(24).toString('hex');
  const server = http.createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    function send(status, value, type = 'application/json; charset=utf-8') {
      res.writeHead(status, { ...headers, 'Content-Type': type });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    }
    try {
      const address = server.address();
      const host = `127.0.0.1:${address.port}`;
      check(req.headers.host === host, 'Host non consentito', 403);
      if (req.headers.origin) check(req.headers.origin === `http://${host}`, 'Origine non consentita', 403);
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/mappa.html')) {
        const data = JSON.stringify(snapshot(dir)).replaceAll('<', '\\u003c');
        const html = fs.readFileSync(TEMPLATE, 'utf8').replace('<!--COURSE_DATA-->', () => data)
          .replace('<!--COURSE_TITLE-->', () => escapeHtml(loadCourse(dir).plan.title));
        return send(200, html, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/course') return send(200, { course: snapshot(dir), token });
      if (req.method === 'GET' && url.pathname.startsWith('/notes/')) {
        const file = existingNote(dir, decodeURIComponent(url.pathname.slice(7)));
        return send(200, fs.readFileSync(file, 'utf8'), 'text/plain; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/api/progress') {
        check(req.headers['x-learn-token'] === token, 'Token non valido: ricarica la pagina', 403);
        check(req.headers['content-type']?.split(';')[0].trim() === 'application/json', 'Serve application/json', 415);
        let raw = '';
        for await (const chunk of req) { raw += chunk; check(Buffer.byteLength(raw) <= 65536, 'Richiesta troppo grande', 413); }
        const body = JSON.parse(raw);
        check(Number.isInteger(body.revision) && body.revision >= 0, 'Revisione obbligatoria');
        const course = updateProgress(dir, body.node_id, body.patch, body.revision);
        return send(200, { course: snapshot(dir, course), token });
      }
      send(404, { error: 'Risorsa non trovata' });
    } catch (e) {
      send(e.status || (e instanceof SyntaxError ? 400 : e.code === 'ENOENT' ? 404 : 500), { error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

const HELP = `Apprendimento Pi (Node.js >= 20, nessuna dipendenza)
  init <cartella> --from <piano.json>
  list [radice]                         default: PI_LEARN_ROOT o ./apprendimento
  show <cartella>                       dati completi con revisione
  validate <cartella>
  render <cartella>                     aggiorna HTML statico e indice Markdown
  serve <cartella> [--port 0]            resta in esecuzione; Ctrl+C per chiudere
  progress <cartella> <nodo> --state <not_started|in_progress|completed|review>
           [--expected-revision N] [--review-on YYYY-MM-DD|none]
  record <cartella> --from <evento.json> [--expected-revision N]
  plan <cartella> --from <piano.json> --expected-revision N
Le mutazioni salvano percorso.json e aggiornano mappa.html e indice.md.
render rigenera le viste quando necessario; non modifica i dati del percorso.`;

async function main(args) {
  const positionals = [], flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (args[i] === '--help') { console.log(HELP); return; }
      check(['--from', '--state', '--expected-revision', '--port', '--review-on'].includes(args[i]), `Opzione sconosciuta: ${args[i]}`);
      check(args[i + 1] && !args[i + 1].startsWith('--'), `Valore mancante: ${args[i]}`);
      flags[args[i].slice(2)] = args[++i];
    } else positionals.push(args[i]);
  }
  const [command, location, nodeId] = positionals;
  if (!command || command === 'help') { console.log(HELP); return; }
  if (command === 'list') {
    const root = path.resolve(location || process.env.PI_LEARN_ROOT || 'apprendimento');
    const courses = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && fs.existsSync(path.join(root, d.name, DATA))).map(d => {
      const dir = path.join(root, d.name), c = loadCourse(dir);
      return { id: c.plan.id, title: c.plan.title, directory: dir, revision: c.revision };
    }) : [];
    console.log(JSON.stringify(courses, null, 2)); return;
  }
  check(location, 'Specificare la cartella del percorso');
  const dir = path.resolve(location);
  const expected = flags['expected-revision'] === undefined ? undefined : Number(flags['expected-revision']);
  if (expected !== undefined) check(Number.isInteger(expected) && expected >= 0, 'Revisione non valida');
  let course;
  switch (command) {
    case 'init': check(flags.from, 'Serve --from'); course = initialize(dir, readJson(flags.from)); break;
    case 'show': console.log(JSON.stringify(snapshot(dir), null, 2)); return;
    case 'validate': course = loadCourse(dir); break;
    case 'render': render(dir); course = loadCourse(dir); break;
    case 'progress': {
      check(flags.state, 'Serve --state');
      const patch = { state: flags.state };
      if (flags['review-on'] !== undefined) patch.review_on = flags['review-on'] === 'none' ? null : flags['review-on'];
      course = updateProgress(dir, nodeId, patch, expected); break;
    }
    case 'record': check(flags.from, 'Serve --from'); course = recordEvent(dir, readJson(flags.from), expected); break;
    case 'plan': check(flags.from && expected !== undefined, 'Servono --from e --expected-revision'); course = replacePlan(dir, readJson(flags.from), expected); break;
    case 'serve': {
      const port = flags.port === undefined ? 0 : Number(flags.port);
      check(Number.isInteger(port) && port >= 0 && port <= 65535, 'Porta non valida');
      const { server, url } = await createServer(dir, { port });
      console.log(`Mappa: ${url}\nPercorso: ${dir}\nSalvataggi: ${path.join(dir, DATA)}\nCtrl+C per chiudere.`);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        try { render(dir); } catch (e) { console.error(`Vista statica da rigenerare: ${e.message}`); }
        server.close(() => process.exit(0)); server.closeIdleConnections();
      });
      return;
    }
    default: throw new Error(`Comando sconosciuto: ${command}\n${HELP}`);
  }
  console.log(JSON.stringify({ ok: true, directory: dir, revision: course.revision }));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
