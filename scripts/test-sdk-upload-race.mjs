import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
const require = createRequire(import.meta.url);
const {installUploadConfirmationCoordinator} = require('../src/uploadConfirmationCoordinator.ts');
const installedRoot = path.resolve(path.dirname(require.resolve('@warriorteam/zalo-personal')), '../..');
const root = process.env.ZALO_SDK_TEST_ROOT || installedRoot;
async function modules(format) {
  if (format === 'cjs') return {
    ...require(path.join(root, 'dist/cjs/context.cjs')),
    ...require(path.join(root, 'dist/cjs/apis/uploadAttachment.cjs')),
    ...require(path.join(root, 'dist/cjs/apis/sendMessage.cjs')),
    ...require(path.join(root, 'dist/cjs/apis/listen.cjs')),
    ...require(path.join(root, 'dist/cjs/utils.cjs')),
  };
  const load = p => import(pathToFileURL(path.join(root, 'dist', p)));
  return Object.assign({}, ...await Promise.all(['context.js','apis/uploadAttachment.js','apis/sendMessage.js','apis/listen.js','utils.js'].map(load)));
}
async function scenario(format, scenario) {
  const {createContext, uploadAttachmentFactory, sendMessageFactory, Listener, encodeAES} = await modules(format);
  const server = new WebSocketServer({port: 0});
  await new Promise(resolve => server.once('listening', resolve));
  const ctx = createContext();
  ctx.secretKey = Buffer.alloc(32, 1).toString('base64');
  ctx.userAgent = 'fixture'; ctx.imei = 'fixture';
  ctx.cookie = {getCookieStringSync: () => '', getCookieString: async () => ''};
  ctx.settings = {features:{socket:{retries:{},close_and_retry_codes:[],rotate_error_codes:[]},sharefile:{max_file:5,max_size_share_file_v3:10,restricted_ext_file:[],chunk_size_file:scenario.startsWith("multi") ? 4 : 1024}}};
  const releaseResponses = []; let recipientSends = 0;
  const response = data => ({ok:true,headers:{get:()=>null},json:async()=>({error_code:0,data:encodeAES(ctx.secretKey,JSON.stringify({error_code:0,data}))})});
  ctx.options.polyfill = async (url) => {
    if (String(url).includes('asyncfile/upload')) {
      await new Promise(resolve => { releaseResponses.push(resolve); });
      return response({fileId:'synthetic-1',clientFileId:'synthetic-client'});
    }
    recipientSends++;
    return response({msgId:'synthetic-message'});
  };
  const listener = new Listener(ctx, [`ws://127.0.0.1:${server.address().port}`]);
  const connected = new Promise(resolve => server.once('connection', resolve));
  listener.start(); const socket = await connected;
  const api = {listener,zpwServiceMap:{file:['https://fixture.invalid'],chat:['https://fixture.invalid'],group:['https://fixture.invalid']}};
  api.uploadAttachment = uploadAttachmentFactory(ctx, api);
  api.sendMessage = sendMessageFactory(ctx, api);
  installUploadConfirmationCoordinator(api, ["missing", "late-http"].includes(scenario) ? 100 : 2_000);
  const pending = api.sendMessage({msg:'',attachments:{filename:'synthetic.pdf',data:Buffer.from('fixture'),metadata:{totalSize:7}}},'synthetic-thread'); // ubs:ignore - Both outcome handlers attach immediately below.
  const outcome = pending.then(value => ({value}), error => ({error}));
  while (releaseResponses.length < (scenario.startsWith("multi") ? 2 : 1)) await new Promise(resolve => setImmediate(resolve));
  const releaseResponse = () => releaseResponses[0]();
  async function event(id) {
    const seen = new Promise(resolve => listener.once('upload_attachment', resolve));
    const header = Buffer.from([1, 601 & 255, 601 >> 8, 0]);
    const payload = {data:{controls:[{content:{act_type:'file_done',fileId:id,data:{url:'https://fixture.invalid/file'}}}]}};
    socket.send(Buffer.concat([header, Buffer.from(JSON.stringify({encrypt:0,data:JSON.stringify(payload)}))]));
    await seen;
  }
  if (scenario === 'multi-normal') {
    releaseResponses[0](); releaseResponses[1]();
    while (!ctx.uploadCallbacks.has('synthetic-1')) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 20));
    await event('synthetic-1');
    const result = await outcome; assert.ok(result.value, String(result.error)); assert.equal(recipientSends, 1);
  } else if (scenario === 'multi') {
    await event('synthetic-1'); releaseResponses[0]();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(recipientSends, 0, 'all chunks must finish before recipient submission');
    releaseResponses[1]();
    const result = await outcome; assert.ok(result.value, String(result.error)); assert.equal(recipientSends, 1);
  } else if (scenario === 'early') {
    await event('wrong-file'); await event('synthetic-1'); await event('synthetic-1'); releaseResponse();
    const result = await outcome; assert.ok(result.value, String(result.error)); assert.equal(recipientSends, 1);
  } else if (scenario === 'normal') {
    releaseResponse();
    while (!ctx.uploadCallbacks.has('synthetic-1')) await new Promise(resolve => setImmediate(resolve));
    await event('synthetic-1'); await event('synthetic-1');
    const result = await outcome; assert.ok(result.value, String(result.error)); assert.equal(recipientSends, 1);
  } else if (scenario === 'missing') {
    releaseResponse(); await event('wrong-file');
    const result = await outcome; assert.match(String(result.error), /zalo_upload_callback_timeout/);
    await event('synthetic-1'); assert.equal(recipientSends, 0); assert.equal(ctx.uploadCallbacks.has('synthetic-1'), false);
  } else {
    if (scenario === 'close') listener.emit('disconnected', 1006, 'fixture');
    const result = await outcome; assert.match(String(result.error), /zalo_upload_callback_timeout/);
    releaseResponse(); await new Promise(resolve => setTimeout(resolve, 20));
    await event('synthetic-1'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(recipientSends, 0); assert.equal(ctx.uploadCallbacks.has('synthetic-1'), false);
  }
  listener.stop(); await new Promise(resolve => server.close(resolve));
}
async function crossUploads(format) {
  const {createContext, uploadAttachmentFactory, sendMessageFactory, Listener, encodeAES} = await modules(format);
  const realNow = Date.now; let now = 1_000_000; Date.now = () => now;
  const server = new WebSocketServer({port:0}); await new Promise(resolve => server.once('listening',resolve));
  const ctx = createContext(); ctx.secretKey = Buffer.alloc(32,1).toString('base64'); ctx.userAgent='fixture'; ctx.imei='fixture';
  ctx.cookie = {getCookieStringSync:()=>'',getCookieString:async()=>''};
  ctx.settings = {features:{socket:{retries:{},close_and_retry_codes:[],rotate_error_codes:[]},sharefile:{max_file:5,max_size_share_file_v3:10,restricted_ext_file:[],chunk_size_file:1024}}};
  let nextId=''; const requests=[]; let recipientSends=0;
  const response = data => ({ok:true,headers:{get:()=>null},json:async()=>({error_code:0,data:encodeAES(ctx.secretKey,JSON.stringify({error_code:0,data}))})});
  ctx.options.polyfill = async url => {
    if (String(url).includes('photo_original/upload')) return response({photoId:'fixture',normalUrl:'https://fixture.invalid/image',hdUrl:'https://fixture.invalid/image',thumbUrl:'https://fixture.invalid/image',finished:1});
    if (String(url).includes('asyncfile/upload')) {
      const id=nextId; await new Promise(resolve => requests.push({id,release:resolve}));
      return response({fileId:id,clientFileId:'fixture'});
    }
    recipientSends++; return response({msgId:'fixture'});
  };
  const listener=new Listener(ctx,[`ws://127.0.0.1:${server.address().port}`]);
  const connected=new Promise(resolve=>server.once('connection',resolve)); listener.start(); const socket=await connected;
  const api={listener,zpwServiceMap:{file:['https://fixture.invalid'],chat:['https://fixture.invalid'],group:['https://fixture.invalid']}};
  api.uploadAttachment=uploadAttachmentFactory(ctx,api); api.sendMessage=sendMessageFactory(ctx,api);
  installUploadConfirmationCoordinator(api,350);
  const event = async id => {
    const seen=new Promise(resolve=>listener.once('upload_attachment',resolve));
    const header=Buffer.from([1,601 & 255,601 >> 8,0]);
    const payload={data:{controls:[{content:{act_type:'file_done',fileId:id,data:{url:'https://fixture.invalid/file'}}}]}};
    socket.send(Buffer.concat([header,Buffer.from(JSON.stringify({encrypt:0,data:JSON.stringify(payload)}))])); await seen;
  };
  const begin = async id => {
    nextId=id; const count=requests.length;
    const outcome=api.sendMessage({msg:'',attachments:{filename:'synthetic.pdf',data:Buffer.from('fixture'),metadata:{totalSize:7}}},'synthetic-thread').then(value=>({value}),error=>({error}));
    while (requests.length === count) await new Promise(resolve=>setImmediate(resolve));
    return {outcome,request:requests[count]};
  };
  const waitRegistered = async id => { while (!ctx.uploadCallbacks.has(id)) await new Promise(resolve=>setImmediate(resolve)); };
  const success = async id => {const x=await begin(id); x.request.release(); await waitRegistered(id); await event(id); assert.ok((await x.outcome).value);};
  try {
    await assert.rejects(api.uploadAttachment(null,'synthetic-thread'), /Missing sources/);
    await success('validation-next');
    const a=await begin('old-id'); a.request.release(); await waitRegistered('old-id');
    assert.match(String((await a.outcome).error),/zalo_upload_callback_timeout/);
    const b=await begin('fresh-id'); b.request.release(); await waitRegistered('fresh-id');
    await event('old-id'); await event('fresh-id'); assert.ok((await b.outcome).value);
    const reused=await begin('old-id'); reused.request.release();
    assert.match(String((await reused.outcome).error),/zalo_upload_confirmation_cooldown/);
    now += 5*60_000 + 1; await success('old-id');
    const delayed=await begin('delayed-id'); assert.match(String((await delayed.outcome).error),/zalo_upload_callback_timeout/);
    const countBeforeCooldown = requests.length; nextId='during-id';
    await assert.rejects(api.sendMessage({msg:'',attachments:{filename:'synthetic.pdf',data:Buffer.from('fixture'),metadata:{totalSize:7}}},'synthetic-thread'), /zalo_upload_confirmation_cooldown/);
    assert.equal(requests.length,countBeforeCooldown,'cooldown must reject before HTTP upload');
    const image = await api.sendMessage({msg:'',attachments:{filename:'fixture.png',data:Buffer.from('fixture'),metadata:{totalSize:7,width:1,height:1}}},'synthetic-thread');
    assert.ok(image, 'image upload must remain available during a file confirmation cooldown');
    delayed.request.release(); await event('delayed-id');
    now += 5*60_000 + 1; await success('after-delay');
    const saturated=await begin('saturation-target');
    for (let i=0;i<65;i++) await event(`unrelated-${i}`);
    saturated.request.release(); await event('saturation-target');
    assert.match(String((await saturated.outcome).error),/zalo_upload_confirmation_cooldown/);
    now += 5*60_000 + 1; await success('after-saturation');
    assert.equal(recipientSends,6,'only confirmed current files and the unaffected image can submit to recipient');
  } finally { Date.now=realNow; listener.stop(); await new Promise(resolve=>server.close(resolve)); }
}
for (const format of ['esm','cjs']) for (const name of ['early','normal','missing','late-http','close','multi','multi-normal']) await scenario(format,name);
for (const format of ['esm','cjs']) await crossUploads(format);
console.log('[test:sdk-upload-race] ok');
process.exit(0); // SDK 1.4.1 has five-minute callback-map expiry timers.
