import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UsageSummaryCache } from '../lib/usage-cache.js'

test('summary cache bounds entries and evicts the least recently used payload',()=>{
  const cache=new UsageSummaryCache({maxEntries:2,maxBytes:10000})
  cache.set('a',{tokens:1});cache.set('b',{tokens:2})
  assert.deepEqual(cache.get('a'),{tokens:1})
  cache.set('c',{tokens:3})
  assert.equal(cache.get('b'),undefined)
  assert.equal(cache.size,2);assert.deepEqual(cache.get('a'),{tokens:1})
  cache.delete('a');cache.delete('c')
  assert.equal(cache.retainedBytes,0);assert.equal(cache.size,0)
})

test('cache accounts for string payload bytes on replacement and refuses oversized summaries',()=>{
  const cache=new UsageSummaryCache({maxEntries:10,maxBytes:100})
  cache.set('a',{text:'x'.repeat(20)})
  cache.set('b',{text:'y'.repeat(20)})
  assert.equal(cache.get('a'),undefined);assert.ok(cache.get('b'))
  assert.ok(cache.retainedBytes<=100)
  cache.set('b',{text:'small'})
  assert.equal(cache.retainedBytes,2*('b'.length+JSON.stringify({text:'small'}).length))
  cache.set('b',{text:'x'.repeat(1000)})
  assert.equal(cache.get('b'),undefined);assert.equal(cache.retainedBytes,0)
})

test('cached summaries do not retain or share a caller-mutable object graph',()=>{
  const cache=new UsageSummaryCache()
  const source={summary:{tokens:12}}
  cache.set('a',source)
  source.summary.tokens=0
  const first=cache.get('a');first.summary.tokens=1
  assert.equal(cache.get('a').summary.tokens,12)
})

test('disabled cache budgets retain no entries',()=>{
  for(const options of [{maxEntries:0},{maxBytes:0}]){
    const cache=new UsageSummaryCache(options);cache.set('a',{tokens:12})
    assert.equal(cache.size,0);assert.equal(cache.retainedBytes,0)
  }
})
