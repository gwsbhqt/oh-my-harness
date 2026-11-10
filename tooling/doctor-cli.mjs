#!/usr/bin/env node
import { doctor } from './doctor.mjs';
import { parseArgs } from 'node:util';
try {
 const {values}=parseArgs({options:{home:{type:'string'},profile:{type:'string'},app:{type:'string'},json:{type:'boolean'},full:{type:'boolean'},'repair-credentials':{type:'boolean'},'sanitize-env':{type:'boolean'},'timeout-ms':{type:'string'},help:{type:'boolean',short:'h'}}});
 if(values.help){console.log('doctor [--home <DSH_HOME>] [--profile desktop] [--app <App.app>] [--json] [--full] [--repair-credentials] [--sanitize-env] [--timeout-ms 120000]\n默认离线组合并隔离试启动；--full 显式发送单次模型请求。仅 --repair-credentials 会修改真实凭据权限。');}
 else {
  const report=await doctor({home:values.home,profile:values.profile,app:values.app,full:values.full,repairCredentials:values['repair-credentials'],sanitizeEnv:values['sanitize-env'],timeoutMs:values['timeout-ms']===undefined?undefined:Number(values['timeout-ms'])});
  console.log(values.json?JSON.stringify(report):[`${report.ok?'通过':'失败'}：${report.checks.filter(c=>c.ok).length}/${report.checks.length} 项`,...report.checks.map(c=>`${c.ok?'✓':'✗'} ${c.id}: ${c.message}${!c.ok&&c.fix?'\n  修复：'+c.fix:''}`),...report.unverified.map(message=>'未验证：'+message)].join('\n'));
  process.exitCode=report.ok?0:1;
 }
} catch(e){console.error(e.message);process.exitCode=2;}
