const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createRequire}=require('node:module');
const backendRequire=createRequire(path.resolve(__dirname,'../../backend-api/package.json'));
const express=backendRequire('express');
process.env.PROTECTED_RELEASE_FIXTURE_ONLY='1';
const {fixture}=require('./protectedRelease.test.js');
const {digest}=require('./protectedReleaseManifest');
const {createProtectedReleaseStatusHandler}=require('../../backend-api/protectedReleaseStatusRoute');
const {createProtectedReleaseOperationHandler}=require('../../backend-api/protectedReleaseOperationRoute');
const {buildReplacementDeploymentJob}=require('../../backend-api/agentProvisionLock');
const {run:command}=require('../../scripts/headmaster/runtime-release');
const {createOwnerClient,readAccessToken}=require('../../scripts/headmaster/runtimeReleaseOwnerClient');
const {Readable}=require('node:stream');

test('exact approved binding is distinct from local config ID; repo digest additionally requires exact local RepoDigest',async t=>{
  const f=await fixture(t);assert.notEqual(f.manifest.image.binding,f.manifest.image.id);
  assert.equal((await f.adapter.verifyImageBinding(f.manifest)).kind,'local_reference');
  const get=f.docker.getImage;
  f.docker.getImage=()=>({inspect:async()=>({Id:f.manifest.targets[0].image_id})});
  await assert.rejects(f.adapter.verifyImageBinding(f.manifest),/IMAGE_BINDING_CHANGED/);
  f.docker.getImage=get;const m=structuredClone(f.manifest);m.image.binding=`registry.invalid/runtime@sha256:${'9'.repeat(64)}`;
  f.docker.getImage=()=>({inspect:async()=>({Id:m.image.id,RepoDigests:[]})});
  await assert.rejects(f.adapter.verifyImageBinding(m),/IMAGE_BINDING_CHANGED/);
  f.docker.getImage=()=>({inspect:async()=>({Id:m.image.id,RepoDigests:[m.image.binding]})});
  assert.equal((await f.adapter.verifyImageBinding(m)).kind,'local_repo_digest');
});

test('maintained command reserves before LP lock, finalizes after unlock, status only reads and lost finalize ACK stays partial',async t=>{
  const f=await fixture(t);const receipt=await f.run(),id=digest(f.manifest),order=[];
  const job={id:`protected-release-${id}`,data:{id:f.row().id,protected_release:{manifest:f.manifest,release_id:id,receipt}},getState:async()=> 'completed'};
  const owner={prepare:async()=>{order.push('prepare');return {release_id:id,phase:'prepared',metadata_finalized:false};},
    status:async()=>{order.push('status');return {release_id:id,phase:'binding_pending',metadata_finalized:false};},
    finalize:async()=>{order.push('finalize');throw new Error('synthetic lost ACK');}};
  const deps={owner,readFile:async()=>JSON.stringify(f.manifest),db:{query:async()=>({rows:[f.row()]})},getJob:async()=>job,
    acquireLock:async()=>{order.push('lock');return {release:async()=>order.push('unlock')};},loadBackend:async()=>f.backend};
  let result=await command(['--manifest','local.json','--enqueue'],deps);
  assert.deepEqual(order,['prepare','lock','unlock','finalize']);assert.equal(result.phase,'lp_updated_owner_pending');assert.equal(result.metadata_finalized,false);
  order.length=0;result=await command(['--manifest','local.json','--status'],deps);
  assert.deepEqual(order,['status','lock','unlock']);assert.equal(result.phase,'lp_updated_owner_pending');
  order.length=0;owner.prepare=async()=>{throw new Error('fresh owner refused');};
  await assert.rejects(command(['--manifest','local.json','--enqueue'],deps));assert.deepEqual(order,[]);
  owner.status=async()=>({release_id:id,phase:'metadata_finalized',metadata_finalized:true});
  await assert.rejects(command(['--manifest','local.json','--recover'],deps),/OWNER_UNCONFIRMED/);
});

