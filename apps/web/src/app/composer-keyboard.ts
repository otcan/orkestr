export function shouldSubmitComposer(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode">, coarsePointer = false): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return false;
  // A phone's return key inserts a line break; Send or Ctrl/Cmd+Enter submits.
  return !coarsePointer || event.ctrlKey || event.metaKey;
}
