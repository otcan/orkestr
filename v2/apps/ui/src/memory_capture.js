// Capture metadata only; never a revision, consent, or scheduling authority.
export function memoryCaptureTime(clock = () => Date.now()) {
 const value = clock();
 if (!Number.isSafeInteger(value) || value <= 0 || value > 8640000000000000) {
  throw Error('Memory capture clock unavailable');
 }
 return value;
}
