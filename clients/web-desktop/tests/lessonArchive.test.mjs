import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {deriveArchiveKey,encryptArchive,decryptArchive,mergeArchiveLists,syncLessonArchives} from '../src/services/lessonArchive.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../tests/fixtures/lesson-archive-v1.json',import.meta.url)));
test('archive format is authenticated by owner and lesson and rejects wrong password',async()=>{
  const {userId,password,archive,blob}=fixture;
  const key=await deriveArchiveKey(password,userId);
  assert.deepEqual(await decryptArchive(blob,key,userId),archive);
  const encrypted=await encryptArchive(archive,key,userId);
  assert.deepEqual(await decryptArchive({...encrypted,archive_id:archive.id},key,userId),archive);
  await assert.rejects(decryptArchive(blob,await deriveArchiveKey('wrong',userId),userId));
  await assert.rejects(decryptArchive(blob,key,'another-owner'));
  await assert.rejects(decryptArchive({...blob,archive_id:'another-lesson'},key,userId));
});
test('merges concurrent messages without duplicates',()=>{
  const a=fixture.archive;
  const b={...a,savedAt:'2026-10-22T12:01:00Z',messages:[...a.messages,{...a.messages[0],id:'message-2',text:'Ответ'}]};
  assert.equal(mergeArchiveLists([a],[b])[0].messages.length,2);
});
test('drops lessons without messages',()=>{
  const a=fixture.archive;
  assert.deepEqual(mergeArchiveLists([a],[{...a,id:'empty-lesson',messages:[]}]).map((x)=>x.id),[a.id]);
});
test('unreadable remote archive stops sync before any upload',async()=>{
  let writes=0;
  const fetcher=async(_url,options)=>{if(options.method==='PUT') writes++;return Response.json([fixture.blob]);};
  await assert.rejects(syncLessonArchives('', 'session',await deriveArchiveKey('wrong',fixture.userId),fixture.userId,[fixture.archive],fetcher));
  assert.equal(writes,0);
});
test('revision conflict fetches latest and merges before retry',async()=>{
  const key=await deriveArchiveKey(fixture.password,fixture.userId);
  const local={...fixture.archive,savedAt:'2026-10-22T12:01:00Z',messages:[...fixture.archive.messages,{...fixture.archive.messages[0],id:'local',text:'Локальное'}]};
  const remote={...fixture.archive,savedAt:'2026-10-22T12:02:00Z',messages:[...fixture.archive.messages,{...fixture.archive.messages[0],id:'remote',text:'Удалённое'}]};
  let reads=0,writes=0,lastWrite;
  const fetcher=async(_url,options)=>{
    if(options.method==='PUT') {writes++;lastWrite=JSON.parse(options.body);return new Response('{}',{status:writes===1?409:200});}
    reads++;return Response.json(reads===1?[fixture.blob]:[{archive_id:remote.id,revision:2,...await encryptArchive(remote,key,fixture.userId)}]);
  };
  const result=await syncLessonArchives('', 'session',key,fixture.userId,[local],fetcher);
  assert.equal(result[0].messages.length,3);assert.equal(writes,2);assert.equal(lastWrite.expected_revision,2);
});
