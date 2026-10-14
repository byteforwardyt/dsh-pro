const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
const globals={Intl};
function fixture(values){let Component;const client=loadClient('client-ui-theme-holo',()=>{}, {globals,onModule:module=>{Component=module.SessionMetrics}});return client.mount({useProjection:key=>values[key]},Component);}
const metric=(view,label)=>view.find(n=>n.type==='span' && n.props.children.includes(label));
test('session metrics use durable projections and meaningful performance thresholds',async()=>{
  const values={sessionStats:{turns:2,steps:4,llmMs:80000,toolMs:2000,ttftMs:16000,ttftSteps:2,decodeMs:1000,decodeTokens:50},tokenUsage:{uncachedInputTokens:10,cacheReadTokens:90,cacheWriteTokens:0,outputTokens:50},contextPressure:{projectedTokens:950,contextWindow:1000}};
  const view=await fixture(values).flush();
  assert.equal(metric(view,'First token').props['data-tone'],'warn');
  assert.equal(metric(view,'Speed').props['data-tone'],'good');
  assert.equal(metric(view,'Cache').props['data-tone'],'good');
  assert.equal(metric(view,'Context').props['data-tone'],'bad');
  assert.equal(metric(view,'Input').props['data-tone'],undefined);
  assert.equal(metric(view,'Input').props.children[1].props.children[0],'100');
  view.unmount();
});
test('legacy logs retain upstream fallback and unknown context never appears as zero',async()=>{
  const view=await fixture({}).flush();assert.equal(view.tree,null);view.unmount();
  const next=await fixture({tokenUsage:{uncachedInputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:4}}).flush();
  assert.equal(metric(next,'Context'),undefined);assert.equal(metric(next,'Cache'),undefined);next.unmount();
});
test('session metrics hide implausible decode speed from tiny windows',async()=>{
  const view=await fixture({sessionStats:{turns:2,steps:4,llmMs:80000,toolMs:2000,ttftMs:16000,ttftSteps:2,decodeMs:8,decodeTokens:50},tokenUsage:{uncachedInputTokens:10,cacheReadTokens:90,cacheWriteTokens:0,outputTokens:50}}).flush();
  assert.equal(metric(view,'Speed'),undefined);
  view.unmount();
});
test('session metrics hide spike averages above 2500 tok/s',async()=>{
  const view=await fixture({sessionStats:{turns:2,steps:4,llmMs:80000,toolMs:2000,ttftMs:16000,ttftSteps:2,decodeMs:1000,decodeTokens:4000},tokenUsage:{uncachedInputTokens:10,cacheReadTokens:90,cacheWriteTokens:0,outputTokens:50}}).flush();
  assert.equal(metric(view,'Speed'),undefined);
  view.unmount();
});
test('session metrics still show Cerebras-class generation speed',async()=>{
  const view=await fixture({sessionStats:{turns:2,steps:4,llmMs:80000,toolMs:2000,ttftMs:16000,ttftSteps:2,decodeMs:1000,decodeTokens:1800},tokenUsage:{uncachedInputTokens:10,cacheReadTokens:90,cacheWriteTokens:0,outputTokens:50}}).flush();
  assert.equal(metric(view,'Speed').props.children[1].props.children[0],'1800 tok/s');
  assert.equal(metric(view,'Speed').props['data-tone'],'good');
  view.unmount();
});
