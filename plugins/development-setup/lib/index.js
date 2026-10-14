import {defineTool} from '@deepseek-ai/dsh-tools'
import runtime from './runtime.cjs'

export const inject = ['tools']
export async function apply(ctx) {
  let environment = await runtime.inspect(null);
  ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.context({name:'desktop:development-environment',order:116,text:()=>{
      return environment.pythonCommand ? 'Development environment: Python 3 is available as '+environment.pythonCommand+'. Use this command, not an assumed python alias. Use development_setup to inspect project packages and virtual environments.' : 'Development environment: Python 3 is not installed on the agent PATH. Use development_setup to check available tools and guide the user to Settings → Development setup.';
    }});
  });
  ctx.tools.register(defineTool({
    name:'development_setup',
    description:'Read the development environment available to this agent: Node/package managers, Git, the actual Python 3 command, and project setup. Use before assuming python or a package manager exists. This tool does not install anything. Missing tools and project dependencies can be installed by the user in Settings → Development setup.',
    parameters:{},
    output:{schema:{type:'object',additionalProperties:true},render:(_,value)=>[{type:'text',text:JSON.stringify(value)}]},
    timeoutMs:45000,isConcurrencySafe:()=>true,
    execute:async (_args,exec)=>{const result=await runtime.inspect(exec.agent.session.header.cwd);environment=result;return result;},
  }))
}
