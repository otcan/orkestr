export const PREVIEW_LIMIT=8*1024*1024;
export const TEXT_PREVIEW_LIMIT=1024*1024;
export const MEMORY_DOWNLOAD_LIMIT=16*1024*1024;
export function previewKind(type,size){
  if(!Number.isSafeInteger(size)||size<0||size>PREVIEW_LIMIT)return null;
  if(['image/png','image/jpeg','image/gif','image/webp','image/bmp'].includes(type))return 'image';
  if(type==='application/pdf')return 'pdf';
  if(['text/plain','text/csv','application/json'].includes(type)&&size<=TEXT_PREVIEW_LIMIT)return 'text';
  return null;
}
export function downloadType(type){return previewKind(type,0)?type:'application/octet-stream';}
