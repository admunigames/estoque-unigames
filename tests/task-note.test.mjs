import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { callRoute, setupRouteDb } from "./helpers/route-db.mjs";

// Nota adesiva de Tarefas (16/11/2026): tarefas de hoje em qualquer módulo e,
// no computador, fora do site (Document Picture-in-Picture).

const html = await readFile(new URL("../public/estoque.html", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

test("interruptor NOTA DE TAREFAS na aba Tarefas e no menu do usuário", () => {
  assert.match(html, /<input type="checkbox" class="home-task-check" id="taskNoteEnabled"[^>]*> NOTA DE TAREFAS<\/label>/);
  assert.match(html, /<button id="btnTaskNoteToggle" type="button" role="menuitem" hidden>NOTA DE TAREFAS: LIGADA<\/button>/);
  assert.match(html, /el\('taskNoteEnabled'\)\.addEventListener\('change', event => setTaskNoteEnabled\(event\.target\.checked\)\)/);
  assert.match(html, /storage\.set\(TASK_NOTE_STATE_KEY, JSON\.stringify\(\{enabled\}\)\)/);
  assert.match(html, /<aside class="task-note" id="taskNote"[^>]*hidden><\/aside>/);
});

test("concluir pela nota, pela Início e pela aba usa a MESMA função setTaskDone", () => {
  const calls = html.match(/await setTaskDone\(/g) || [];
  assert.equal(calls.length, 3);
  assert.match(html, /async function onTaskNoteChange[\s\S]{0,300}await setTaskDone\(todayDateKey\(\), id, event\.target\.checked\)/);
  assert.match(html, /el\('taskList'\)\.addEventListener\('change'[\s\S]{0,400}await setTaskDone\(el\('taskDate'\)\.value, id, event\.target\.checked, data\)/);
  // Nenhum handler grava task.done por conta própria: a regra (carryover + recorrência) existe uma vez só.
  assert.doesNotMatch(html, /task\.done = event\.target\.checked/);
  assert.match(html, /async function setTaskDone[\s\S]{0,700}syncTaskRecurrence\(dateKey,task,true\)/);
});

test("⧉ só aparece com documentPictureInPicture (sem window.open)", () => {
  assert.match(html, /const taskNotePipSupported = \(\) => 'documentPictureInPicture' in window && !matchMedia\('\(max-width:680px\)'\)\.matches;/);
  assert.match(html, /\(taskNotePipSupported\(\) \? '<button class="task-note-btn" type="button" data-task-note-action="pip"[^']*>⧉<\/button>' : ''\)/);
  assert.match(html, /window\.documentPictureInPicture\.requestWindow\(\{width:260,height:320\}\)/);
  const pipBlock = html.slice(html.indexOf("async function openTaskNotePip"), html.indexOf("async function onTaskNoteChange"));
  assert.doesNotMatch(pipBlock, /window\.open\(/);
  assert.match(pipBlock, /el\('taskNoteStyles'\)\.textContent/);
});

test("worker libera a preferência da nota para quem vê Tarefas", () => {
  assert.match(worker, /if \(key === "tarefas-nota"\) return \["tasks:view", "tasks:manage"\];/);
});

test("shared-state guarda 'tarefas-nota' separado por usuário", async () => {
  await setupRouteDb(["shared_state"]);
  const route = await import("../app/api/shared-state/route.ts");
  const ana = { id: "ana", permissions: ["tasks:view"] };
  const bia = { id: "bia", permissions: ["tasks:view"] };
  const put = await callRoute(route.PUT, ana, "PUT", "/api/shared-state", { key: "tarefas-nota", value: '{"enabled":false}' });
  assert.equal(put.status, 200);
  const read = async (user) => (await (await callRoute(route.GET, user, "GET", "/api/shared-state?key=tarefas-nota")).json()).value;
  assert.equal(await read(ana), '{"enabled":false}');
  assert.equal(await read(bia), null);
});

test("conta principal não lê mais a lista antiga sem usuário (tarefas:DATA)", async () => {
  const route = await import("../app/api/shared-state/route.ts");
  const legacy = JSON.stringify({ tasks: [{ id: "x", text: "TAREFA ANTIGA DA LOJA" }], notes: "" });
  await globalThis.__routeTestDb.prepare("INSERT INTO shared_state (state_key, value_json, version, updated_at) VALUES (?1, ?2, 1, ?3)")
    .bind("tarefas:2099-05-05", legacy, "2099-05-05").run();
  const saved = await globalThis.__routeTestDb.prepare("SELECT value_json AS v FROM shared_state WHERE state_key=?1").bind("tarefas:2099-05-05").first();
  assert.equal(saved.v, legacy, "lista antiga existe no banco");
  const main = { id: "env-admin", role: "admin", permissions: [] };
  const day = await (await callRoute(route.GET, main, "GET", "/api/shared-state?key=tarefas:2099-05-05")).json();
  assert.equal(day.value, null);
  const agenda = await (await callRoute(route.GET, main, "GET", "/api/shared-state?scope=task-agenda&from=2099-01-01")).json();
  assert.deepEqual(agenda.items, []);
  assert.doesNotMatch(html, /currentSession\.id === 'env-admin' && scopedKey !== key/);
  assert.doesNotMatch(worker, /\? "env-admin"\s*: row\.stateKey/);
});
