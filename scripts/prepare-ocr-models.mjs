import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const models={eng:'ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468',tha:'578c50034028340f2558fafb55207347943a60f4f1a854e5326ac272c764f7c3'};
const root=new URL('../ocr-models/',import.meta.url);await fs.mkdir(root,{recursive:true});
for(const[language,hash]of Object.entries(models)){
 const file=new URL(`${language}.traineddata.gz`,root);let content;
 try{content=await fs.readFile(file);}catch{/* Download models, never user images. */}
 if(content&&createHash('sha256').update(content).digest('hex')===hash)continue;
 const r=await fetch(`https://tessdata.projectnaptha.com/4.0.0/${language}.traineddata.gz`,{signal:AbortSignal.timeout(120000)});
 if(!r.ok)throw Error('OCR model download failed');content=Buffer.from(await r.arrayBuffer());
 if(createHash('sha256').update(content).digest('hex')!==hash)throw Error('OCR model integrity check failed');
 await fs.writeFile(file,content);
}
console.log('Thai and English OCR models ready.');
