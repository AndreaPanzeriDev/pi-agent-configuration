import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkBundle, initialize, loadCourse, render, updateProgress, verifyMap } from './learn.mjs';

const renderer = 'pi-learn-graph-v1';
const scripts = path.dirname(fileURLToPath(import.meta.url));
const skills = path.resolve(scripts, '../..');
const runtime = path.join(scripts, 'learn.mjs');

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-learn-graph-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function plan() {
  return {
    id: 'graph-test',
    title: 'Un percorso ramificato',
    description: 'Una base comune e due approfondimenti indipendenti.',
    goal: 'Collegare i concetti attraverso i loro prerequisiti.',
    modules: [{ id: 'fondamenti', title: 'Fondamenti' }],
    nodes: [
      { id: 'base', title: 'Base', module: 'fondamenti', summary: 'Il punto di partenza.',
        objectives: ['Comprendere il concetto iniziale'], prerequisites: [], notes: [] },
      { id: 'ramo-a', title: 'Ramo A', module: 'fondamenti', summary: 'Il primo approfondimento.',
        objectives: ['Applicare il concetto nel primo contesto'], prerequisites: ['base'], notes: [] },
      { id: 'ramo-b', title: 'Ramo B', module: 'fondamenti', summary: 'Il secondo approfondimento.',
        objectives: ['Applicare il concetto nel secondo contesto'], prerequisites: ['base'], notes: [] }
    ]
  };
}

function course(t) {
  const dir = temporaryDirectory(t);
  initialize(dir, plan());
  return dir;
}

function cli(script, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

function copySkills(t) {
  const destination = temporaryDirectory(t);
  for (const name of ['learn-plan', 'learn-study', 'learn-quiz']) {
    fs.cpSync(path.join(skills, name), path.join(destination, name), { recursive: true });
  }
  return {
    destination,
    script: path.join(destination, 'learn-plan/scripts/learn.mjs'),
    template: path.join(destination, 'learn-plan/assets/map.html')
  };
}

test('the skill bundle identifies its renderer and required resources', () => {
  const bundle = checkBundle();
  assert.equal(bundle.renderer, renderer);
  assert.ok(Array.isArray(bundle.files));
  assert.ok(bundle.files.length > 0);
});

test('initialization generates the canonical graph with the branching plan', t => {
  const dir = course(t);
  const html = fs.readFileSync(path.join(dir, 'mappa.html'), 'utf8');
  assert.ok(html.includes(renderer), 'The generated HTML must identify the graph renderer');
  assert.deepEqual(verifyMap(dir), { renderer, nodes: 3, edges: 2, revision: 0 });
  const result = cli(runtime, 'validate', dir);
  assert.equal(result.status, 0, result.stderr);
});

test('validation rejects a different HTML even when course data remains valid', t => {
  const dir = course(t);
  fs.writeFileSync(path.join(dir, 'mappa.html'), '<!doctype html><title>Lista</title><ul><li>Base</li></ul>');
  assert.equal(loadCourse(dir).plan.nodes.length, 3);
  assert.throws(() => verifyMap(dir));
  const result = cli(runtime, 'validate', dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mappa|graph|renderer|render|HTML/i);
});

test('keeping the renderer marker does not make substituted HTML canonical', t => {
  const dir = course(t);
  fs.writeFileSync(path.join(dir, 'mappa.html'), `<!doctype html><!-- ${renderer} --><title>Altra vista</title>`);
  assert.throws(() => verifyMap(dir));
});

test('render repairs the map while preserving saved progress and personal notes', t => {
  const dir = course(t);
  updateProgress(dir, 'base', { state: 'completed' }, 0);
  updateProgress(dir, 'ramo-a', { state: 'in_progress' }, 1);
  const noteFile = path.join(dir, 'lezioni/base.md');
  const note = '# Appunti personali\n\nQuesta spiegazione deve essere conservata.\n';
  fs.writeFileSync(noteFile, note);
  const indexFile = path.join(dir, 'indice.md');
  const personalIndex = '\n## La mia osservazione\n\nRiprendere il secondo ramo la prossima volta.\n';
  fs.appendFileSync(indexFile, personalIndex);
  const savedData = fs.readFileSync(path.join(dir, 'percorso.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'mappa.html'), '<!doctype html><title>Mappa sostituita</title>');

  render(dir);

  assert.equal(fs.readFileSync(path.join(dir, 'percorso.json'), 'utf8'), savedData);
  assert.equal(fs.readFileSync(noteFile, 'utf8'), note);
  assert.ok(fs.readFileSync(indexFile, 'utf8').endsWith(personalIndex));
  assert.equal(loadCourse(dir).progress.base.state, 'completed');
  assert.equal(loadCourse(dir).progress['ramo-a'].state, 'in_progress');
  assert.deepEqual(verifyMap(dir), { renderer, nodes: 3, edges: 2, revision: 2 });
});

test('a copy containing only the three skills can run doctor without a course directory', t => {
  const { script, destination } = copySkills(t);
  assert.deepEqual(fs.readdirSync(destination).sort(), ['learn-plan', 'learn-quiz', 'learn-study']);
  const result = cli(script, 'doctor');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).renderer, renderer);
});

test('doctor explains a missing graph template in a copied skill bundle', t => {
  const { script, template } = copySkills(t);
  fs.unlinkSync(template);
  const result = cli(script, 'doctor');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /map\.html/);
  assert.match(result.stderr, /mancant|manca|missing|non trovato|non trovat|incomplet|ripristin|reinstall|copi/i);
});
