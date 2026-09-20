// Multer 2.3's GHSA-535w-7cp7-47q4 defense is opt-in. Our multipart
// contracts use scalar fields/JSON metadata and at most 20 files; keep small
// legacy bracket arrays compatible without permitting unbounded sparse arrays.
export const MULTIPART_FIELD_ARRAY_INDEX_LIMIT = 20;

export function multipartUploadLimits({ fileSize = 25 * 1024 * 1024, files = 20 } = {}) {
  return { fileSize, files, fieldArrayIndexLimit: MULTIPART_FIELD_ARRAY_INDEX_LIMIT };
}
