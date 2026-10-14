import {test} from 'node:test'
import assert from 'node:assert/strict'
import {AttemptRegistry} from '../lib/attempts.js'
import {AuthorizationDeclinedError} from '@deepseek-ai/dsh-authorization'

const outcome = promise => Promise.race([promise.then(value=>({status:'resolved',value}),error=>({status:'rejected',error})),new Promise(resolve=>setImmediate(()=>resolve({status:'pending'})))])
const prompt = signal => ({kind:'text',message:'Fixture prompt',signal})

test('closed attempt callbacks cannot publish into a replacement attempt',async()=>{
  const events=[],registry=new AttemptRegistry(event=>events.push(event))
  const old=registry.open('key');registry.close('key',old.id)
  const current=registry.open('key'),before=events.length
  old.interaction.notify({message:'Late old notice'})
  assert.equal(events.length,before)
  const late=await outcome(old.interaction.prompt(prompt()))
  assert.equal(late.status,'rejected');assert.equal(late.error instanceof AuthorizationDeclinedError,false)
  assert.equal(registry.has('key',current.id),true)
  registry.close('key',current.id)
})

test('already-aborted prompts reject without publishing a prompt or leaving a pending resolver',async()=>{
  const events=[],registry=new AttemptRegistry(event=>events.push(event)),attempt=registry.open('key')
  const result=await outcome(attempt.interaction.prompt(prompt(AbortSignal.abort())))
  registry.close('key',attempt.id)
  assert.equal(result.status,'rejected');assert.equal(result.error instanceof AuthorizationDeclinedError,false)
  assert.equal(events.some(event=>event.type==='prompt'),false)
})

test('overlapping prompts cannot orphan the first resolver',async()=>{
  const registry=new AttemptRegistry(()=>{}),attempt=registry.open('key')
  const first=attempt.interaction.prompt(prompt())
  const firstId=registry.snapshot()[0].prompt.id
  const second=await outcome(attempt.interaction.prompt(prompt()))
  assert.equal(second.status,'rejected')
  assert.equal(registry.answer('key',firstId,'answer'),true)
  assert.equal(await first,'answer')
  registry.close('key',attempt.id)
})

test('snapshots are detached from live notice and prompt state',async()=>{
  const registry=new AttemptRegistry(()=>{}),attempt=registry.open('key')
  attempt.interaction.notify({message:'First'})
  const waiting=outcome(attempt.interaction.prompt({...prompt(),options:[{id:'a',label:'A'}]}))
  const snapshot=registry.snapshot()
  attempt.interaction.notify({message:'Second'})
  assert.equal(snapshot[0].notices.length,1)
  snapshot[0].notices[0].message='Changed copy';snapshot[0].prompt.options[0].label='Changed copy'
  assert.equal(registry.snapshot()[0].notices[0].message,'First')
  assert.equal(registry.snapshot()[0].prompt.options[0].label,'A')
  registry.close('key',attempt.id);await waiting
})

test('withdrawal and explicit decline preserve their distinct meanings',async()=>{
  const events=[],registry=new AttemptRegistry(event=>events.push(event)),attempt=registry.open('key')
  const controller=new AbortController()
  const withdrawn=outcome(attempt.interaction.prompt(prompt(controller.signal)))
  controller.abort();assert.equal((await withdrawn).error instanceof AuthorizationDeclinedError,false)
  const declined=outcome(attempt.interaction.prompt(prompt()))
  assert.equal(registry.decline('key',registry.snapshot()[0].prompt.id),true)
  assert.equal((await declined).error instanceof AuthorizationDeclinedError,true)
  assert.equal(registry.snapshot()[0].prompt,null)
  registry.close('key',attempt.id)
})

test('dispose rejects owned prompts and disables callbacks and new attempts',async()=>{
  const events=[],registry=new AttemptRegistry(event=>events.push(event)),attempt=registry.open('key')
  const waiting=outcome(attempt.interaction.prompt(prompt()))
  registry.dispose()
  assert.equal((await waiting).status,'rejected');assert.deepEqual(registry.snapshot(),[])
  const before=events.length;attempt.interaction.notify({message:'Late'})
  assert.equal(events.length,before);assert.throws(()=>registry.open('next'))
})


test('attempt and prompt ids cannot collide after registry recreation; stale cleanup preserves its replacement',async()=>{
  const firstRegistry=new AttemptRegistry(()=>{}),first=firstRegistry.open('key')
  const waiting=outcome(first.interaction.prompt(prompt()))
  const firstPrompt=firstRegistry.snapshot()[0].prompt.id
  assert.throws(()=>firstRegistry.open('key'),/already owns/)
  firstRegistry.dispose();await waiting
  const secondRegistry=new AttemptRegistry(()=>{}),second=secondRegistry.open('key')
  const secondWaiting=outcome(second.interaction.prompt(prompt()))
  assert.notEqual(first.id,second.id)
  assert.notEqual(firstPrompt,secondRegistry.snapshot()[0].prompt.id)
  assert.equal(secondRegistry.close('key',first.id),false)
  assert.equal(secondRegistry.answer('key',firstPrompt,'stale'),false)
  assert.equal(secondRegistry.has('key',second.id),true)
  secondRegistry.dispose();await secondWaiting
})
