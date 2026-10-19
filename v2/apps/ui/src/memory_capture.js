// Capture metadata only; never a revision, consent, or scheduling authority.
export function memoryCaptureTime(clock = () => Date.now()) {
 const value = clock();
 if (!Number.isSafeInteger(value) || value <= 0 || value > 253402300799999) {
  throw Error('Memory capture clock unavailable');
 }
 return value;
}
