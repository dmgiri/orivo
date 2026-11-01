'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {indexRepository} = require('../engine/index.cjs');
const {buildProjectMap, sourceFingerprint} = require('../engine/project-map.cjs');

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orivo-project-map-'));
  t.after(async () => {assert.ok(path.basename(root).startsWith('orivo-project-map-')); await fs.rm(root, {recursive: true, force: true});});
  await fs.mkdir(path.join(root, 'frontend', 'src'), {recursive: true});
  await fs.mkdir(path.join(root, 'backend'), {recursive: true});
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({dependencies: {react: '^19.0.0', vite: '^8.0.0'}}));
  await fs.writeFile(path.join(root, 'frontend', 'src', 'PatientCard.tsx'), [
    "import React from 'react';",
    "import { loadPatients } from './api';",
    'export function PatientCard({ patient }) {',
    '  return <h2>{patient.name}</h2>;',
    '}',
    "export async function refresh() { return fetch('/api/patients'); }",
  ].join('\n'));
  await fs.writeFile(path.join(root, 'frontend', 'src', 'api.ts'), "export const loadPatients = () => fetch('/api/patients');\n");
  await fs.writeFile(path.join(root, 'backend', 'main.py'), [
    'from fastapi import APIRouter',
    'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column',
    'router = APIRouter()',
    "@router.get('/api/patients')",
    'def list_patients():',
    '    return []',
    'class Patient(Base):',
    "    __tablename__ = 'patients'",
    '    id: Mapped[int] = mapped_column(primary_key=True)',
    '    name: Mapped[str] = mapped_column()',
    "    note = \"PRIVATE-SYNTHETIC-VALUE\"",
    '    def display(self):',
    '        return self.name',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'backend', 'queries.sql'), "SELECT id, name FROM patients WHERE name = 'PRIVATE-SYNTHETIC-VALUE';\n");
  await fs.writeFile(path.join(root, 'backend', 'schema.prisma'), 'model Appointment {\n  id Int @id\n  patientId Int\n}\n');
  await fs.writeFile(path.join(root, '.env'), 'PASSWORD=PRIVATE-SYNTHETIC-VALUE\n');
  return root;
}

test('local source map normalizes React, Python, ORM, API, import and SQL findings without source payloads', async t => {
  const root = await project(t);
  const before = new Map();
  for (const directory of ['frontend/src', 'backend']) {
    for (const name of await fs.readdir(path.join(root, directory))) {
      const file = path.join(root, directory, name);
      before.set(path.relative(root, file), await fs.readFile(file));
    }
  }
  const index = await indexRepository(root), map = await buildProjectMap(index);
  const kinds = new Set(map.symbols.map(symbol => symbol.kind));
  assert.ok(kinds.has('component'));
  assert.ok(kinds.has('api-call'));
  assert.ok(kinds.has('route'));
  assert.ok(kinds.has('orm-model'));
  assert.ok(map.symbols.some(symbol => symbol.kind === 'orm-field' && symbol.name === 'Patient.name'));
  assert.ok(kinds.has('sql-query'));
  assert.ok(map.symbols.some(symbol => symbol.kind === 'sql-column' && symbol.name === 'patients.name'));
  assert.ok(map.symbols.some(symbol => symbol.kind === 'orm-model' && symbol.name === 'Appointment'));
  assert.ok(map.references.some(reference => reference.kind === 'import' && reference.target.path === 'frontend/src/api.ts'));
  assert.ok(map.references.every(reference => reference.status === 'candidate'));
  assert.ok(map.symbols.every(symbol => symbol.status === 'found-in-source'));
  assert.ok(map.frameworks.some(framework => framework.name === 'React'));
  assert.ok(map.frameworks.some(framework => framework.name === 'FastAPI'));
  assert.equal(map.files.some(file => file.path === '.env'), false);
  const serialized = JSON.stringify(map);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes('PRIVATE-SYNTHETIC-VALUE'), false);
  assert.equal(serialized.includes('return <h2>'), false);
  assert.equal(map.fingerprint, sourceFingerprint(index));
  assert.ok(map.summary.analyzedFiles >= 5);
  for (const [relative, bytes] of before) assert.deepEqual(await fs.readFile(path.join(root, relative)), bytes, `${relative} must remain unchanged by scanning`);
});

test('source fingerprint changes when any included source hash changes', async t => {
  const root = await project(t), before = await indexRepository(root), first = sourceFingerprint(before);
  await fs.appendFile(path.join(root, 'frontend', 'src', 'api.ts'), '// new source version\n');
  const after = await indexRepository(root);
  assert.notEqual(sourceFingerprint(after), first);
  const map = await buildProjectMap(after);
  assert.equal(map.fingerprint, sourceFingerprint(after));
});
