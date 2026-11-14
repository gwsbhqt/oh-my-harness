import { defineTool } from '@deepseek-ai/dsh-tools';
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol';
import { doctor } from '../../tooling/doctor.mjs';
export const name = 'dsh-doctor';
export const inject = ['tools','typert'];
export function apply(ctx) {
 const definition=defineTool({name:'doctor',description:'启动前检查：只读实际配置，在临时 DSH_HOME 组合并隔离试启动 App；默认不调用模型。客户端激活另需 GUI 验证。',parameters:{home:{type:'string',description:'DSH_HOME'},profile:{type:'string',description:'profile 名称，默认 desktop'},app:{type:'string',description:'App 路径'},full:{type:'boolean',description:'显式授权单次模型调用'},timeoutMs:{type:'number',description:'全程总超时，默认 120000ms'}},output:{schema:{type:'object',properties:{ok:{type:'boolean'},checks:{type:'array',items:{type:'object',additionalProperties:true}}},additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value,null,2)}]},isConcurrencySafe:()=>true,execute:args=>doctor({...args,sanitizeEnv:true,repairCredentials:false})});
 ctx.tools.register(definition);
 const service={getReport:options=>definition.execute({...options,sanitizeEnv:true,repairCredentials:false})};
 service.typertRemote=bindTypertRemote(service,'doctor');
 ctx.provide('doctor',service);
 ctx.typert.register({package:'dsh-doctor',face:'host',model:{services:[],events:[],objects:[]},schemas:[],invocations:[{id:'dsh-doctor:getReport',service:'doctor',namespace:'doctor',method:'getReport',invocation:{kind:'direct'},parameters:[{name:'options',wire:'options',source:'json',acceptsUndefined:true,codec:{mode:'src-json'}}],result:{mode:'src-json'}}]});
}
