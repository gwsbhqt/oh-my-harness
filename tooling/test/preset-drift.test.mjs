import assert from 'node:assert/strict';
import {test} from 'node:test';
import {officialPlugins, presetDrift, loadedPresetComparisons} from '../preset-drift.mjs';
import {presetDriftCheck} from '../doctor.mjs';

const js = s => ({__js: s});
const ptc = () => [
  {id: 'persona', name: '@x/persona', config: {prefix: 'p'}},
  {id: 'skill-filesystem', name: '@x/skill-filesystem'},
  {id: 'delegation', name: 'cordis:group', group: true, config: [
    {id: 'workflow-ptc', name: '@x/workflow', disabled: true},
  ]},
  {id: 'tool-presentation', name: '@deepseek-ai/dsh-agent-tool-presentation', config: {mode: 'ptc'}},
  {id: 'tool-plugin-manager', name: '@x/pm', disabled: true},
];
const cordis = () => [
  {id: 'persona', name: '@x/persona', config: {prefix: 'p'}},
  {id: 'skill-filesystem', name: '@x/skill-filesystem', config: {customSkillDirs: [js('dir')]}},
  {id: 'delegation', name: 'cordis:group', group: true, config: [
    {id: 'workflow-ptc', name: '@x/workflow'},
  ]},
  {id: 'tool-cordis', name: '@x/cordis'},
  {id: 'tool-plugin-manager', name: '@x/pm', disabled: js("!ctx.get('profileContext')")},
];

test('已知差别之外两边一致时没有提醒；只是创造模式新增的不用提醒', () => {
  assert.deepEqual(presetDrift(ptc(), cordis()), []);
  const c = cordis(); c.push({id: 'tool-new', name: '@x/new'});
  assert.deepEqual(presetDrift(ptc(), c), [], '创造模式新增的会自动带上');
  const c2 = cordis(); c2[0].config.prefix = 'changed';
  assert.ok(presetDrift(ptc(), c2).some(s => s.includes('persona')), '两边写得不一样要提醒');
});

test('PTC 模式新增、创造模式没有的条目要提醒', () => {
  const p = ptc(); p.push({id: 'tool-ptc-only', name: '@x/only'});
  assert.ok(presetDrift(p, cordis()).some(s => s.includes('PTC 模式新增了 tool-ptc-only')));
});

test('PTC 模式没有工具呈现条目时要提醒', () => {
  const p = ptc().filter(r => r.id !== 'tool-presentation');
  assert.ok(presetDrift(p, cordis()).some(s => s.includes('找不到工具呈现条目')));
});

test('从补丁文档里取条目；读不到要说明', () => {
  assert.equal(officialPlugins([{insert: [{id: 'preset-ptc', config: {plugins: ptc()}}]}], 'preset-ptc').length, 5);
  assert.deepEqual(presetDrift(undefined, cordis()), ['读不到 DSH 自带 PTC 模式的条目']);
});

test('有提醒只进未验证、不算失败；没有给一条通过', () => {
  assert.deepEqual(presetDriftCheck({}), {});
  const bad = presetDriftCheck({presetDrift: {problems: ['缺少 x']}});
  assert.equal(bad.check, undefined);
  assert.match(bad.unverified, /继承不到的官方改动：缺少 x/);
  assert.equal(presetDriftCheck({presetDrift: {problems: []}}).check.ok, true);
});
test('only loaded bundles can request a preset comparison',()=>{
  const active={name:'custom-mode',dir:'/virtual/custom-mode',presetDrift:true};
  assert.deepEqual(loadedPresetComparisons([active]),[active]);
  assert.deepEqual(loadedPresetComparisons([active],[{name:active.name}]),[]);
  assert.deepEqual(loadedPresetComparisons([{...active,error:'load failed'}]),[]);
  assert.deepEqual(loadedPresetComparisons([{...active,dir:undefined}]),[]);
  assert.deepEqual(loadedPresetComparisons([{...active,presetDrift:undefined}]),[]);
  assert.deepEqual(loadedPresetComparisons([{...active,presetDrift:false}]),[]);
  assert.throws(()=>loadedPresetComparisons([{...active,presetDrift:'yes'}]),/must be boolean/);
});

