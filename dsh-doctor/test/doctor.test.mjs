import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {available,startupFixture} from '../../tooling/test-support/doctor-fixture.mjs';
const doctorBundle={name:'dsh-doctor',path:fileURLToPath(new URL('../',import.meta.url))};
test('实际App doctor工具及getReport注册通过审计',{skip:!available},async()=>{const r=await startupFixture('doctor','export const inject=["doctor","typertGateway","connection"];export function apply(ctx){ctx.effect(()=>ctx.appReady.onReady(async()=>{const r=await ctx.typertGateway.invoke({namespace:"doctor",method:"getReport",args:{options:{app:"/missing"}},peer:ctx.connection.createPeer({principal:{kind:"owner"}})});if(typeof r.ok!=="boolean"||!Array.isArray(r.checks))throw Error("invalid report");console.log("DSH_DOCTOR_SERVICE_CALLED")}))}',doctorBundle);assert.equal(r.ok,true,r.stderr);assert.match(r.stdout,/DSH_DOCTOR_READY:/);assert.match(r.stdout,/DSH_DOCTOR_SERVICE_CALLED/);});

test('实际App doctor远程绑定健康与缺失成对审计',{skip:!available},async()=>{
 const good=await startupFixture('binding-good','export function apply(){}',doctorBundle);assert.equal(good.ok,true,good.stderr);assert.match(good.stdout,/"ready":true/);
 const bad=await startupFixture('binding-bad','export const inject=["doctor"];export function apply(ctx){delete ctx.doctor.typertRemote}',doctorBundle);assert.equal(bad.ok,false,bad.stdout+bad.stderr);assert.match(bad.stdout,/doctor-gateway/);assert.match(bad.stdout,/no visible typertRemote binding/);
});


