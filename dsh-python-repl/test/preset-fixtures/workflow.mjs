import { Service } from '@deepseek-ai/cordis'

// Same guard as @deepseek-ai/dsh-workflow-ptc's constructor.
export default class WorkflowEngine extends Service {
  static inject = ['ptcRuntime']
  constructor(ctx) {
    super(ctx, 'workflowEngine')
    if (ctx.ptcRuntime.language !== 'typescript') throw new Error('workflow-ptc requires the Node TypeScript PTC runtime')
    this.runtimeLanguage = ctx.ptcRuntime.language
  }
}
