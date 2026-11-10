import {inspect} from 'node:util';
export const name = 'dsh-tooling-ready-probe';
export const inject = ['appReady','appExit'];
export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(async () => {
    const inactive=[];
    for(const entry of ctx.loader.entries()) {
      try { if(entry.disabled)continue; }catch(e){inactive.push({id:entry.id,error:e.message});continue;}
      if(entry.fiber?.state!==2)inactive.push({id:entry.id,name:entry.config?.name,state:entry.fiber?.state??'not imported'});
    }
    if(ctx.reflect.get('doctor')!==undefined) {
      try {
        // A missing App path stops the nested report before startup; still exercise the real Gateway.
        // DSH 0.2.1 起网关要求调用者 Peer；进程内用连接服务建本机所有者 Peer。
        const peer=ctx.reflect.get('connection')?.createPeer({principal:{kind:'owner'}});
        const report=await ctx.reflect.get('typertGateway').invoke({namespace:'doctor',method:'getReport',args:{options:{home:process.env.DSH_HOME,app:'/missing-binding-probe-app'}},peer});
        if(typeof report?.ok!=='boolean'||!Array.isArray(report.checks))throw Error('doctor/getReport 返回格式错误');
      }catch(error){inactive.push({id:'doctor-gateway',error:error.message});}
    }
    // App only fails required core entries; doctor must also reject inactive optional plugins.
    if(inactive.length)for(const log of (Array.isArray(ctx.logger.buffer)?ctx.logger.buffer:[]))console.error('DSH_DOCTOR_LOG:'+inspect({name:log.name,args:log.args},{depth:5,colors:false}));
    console.log('DSH_DOCTOR_READY:'+JSON.stringify({ready:inactive.length===0,inactive}));
    setImmediate(()=>ctx.appExit(inactive.length?1:0));
  }));
}
