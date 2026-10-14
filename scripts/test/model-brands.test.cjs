const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../../plugins/client-ui-theme-holo/lib/client.js'),'utf8');
// Exercise the actual shipping module. Expose its pure resolver only inside the
// VM test copy; the application does not need another public service/API.
let helpers;
vm.runInNewContext(source.replace('return { apply, inject:', 'return { brandOf, modelBrand, brandIconCSS, installModelBrands, inject:'), {
  window:{__ModuleLoader__:{load:definition=>{helpers=definition.factory(()=>({}));}}},
});
test('maker identities take priority over model routing services',()=>{
  for(const [model,provider,want] of [
    ['OpenAI: GPT-6 Astra','openrouter','openai'],
    ['anthropic/claude-sonnet','openrouter','anthropic'],
    ['Qwen: Qwen 3','openrouter','qwen'],
    ['cohere/north-mini-code:free','openrouter','cohere'],
    ['K3','kimi-coding','kimi'],['K2.7 Coding','kimi-coding','kimi'],
    ['grok-4.6','xai','grok'],['GPT-5.6 Luna','openai-codex','openai'],
    ['llama3.3:latest','ollama','meta'],['Granite 4.2','lmstudio','ibm'],
    ['unknown-local-model','ollama','ollama'],['private-model','custom-endpoint','generic'],
  ]) assert.equal(helpers.modelBrand(model,provider),want,model);
});
test('provider aliases cover OAuth, local servers and direct API vendors without substring guesses',()=>{
  for(const [name,want] of Object.entries({'ChatGPT':'openai','openai-codex':'openai','Grok':'grok','SpaceXAI':'grok','MoonshotAI':'kimi','OpenRouter':'openrouter','LM Studio':'lmstudio','Z.ai':'zai','Google Vertex':'vertexai'})) assert.equal(helpers.brandOf(name),want,name);
  for(const name of ['__proto__','constructor',null,'my-openai-compatible-proxy','a story about grok']) assert.equal(helpers.brandOf(name),null);
});
test('logo masks are valid bundled SVGs with no network or script references',()=>{
  const css=helpers.brandIconCSS();
  const marks=[...css.matchAll(/data:image\/svg\+xml,([^"\n]+)/g)].map(match=>decodeURIComponent(match[1]));
  assert.ok(marks.length>50);
  for(const svg of marks){assert.match(svg,/<svg .*viewBox="0 0 24 24"/);assert.match(svg,/<\/(?:svg)>$/);assert.doesNotMatch(svg,/<script|<foreignObject|\bon\w+=|href=|<image/);}
  assert.doesNotMatch(css,/url\(["']?https?:/);
});
