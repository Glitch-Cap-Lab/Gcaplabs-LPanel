// A fleet rollout builds each bot's manifest from LP's own row and Docker. The target it
// reads must be exactly what the dry run and swap then accept for that bot.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {createRequire}=require('node:module');
const backendRequire=createRequire(path.resolve(__dirname,'../../backend-api/package.json'));
const express=backendRequire('express');
process.env.PROTECTED_RELEASE_FIXTURE_ONLY='1';
const {fixture}=require('./protectedRelease.test.js');
const {describeProtectedReleaseTarget}=require('./protectedReleaseTarget');
const {ProtectedReleaseDocker}=require('./protectedReleaseDocker');
const {runProtectedReleaseOperation}=require('./protectedReleaseOperation');
const {createProtectedReleaseTargetHandler}=require('../../backend-api/protectedReleaseTargetRoute');

const withoutSite=({site_binding,...target})=>target;

test('the target read from LP and Docker is the one a hand-built manifest carries, and the dry run accepts it',async t=>{
  const f=await fixture(t),row={...f.row(),status:'running'};
  const target=await describeProtectedReleaseTarget(row,new ProtectedReleaseDocker(f.backend));
  assert.deepEqual(target,withoutSite(f.manifest.targets[0]));
  const manifest={...f.manifest,targets:[{...target,site_binding:f.manifest.targets[0].site_binding}]};
  const result=await runProtectedReleaseOperation('--dry-run',manifest,{db:{query:async()=>({rows:[row]})},acquireLock:async()=>({release:async()=>{}}),loadBackend:async()=>f.backend});
  assert.equal(result.phase,'dry_run');
});

test('a bot that is not running, not Headmaster-owned or whose container does not match is refused',async t=>{
  const f=await fixture(t),row={...f.row(),status:'running'},adapter=new ProtectedReleaseDocker(f.backend);
  for(const [change,code] of [[{status:'queued'},'PROTECTED_RELEASE_RUNNING_REQUIRED'],[{external_namespace:'other'},'PROTECTED_RELEASE_OWNER_CHANGED'],
    [{headmaster_workspace_id:'00000000-0000-0000-0000-000000000099'},'PROTECTED_RELEASE_OWNER_CHANGED'],[{container_name:'someone-else'},'PROTECTED_RELEASE_RUNTIME_CHANGED'],
    [{id:'00000000-0000-0000-0000-000000000099'},'PROTECTED_RELEASE_RUNTIME_CHANGED']])
    await assert.rejects(describeProtectedReleaseTarget({...row,...change},adapter),error=>error.code===code,JSON.stringify(change));
});

test('the target route serves only the owning session and changes nothing',async t=>{
  const f=await fixture(t),row={...f.row(),status:'running'},target=f.manifest.targets[0];
  let owner=target.owner_id;const app=express();
  app.use((req,res,next)=>{req.user={id:owner};if(req.headers['x-test-api-key'])req.apiKey={};next();});
  app.get('/api/agents/:id/protected-runtime-target',createProtectedReleaseTargetHandler({db:{query:async()=>({rows:[row]})},loadBackend:async()=>f.backend}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const get=(agent=target.agent_id,headers={},query='')=>fetch(`http://127.0.0.1:${server.address().port}/api/agents/${agent}/protected-runtime-target${query}`,{headers});
  const before=f.events.length;
  const ok=await get();assert.equal(ok.status,200);assert.deepEqual((await ok.json()).target,withoutSite(target));
  assert.equal((await get('not-a-uuid')).status,400);assert.equal((await get(undefined,{},'?x=1')).status,400);
  assert.equal((await get(undefined,{'x-test-api-key':'synthetic'})).status,403);
  owner='foreign';assert.equal((await get()).status,404);owner=target.owner_id;
  row.status='queued';const refused=await get();assert.equal(refused.status,409);assert.equal((await refused.json()).code,'PROTECTED_RELEASE_RUNNING_REQUIRED');
  assert.deepEqual(f.events.slice(before).filter(e=>/^(stop|start|rename|create|remove|kill|exec)/.test(String(e))),[]);
});

test('progress reads the phase the running job journaled, without the agent lock, for the owning session only',async t=>{
  const {createProtectedReleaseProgressHandler}=require('../../backend-api/protectedReleaseProgressRoute');
  const {digest}=require('./protectedReleaseManifest');
  const f=await fixture(t),target=f.manifest.targets[0],id=digest(f.manifest);
  let owner=target.owner_id,state='active',receipt={release_id:id,phase:'stopped'};
  const job={id:`protected-release-${id}`,get data(){return {id:target.agent_id,protected_release:{release_id:id,manifest:f.manifest,receipt}};},getState:async()=>state};
  const app=express();app.use((req,res,next)=>{req.user={id:owner};next();});
  app.get('/api/agents/:id/protected-runtime-releases/:releaseId/progress',createProtectedReleaseProgressHandler({
    db:{query:async()=>({rows:[{id:target.agent_id,user_id:target.owner_id}]})},getJob:async name=>name===job.id?job:null}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const get=async(release=id)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/agents/${target.agent_id}/protected-runtime-releases/${release}/progress`);return [r.status,await r.json()];};
  assert.deepEqual(await get(),[200,{release_id:id,queue_state:'active',phase:'stopped',lp_committed:false,publication_blocked:true}]);
  receipt={release_id:id,phase:'candidate_healthy'};assert.equal((await get())[1].phase,'candidate_healthy','each journaled phase shows as it happens');
  receipt=null;state='failed';assert.equal((await get())[1].phase,'failed_before_receipt');
  state='waiting';assert.equal((await get())[1].phase,'queued');
  assert.equal((await get('b'.repeat(64)))[0],404);
  owner='foreign';assert.equal((await get())[0],404);
});
