export const PREVIEW_LIMIT=8*1024*1024;
export const TEXT_PREVIEW_LIMIT=1024*1024;
export const MEMORY_DOWNLOAD_LIMIT=16*1024*1024;
export function previewKind(type,size){
  if(!Number.isSafeInteger(size)||size<0||size>PREVIEW_LIMIT)return null;
  if(['image/png','image/jpeg','image/gif','image/webp','image/bmp'].includes(type))return 'image';
  if(['text/plain','text/csv','application/json'].includes(type)&&size<=TEXT_PREVIEW_LIMIT)return 'text';
  return null;
}
// PDFs are download-only (a fully sandboxed frame cannot run a browser PDF viewer),
// but keep their own type for the saved file. Active types stay octet-stream.
const DOWNLOAD_TYPES=['image/png','image/jpeg','image/gif','image/webp','image/bmp','application/pdf','text/plain','text/csv','application/json'];
export function downloadType(type){return DOWNLOAD_TYPES.includes(type)?type:'application/octet-stream';}
