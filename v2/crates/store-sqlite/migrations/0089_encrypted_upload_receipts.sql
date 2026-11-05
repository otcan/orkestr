-- Receipt/status queries must not traverse ciphertext overflow pages for the
-- trailing digest. All requested metadata is available in this bounded index.
CREATE INDEX encrypted_upload_receipt_cover ON encrypted_upload_chunks
 (upload_id,chunk_index,length(ciphertext),ciphertext_sha256);
