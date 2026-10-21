// Runs two real servers against a separate PostgreSQL database, without touching project data.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,relative,isAbsolute,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const dbUrl=new URL(process.env.LIAPER_TEST_DATABASE_URL ?? 'postgres://missing/');
assert.equal(dbUrl.pathname,'/liaper_test','Only the dedicated liaper_test database is allowed');
const dir=mkdtempSync(join(tmpdir(),'liaper-files-integration-'));
const secret=randomBytes(32).toString('hex');
const control='http://127.0.0.1:4400',node='http://127.0.0.1:4205';
const ext=process.platform==='win32'?'.exe':'';
const env={...process.env,DATABASE_URL:dbUrl.href,LIAPER_STORAGE_SECRET:secret,CONTROL_PORT:'4400',FILE_NODE_PORT:'4205',
  FILE_NODE_INTERNAL_URL:node,FILE_NODE_PUBLIC_URL:node,CONTROL_URL:control};
const processes=[],sockets=[],ids=[];
let logs='';
function start(name) {
  const process=spawn(join(root,'target','debug',name+ext),[],{cwd:dir,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  process.stdout.on('data',v=>{logs+=v});process.stderr.on('data',v=>{logs+=v});processes.push(process);
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitReady(url) {for(let i=0;i<100;i++){try{if((await fetch(url)).ok)return;}catch{}await delay(100);}throw new Error('Server startup timed out: '+logs);}
async function api(path,token,body) {
  const response=await fetch(control+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  assert.equal(response.status,200,`${path}: ${await response.clone().text()}`);return response.json();
}
async function register(name,role='student') {
  const response=await fetch(control+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name,display_name:'Storage test',password:'test-password',role,e2ee_public_key:'test',key_fingerprint:'test'})});
  assert.equal(response.status,200);const auth=await response.json();ids.push(auth.user.id);return auth;
}
async function connect(auth) {
  const ws=new WebSocket(control.replace('http','ws')+'/ws?token='+encodeURIComponent(auth.token));
  const messages=[];ws.addEventListener('message',e=>messages.push(JSON.parse(e.data)));sockets.push(ws);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  return {ws,messages};
}
async function until(fn) {for(let i=0;i<100;i++){const value=fn();if(value)return value;await delay(50);}throw new Error('Protocol timeout');}
try {
  start('liaper-control');await waitReady(control+'/api/health');start('liaper-files');await waitReady(node+'/health');
  const suffix=Date.now().toString();const a=await register('file_a_'+suffix,'tutor'),b=await register('file_b_'+suffix),outsider=await register('file_c_'+suffix);
  const ca=await connect(a),cb=await connect(b);
  ca.ws.send(JSON.stringify({type:'send_contact_request',payload:{target_username:b.user.username}}));
  const request=await until(()=>cb.messages.findLast(m=>m.type==='contacts_updated')?.payload.incoming_requests[0]);
  cb.ws.send(JSON.stringify({type:'respond_contact_request',payload:{request_id:request.id,accept:true}}));
  await until(()=>ca.messages.findLast(m=>m.type==='contacts_updated')?.payload.contacts.length);
  // Same stable direct-chat ID as existing clients/server.
  const parts=[a.user.id,b.user.id].sort();
  const room=parts[0].slice(0,18)+parts[1].slice(18);
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);const iv=randomBytes(12);
  const clear=Buffer.from('Private lesson attachment — PDF / image / voice / video are opaque to storage');
  const encrypted=Buffer.from(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,clear));
  const reserved=await api('/api/attachments',a.token,{room_id:room,size_bytes:encrypted.length,sha256:createHash('sha256').update(encrypted).digest('hex')});
  const upload=await fetch(reserved.upload_url,{method:'PUT',headers:{Authorization:`Bearer ${reserved.upload_token}`},body:encrypted});
  assert.equal(upload.status,200,await upload.text());
  // No client completion call: the node itself must charge the owner's quota.
  const usage=await api('/api/storage/usage',a.token);assert.equal(usage.used_bytes,encrypted.length);assert.equal(usage.reserved_bytes,0);assert.equal(usage.quota_bytes,5*1024**3);
  assert.equal((await api('/api/storage/usage',b.token)).used_bytes,0);
  const access=await api(`/api/attachments/${reserved.attachment_id}/download`,b.token);
  const response=await fetch(access.download_url,{headers:{Authorization:`Bearer ${access.download_token}`}});assert.equal(response.status,200);
  const recovered=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,await response.arrayBuffer());assert.deepEqual(Buffer.from(recovered),clear);
  const rejected=await fetch(control+`/api/attachments/${reserved.attachment_id}/download`,{headers:{Authorization:`Bearer ${outsider.token}`}});assert.equal(rejected.status,404);
  assert.equal((await fetch(reserved.upload_url)).status,401);
  console.log('PASS: encrypted upload/download, automatic quota accounting, contact access, owner isolation and unauthorized denial');
} finally {
  for(const ws of sockets)ws.close();
  await Promise.all(processes.map(p=>new Promise(r=>{p.once('exit',r);p.kill();setTimeout(r,3000).unref();})));
  if(ids.length) {
    const psql=process.platform==='win32'?join(process.env.LOCALAPPDATA,'Liaper','PostgreSQL16','pgsql','bin','psql.exe'):'psql';
    const result=spawnSync(psql,['-h',dbUrl.hostname,'-p',dbUrl.port||'5432','-U',decodeURIComponent(dbUrl.username),'-d','liaper_test','-v','ON_ERROR_STOP=1','-c',`DELETE FROM users WHERE id IN (${ids.map(id=>`'${id}'`).join(',')})`],{windowsHide:true,env:{...process.env,PGPASSWORD:decodeURIComponent(dbUrl.password)},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  }
  const relativeDir=relative(resolve(tmpdir()),resolve(dir));
  assert.ok(relativeDir && !relativeDir.startsWith('..') && !isAbsolute(relativeDir) && basename(dir).startsWith('liaper-files-integration-'));
  rmSync(dir,{recursive:true,force:true});
}