test('account token is protected stdin/in-memory only; owner HTTP is bodyless for replay/finalize and refuses redirects/errors',async()=>{
  assert.equal(await readAccessToken(Readable.from(['synthetic-account-token\n'])),'synthetic-account-token');
  await assert.rejects(readAccessToken(Readable.from(['a'.repeat(8193)])),/TOKEN_INVALID/);
  const calls=[],id='a'.repeat(64);const client=createOwnerClient({origin:'https://owner.invalid',accessToken:'synthetic-account-token',fetchImpl:async(url,options)=>{
    calls.push({url,options});return Response.json({data:{release_id:id,phase:'binding_pending',metadata_finalized:false}});
  }});
  await client.status(id);await client.finalize(id);assert.equal(calls.length,2);
  for(const {options}of calls){assert.equal(options.body,undefined);assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic-account-token');}
  assert.throws(()=>createOwnerClient({origin:'http://owner.invalid',accessToken:'synthetic'}));
  const bad=createOwnerClient({origin:'https://owner.invalid',accessToken:'synthetic',fetchImpl:async()=>new Response('sensitive error',{status:503})});
  await assert.rejects(bad.status(id),e=>e.message==='PROTECTED_RELEASE_OWNER_UNCONFIRMED');
});

test('actual owner-only status HTTP uses canonical reader and refuses stale owner, API keys, body/query and vanished receipt without runtime mutation',async t=>{
  const f=await fixture(t),receipt=await f.run(),id=digest(f.manifest),target=f.manifest.targets[0];
  const job={id:`protected-release-${id}`,data:{id:target.agent_id,protected_release:{manifest:f.manifest,release_id:id,receipt}},getState:async()=> 'completed'};
  let owner=target.owner_id,transfer=false,transferOnLock=false,dbOutage=false,lockLost=false,poolQueries=0,lockQueries=0;
  const rowQuery=async()=>{if(dbOutage)throw new Error('sensitive backend detail');return {rows:[{...f.row(),...(transfer?{user_id:'foreign'}:{})}]};};
  const app=express();app.use((req,res,next)=>{req.user={id:owner};if(req.headers['x-test-api-key'])req.apiKey={};next();});
  app.get('/api/agents/:id/protected-runtime-releases/:releaseId',createProtectedReleaseStatusHandler({
    db:{query:async()=>{poolQueries++;return rowQuery();}},getJob:async key=>key===job.id?job:null,
    acquireLock:async()=>{if(transferOnLock)transfer=true;const controller=new AbortController();if(lockLost)controller.abort();return {signal:controller.signal,query:async()=>{lockQueries++;return rowQuery();},release:async()=>{}};},loadBackend:async()=>f.backend,
  }));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}/api/agents/${target.agent_id}/protected-runtime-releases/${id}`;
  const before=f.events.length;
  assert.equal((await fetch(url)).status,200);
  assert.equal(poolQueries,1);assert.ok(lockQueries>=2,'all proof reads after acquire use held PG query session');
  lockLost=true;assert.equal((await fetch(url)).status,503);lockLost=false;
  dbOutage=true;const unavailable=await fetch(url);assert.equal(unavailable.status,503);assert.ok(!(await unavailable.text()).includes('sensitive'));dbOutage=false;
  owner='foreign';assert.equal((await fetch(url)).status,404);owner=target.owner_id;
  transferOnLock=true;assert.equal((await fetch(url)).status,404);transfer=false;transferOnLock=false;
  assert.equal((await fetch(url,{headers:{'x-test-api-key':'synthetic'}})).status,403);
  assert.equal((await fetch(`${url}?receipt=caller`)).status,400);
  const bodylessStatus=await new Promise((resolve,reject)=>require('node:http').get(url,{headers:{'content-length':'0'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
  assert.equal(bodylessStatus,400);
  const canonical=path.join(f.root,`.protected-release-${id}`,'receipt.json');await fs.rename(canonical,`${canonical}.saved`);
  assert.equal((await fetch(url)).status,409);
  assert.equal(f.events.length,before,'safe read failures do not mutate LP runtime');
});

test('shipped /app layout loads exact shared source with directly locked production dependencies and calls real canonical read',async t=>{
  const f=await fixture(t),receipt=await f.run(),id=digest(f.manifest);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'protected-release-packaged-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const app=path.join(root,'app'),shared=path.join(app,'protected-release');await fs.mkdir(path.join(shared,'backends'),{recursive:true});
  for(const name of ['protectedReleaseStatus','protectedReleaseManifest','protectedReleaseArchive','protectedReleaseDocker'])await fs.copyFile(path.join(__dirname,`${name}.ts`),path.join(shared,`${name}.ts`));
  await fs.copyFile(path.join(__dirname,'backends/dockerExecStream.ts'),path.join(shared,'backends/dockerExecStream.ts'));
  await fs.copyFile(path.resolve(__dirname,'../../backend-api/protectedReleaseStatusRoute.ts'),path.join(app,'protectedReleaseStatusRoute.ts'));
  const pkg=backendRequire('./package.json'),lock=backendRequire('./package-lock.json');
  for(const name of ['tar-stream','tsx']){assert.ok(pkg.dependencies[name]);assert.notEqual(lock.packages[`node_modules/${name}`].dev,true);}
  await fs.symlink(path.dirname(path.dirname(backendRequire.resolve('tar-stream'))),path.join(app,'node_modules'),process.platform==='win32'?'junction':'dir');
  // The status route's cancellable held-session lock must also load from the shipped layout.
  await fs.copyFile(path.join(__dirname,'deploymentLifecycle.ts'),path.join(shared,'deploymentLifecycle.ts'));
  await fs.mkdir(path.join(app,'lib'));await fs.copyFile(path.resolve(__dirname,'../../backend-api/lib/advisoryLocks.ts'),path.join(app,'lib/advisoryLocks.ts'));
  assert.equal(typeof require(path.join(shared,'deploymentLifecycle.ts')).acquireDedicatedSessionLock,'function');
  const packaged=require(path.join(app,'protectedReleaseStatusRoute.ts'));
  const read=packaged.loadShared('protectedReleaseStatus').readProtectedReleaseStatus;
  const Adapter=packaged.loadShared('protectedReleaseDocker').ProtectedReleaseDocker;
  const result=await read({manifest:f.manifest,adapter:new Adapter(f.backend),state:f.state,job:{id:`protected-release-${id}`,data:{id:f.row().id,protected_release:{manifest:f.manifest,release_id:id,receipt}},getState:async()=> 'completed'}});
  assert.equal(result.phase,'external_metadata_pending');assert.equal(result.observed.image_binding,f.manifest.image.binding);
  assert.notEqual(result.observed.image_binding,result.observed.runtime.candidate.image_id);
});

test('admin operation HTTP runs the same dry run and enqueue as the operator command, only for the stored manifest and the owning session',async t=>{
  const f=await fixture(t),id=digest(f.manifest),target=f.manifest.targets[0],row={...f.row(),status:'running'};
  let owner=target.owner_id,locks=0;const queued=[];
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:owner};if(req.headers['x-test-api-key'])req.apiKey={};next();});
  app.post('/api/agents/:id/protected-runtime-releases/:releaseId/operations',createProtectedReleaseOperationHandler({
    db:{query:async()=>({rows:[row]})},acquireLock:async()=>{locks++;return {release:async()=>{}};},loadBackend:async()=>f.backend,
    buildReplacementDeploymentJob,enqueue:async(agent,data,options)=>{queued.push(data);return options.addDeploymentJob(data);},
    createQueueSession:()=>({getJob:async()=>null,addJob:async(data,options)=>({id:options.jobId}),cancelJobs:async()=>({active:0}),close(){}}),
  }));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const url=(agent=target.agent_id,release=id)=>`http://127.0.0.1:${server.address().port}/api/agents/${agent}/protected-runtime-releases/${release}/operations`;
  const post=(body,{agent,release,headers={}}={})=>fetch(url(agent,release),{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const before=f.events.length;
  for(const [body,options] of [[{action:'delete',manifest:f.manifest}],[{action:'apply'}],[{action:'apply',manifest:f.manifest,receipt:{}}],
    [{action:'apply',manifest:f.manifest},{release:'b'.repeat(64)}],[{action:'apply',manifest:f.manifest},{agent:'00000000-0000-0000-0000-000000000099'}]])
    assert.equal((await post(body,options)).status,400);
  assert.equal((await post({action:'apply',manifest:f.manifest},{headers:{'x-test-api-key':'synthetic'}})).status,403);
  owner='foreign';assert.equal((await post({action:'apply',manifest:f.manifest})).status,404);owner=target.owner_id;
  assert.equal(locks,0,'every refusal happens before the agent lock');
  const dry=await post({action:'dry_run',manifest:f.manifest});assert.equal(dry.status,200);assert.equal((await dry.json()).phase,'dry_run');
  assert.equal(queued.length,0);assert.deepEqual(f.events.slice(before).filter(e=>/^(stop|start|rename|create|remove|kill)/.test(String(e))),[],'dry run stops, starts, renames and creates nothing');
  const applied=await post({action:'apply',manifest:f.manifest});assert.equal(applied.status,200);
  assert.deepEqual(await applied.json(),{release_id:id,phase:'queued',job_id:`protected-release-${id}`,publication_blocked:true});
  assert.equal(queued.length,1);assert.equal(queued[0].replace_existing_runtime,false);assert.equal(queued[0].protected_release.release_id,id);
  const recover=await post({action:'recover',manifest:f.manifest});assert.equal(recover.status,409,'nothing to recover before a receipt');
  assert.match((await recover.json()).code,/^PROTECTED_RELEASE_/);
});
