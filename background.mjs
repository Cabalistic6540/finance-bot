import {randomUUID,createHash} from 'node:crypto';
const SITE='https://tos-personal-finance.roundbuddy35.chatgpt.site';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function createFirestoreProcessingStore(db){
 const jobs=db.collection('financeReceiptProcessing_v1'),configRef=db.collection('financeWorkerConfig_v1').doc('site');
 const cache=new Map();let config=(await configRef.get()).data()||{};
 const unsubscribe=jobs.onSnapshot(snapshot=>{cache.clear();for(const doc of snapshot.docs)cache.set(doc.id,doc.data());},()=>{});
 return {
  async config(){return config;},async configure(value){await configRef.set(value);config=value;},
  get(id){return cache.get(id);},
  async claim(id){const ref=jobs.doc(id);const result=await db.runTransaction(async tx=>{const doc=await tx.get(ref),old=doc.data()||{};if(old.phase==='delivered'||old.nextAttempt>Date.now()||old.leaseUntil>Date.now())return null;const next={...old,id,phase:'processing',leaseId:randomUUID(),leaseUntil:Date.now()+180000};tx.set(ref,next);return next;});if(result)cache.set(id,result);return result;},
  async update(job,changes){const ref=jobs.doc(job.id);const result=await db.runTransaction(async tx=>{const doc=await tx.get(ref),old=doc.data();if(!old||old.leaseId!==job.leaseId)return null;const next={...old,...changes};tx.set(ref,next);return next;});if(result)cache.set(job.id,result);return result;},
  async close(){unsubscribe();},
 };
}
export async function recognizeImage(image){
 const [{createWorker},{default:sharp},{fileURLToPath}]=await Promise.all([import('tesseract.js'),import('sharp'),import('node:url')]);
 sharp.cache(false);
 const normalized=await sharp(image,{limitInputPixels:40000000}).rotate().resize({width:1800,height:3000,fit:'inside',withoutEnlargement:true}).png().toBuffer();
 let worker,timedOut=false;
 const work=(async()=>{worker=await createWorker(['tha','eng'],1,{langPath:fileURLToPath(new URL('./ocr-models/',import.meta.url)),cacheMethod:'none'});if(timedOut){await worker.terminate();throw Error('OCR timed out');}const {data}=await worker.recognize(normalized);return {status:'ready',text:data.text.slice(0,20000),confidence:data.confidence};})();
 let timer;
 try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;worker?.terminate().catch(()=>{});reject(Error('OCR timed out'));},90000);})]);}
 finally{clearTimeout(timer);await worker?.terminate().catch(()=>{});}
}
export function createBackgroundProcessor(config,receiptStore,processingStore,{fetcher=fetch,recognize=recognizeImage}={}){
 let running=null;let lastSuccess=null;
 const siteRequest=async(settings,path,body)=>{
  const r=await fetcher(`${SITE}${path}`,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.syncToken}`,'OAI-Sites-Authorization':`Bearer ${settings.siteAccessToken}`},body:body?JSON.stringify(body):undefined});
  if(!r.ok)throw Error('Private Site delivery failed');return r.json();
 };
 return {
  async configure(input){if(input?.enabled!==true||typeof input.siteAccessToken!=='string'||input.siteAccessToken.length<32||input.siteAccessToken.length>12000||/[\r\n]/.test(input.siteAccessToken))throw Error('Invalid private Site configuration');const settings={enabled:true,siteAccessToken:input.siteAccessToken};await siteRequest(settings,'/api/state');await processingStore.configure(settings);return {enabled:true};},
  async status(){const settings=await processingStore.config(),records=(await receiptStore.list()).filter(r=>r.status==='ready'),jobs=records.map(r=>processingStore.get(r.id));return {enabled:settings.enabled===true,lastSuccess:lastSuccess||jobs.map(j=>j?.deliveredAt).filter(Boolean).sort().at(-1)||null,queuedCount:jobs.filter(j=>j?.phase!=='delivered').length,deliveredCount:jobs.filter(j=>j?.phase==='delivered').length};},
  drain(){if(running)return running;running=(async()=>{
   const settings=await processingStore.config();if(!settings.enabled)return;
   for(const record of await receiptStore.list()){
    if(record.status!=='ready')continue;const old=processingStore.get(record.id);if(old?.phase==='delivered'||old?.leaseUntil>Date.now()||old?.nextAttempt>Date.now())continue;
    let job=await processingStore.claim(record.id);if(!job)continue;
    try{
     let analysis=job.analysis;
     if(!analysis){
      try{const image=await receiptStore.image(record);analysis={...await recognize(image),fileHash:hash(image)};}
      catch{if((job.attempts||0)<2)throw Error('OCR retry');analysis={status:'error',text:'',confidence:0,fileHash:record.sha256||'',error:'อ่านรูปไม่สำเร็จ กรุณาตรวจรูปด้วยตนเอง'};}
      job=await processingStore.update(job,{analysis});if(!job)continue;
     }
     const result=await siteRequest(settings,'/api/receipt-event',{id:record.id,profileKey:record.profileKey||'ct',receivedAt:record.receivedAt,mimeType:record.mimeType,...analysis});
     await processingStore.update(job,{phase:'delivered',leaseUntil:0,leaseId:null,deliveredAt:new Date().toISOString(),result:{status:String(result.status||'received')}});lastSuccess=new Date().toISOString();
    }catch{await processingStore.update(job,{phase:'retry',leaseId:null,leaseUntil:0,attempts:(job.attempts||0)+1,nextAttempt:Date.now()+Math.min(600000,30000*2**Math.min(job.attempts||0,4)),lastError:'OCR or private Site delivery needs retry'});}
   }
  })().finally(()=>{running=null;});return running;},
  close:()=>processingStore.close(),
 };
}
